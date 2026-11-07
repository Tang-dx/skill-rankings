import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveFeed, releaseEvidence } from './collector.mjs';
import { summarizeRanked, configuredSummaryGenerator } from './summary-model.mjs';
import { skillEvidence } from './metadata.mjs';

const DAY=86400000;
const validName=name=>typeof name==='string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(name) && !name.endsWith('/..');
export const metric='github_reported_daily_new_stars';
export function normalizeChineseTerms(summary,description) {
 // Disambiguate only when the corresponding technical term exists in the source.
 if(/\bLLMs?\b/i.test(description))summary=summary.replace(/法学硕士/g,'大语言模型');
 if(/agent harness control surface/i.test(description))summary=summary.replace(/代理线束控制界面/g,'AI 编程代理管理界面');
 if(/\bagents?\b/i.test(description))summary=summary.replace(/座席/g,'智能体');
 return summary;
}
// Official aggregate endpoint; stargazer identities are restricted since July 2026.
// Bucket boundaries belong to GitHub and are not promised to be UTC or Beijing days.
// Values reflect stars created on that date and still present; unstars may retroactively reduce counts.
export function dailyHistory(data,now) {
 if(!Array.isArray(data)||!data.length||data.length>2)throw new Error('Missing or oversized GitHub daily star history');
 const weeks=new Set();
 for(const row of data) {
  if(!Number.isSafeInteger(row.week)||row.week<0||weeks.has(row.week)||!Array.isArray(row.days)||row.days.length!==7||row.days.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(row.total)||row.total!==row.days.reduce((a,b)=>a+b,0))throw new Error('Invalid GitHub daily star history');
  weeks.add(row.week);
 }
 const at=Date.parse(now);
 const matches=data.filter(row=>row.week*1000<=at&&at<row.week*1000+7*DAY);
 if(matches.length!==1)throw new Error('Current GitHub statistics week unavailable');
 const week=matches[0],index=Math.floor((at-week.week*1000)/DAY);
 // Use the most recent completed source day, not the current accumulating day.
 let prevWeek,prevIndex,start;
 if(index>0) {prevWeek=week;prevIndex=index-1;start=week.week*1000+prevIndex*DAY;}
 else {
  // Today is the first day of the source week; find the previous week by timestamp, not array position.
  const prevWeeks=data.filter(row=>row.week===week.week-7*DAY/1000);
  if(!prevWeeks.length)throw new Error('Previous source week unavailable for completed day');
  prevWeek=prevWeeks.reduce((a,b)=>a.week>b.week?a:b);prevIndex=6;start=prevWeek.week*1000+prevIndex*DAY;
 }
 return {count:prevWeek.days[prevIndex],window_start:new Date(start).toISOString(),window_end:new Date(start+DAY).toISOString(),consistency:'github_daily_history_previous_completed_day',source_week:prevWeek.week,source_day_index:prevIndex};
}
export function parseTrending(html) {
 return [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].flatMap(match=>{
  const heading=match[0].match(/<h2\b[^>]*>[\s\S]*?<\/h2>/)?.[0];
  const name=heading?.match(/href="\/([^"?#]+)"/)?.[1];
  return validName(name)?[name]:[];
 });
}
export function interleave(groups,limit=1000) {
 const result=[],seen=new Set();
 for(let i=0;i<Math.max(0,...groups.map(g=>g.length));i++) for(const group of groups) {
  const name=group[i];
  if(validName(name) && !seen.has(name.toLowerCase())) {seen.add(name.toLowerCase());result.push(name);if(result.length>=limit)return result;}
 }
 return result;
}

export function rankRows(rows,now) {
 const stable=(a,b)=>b.new_stars_day-a.new_stars_day||a.name.localeCompare(b.name);
 const positive=rows.filter(r=>r.new_stars_day>0).map(row=>({...row,
  recent_share_percent:row.stars>0?row.new_stars_day/row.stars*100:null,
  rising_score:row.new_stars_day/Math.max(row.stars,100)}));
 const daily=[...positive].sort(stable).slice(0,15);
 const rising=positive.filter(r=>{const age=(Date.parse(now)-Date.parse(r.created_at))/DAY;return age>=0&&age<=183&&r.stars<10000&&r.new_stars_day>=30;})
  .sort((a,b)=>b.rising_score-a.rising_score||stable(a,b)).slice(0,15);
 return {daily,rising};
}

async function atomic(file,value) {const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n','utf8');await rename(temp,file);}
async function readJson(file,fallback) {try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function client(token) {
 const began=Date.now();let requests=0;
 async function fetchLimited(url,headers={},maxBytes=4*1024*1024) {
  if(Date.now()-began>235000||requests>=600)throw new Error('Collection request/time budget reached');
  requests++;
  const response=await fetch(url,{headers:{'User-Agent':'DevCockpit-Skill-Rankings',...headers},redirect:'error',signal:AbortSignal.timeout(Math.min(10000,240000-(Date.now()-began)))});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  let bytes=0,text='';const decoder=new TextDecoder();
  for await(const chunk of response.body) {bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Response exceeds size budget');text+=decoder.decode(chunk,{stream:true});}
  text+=decoder.decode();
  return {text,link:response.headers.get('link')??''};
 }
 const request=async(path,{maxBytes=4*1024*1024}={})=>{
  if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid API path');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||(maxBytes>4*1024*1024&&!/^\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(path)))throw new Error('Invalid response size budget');
  const result=await fetchLimited('https://api.github.com'+path,{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(token?{Authorization:`Bearer ${token}`}:{})},maxBytes);
  try {
   return {...result,data:JSON.parse(result.text)};
  } catch (error) {
   throw new Error(`Invalid JSON from GitHub ${path}: ${error.message}`);
  }
 };
 return {request,fetchLimited,stats:()=>({requests,elapsed_ms:Date.now()-began})};
}

export async function collectDynamic({output,token=process.env.GITHUB_TOKEN,transport,observedAt,summaryGenerator}={}) {
 await mkdir(output,{recursive:true});
 const now=observedAt??new Date().toISOString(),windowStart=new Date(Date.parse(now)-DAY).toISOString();
 const api=transport??client(token),failures=[],groups=[],sources=[];
 const state=await readJson(join(output,'discovery-cache.json'),{schema:1,entries:{}});
 if(state.schema!==1||!state.entries||typeof state.entries!=='object'||Array.isArray(state.entries))throw new Error('Damaged discovery cache');
 const legacy=await readJson(join(output,'state.json'),{repositories:[]});
 // Historical records can supply display metadata, never candidate membership.
 if(!state.migrated_from_legacy) {
  for(const old of legacy.repositories??[]) if(validName(old.name)&&!state.entries[old.name.toLowerCase()])state.entries[old.name.toLowerCase()]={launch_evidence:old.launch_evidence,used_at:old.launch_evidence?.checked_at??'1970-01-01T00:00:00Z'};
  state.migrated_from_legacy=true;
 }
 for(const path of ['https://github.com/trending?since=daily','https://github.com/trending/typescript?since=daily']) {
  try {const group=parseTrending((await api.fetchLimited(path)).text);if(!group.length)throw new Error('Trending returned no parseable repositories');groups.push(group);sources.push({source:path,candidates:group.length,names:group});}
  catch(e){failures.push({stage:'discovery',source:path,error:e.message});}
 }
 const cutoff=new Date(Date.parse(now)-183*DAY).toISOString().slice(0,10),fresh=new Date(Date.parse(now)-30*DAY).toISOString().slice(0,10);
 const queries=[['topic:agent-skills stars:>=30 archived:false','updated'],
  [`skills in:name,description created:>=${cutoff} stars:30..9999 archived:false`,'stars'],
  [`topic:ai-agents created:>=${fresh} stars:>=30 archived:false`,'stars'],
  [`skill in:name,description created:>=${fresh} stars:>=30 archived:false`,'updated']];
 for(const [q,sort] of queries) {
  try {const result=(await api.request('/search/repositories?'+new URLSearchParams({q,sort,order:'desc',per_page:'30'}))).data;
   if(!Array.isArray(result.items))throw new Error('Invalid discovery response');
   if(result.incomplete_results)failures.push({stage:'discovery',error:'GitHub reported incomplete search results'});
   const group=result.items.map(r=>r.full_name).filter(validName);groups.push(group);sources.push({source:`GitHub search: ${q} (${sort})`,candidates:group.length,names:group});
  }catch(e){failures.push({stage:'discovery',error:e.message});}
 }
 const candidates=interleave(groups),candidateCount=new Set(groups.flat().map(n=>n.toLowerCase())).size;
 if(failures.some(f=>f.stage==='discovery'))throw new Error('Incomplete discovery; previous feed preserved: '+JSON.stringify(failures));
 if(candidates.length!==candidateCount || candidates.length>200)throw new Error('Discovery exceeds bounded complete collection; previous feed preserved');
 if(!candidates.length)throw new Error('No dynamic candidates; previous feed preserved');
 const rows=[],unranked=[],excluded=[];let cursor=0,evaluated=0;
 async function worker() {
  while(cursor<candidates.length) {
   const name=candidates[cursor++];
   let row;
   try {
    const item=(await api.request(`/repos/${name}`)).data;evaluated++;
    if(item.full_name?.toLowerCase()!==name.toLowerCase()||!Number.isSafeInteger(item.stargazers_count)||item.stargazers_count<0||typeof item.private!=='boolean')throw new Error('Repository identity invalid');
    if(item.private||item.archived){excluded.push({name,reason:item.private?'private':'archived'});continue;}
    const canonical=item.full_name,entry=state.entries[canonical.toLowerCase()]??{};entry.used_at=now;state.entries[canonical.toLowerCase()]=entry;
    row={name:canonical,url:`https://github.com/${canonical}`,description:item.description??'',created_at:item.created_at,
     stars:item.stargazers_count,net_stars:null,new_stars_day:null,sampled_at:now,window_start:windowStart,window_end:now,default_branch:item.default_branch,
     skill_paths:[],repository_type:'project',launch_evidence:entry.launch_evidence??null,
     candidate_sources:groups.flatMap((g,i)=>g.some(n=>n.toLowerCase()===name.toLowerCase())?[sources[i].source]:[])};
    const history=(await api.request(`/repos/${canonical}/stargazers/history?per_page=2`)).data;
    const requestedAt=new Date().toISOString(),observation=dailyHistory(history,now);
    Object.assign(row,{new_stars_day:observation.count,window_start:observation.window_start,window_end:observation.window_end,source_week:observation.source_week,source_day_index:observation.source_day_index,consistency:observation.consistency,collection_finished_at:requestedAt,
     star_evidence:{url:`https://api.github.com/repos/${canonical}/stargazers/history?per_page=2`,requested_at:requestedAt,history}});
    rows.push(row);
   }catch(e){failures.push({name,stage:'count',error:e.message});if(row)unranked.push({...row,new_stars_day:null,reason:'observation_incomplete'});}
  }
 }
 await Promise.all(Array.from({length:3},()=>worker()));
 if(failures.some(f=>f.stage==='count'))throw new Error('Incomplete candidate counts; previous feed preserved: '+JSON.stringify(failures));
 if(!rows.length)throw new Error('No comparable star observations; previous feed preserved: '+JSON.stringify(failures));
 const ranked=rankRows(rows,now);
 const displayed=new Map([...ranked.daily,...ranked.rising].map(row=>[row.name,row]));
 const readmes=new Map();
 // Read public project evidence only for the ranked union.
 for(const row of displayed.values()) {
  const entry=state.entries[row.name.toLowerCase()];
  try {
   const result=await skillEvidence(row.name,row.default_branch,async(path,options)=>(await api.request(path,options)).data,now);
   row.skill_paths=result.paths;row.skill_evidence=result.evidence;
   if(row.skill_paths.length){row.repository_type='skill';row.skill_verified_at=now;}
  }catch(e){failures.push({name:row.name,stage:'skill_presence',error:e.message});}
  try {
    const doc=(await api.request(`/repos/${row.name}/readme`)).data;
    if(doc.encoding!=='base64'||typeof doc.content!=='string'||typeof doc.sha!=='string')throw new Error('Invalid README response');
    const markdown=Buffer.from(doc.content,'base64').toString('utf8');
    const url=typeof doc.html_url==='string'&&doc.html_url.startsWith(`https://github.com/${row.name}/blob/`)?doc.html_url:`https://github.com/${row.name}/blob/${row.default_branch}/README.md`;
    readmes.set(row.name,{text:markdown,sha:doc.sha,url});
    if(!row.description.trim()) {
    const prose=markdown.replace(/```[\s\S]*?```/g,'').replace(/<!--[\s\S]*?-->/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/<[^>]+>/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
     .split(/\r?\n\s*\r?\n/).map(s=>s.trim()).filter(s=>s.length>35&&!/^(#|\||>|\[|[-*]\s)/.test(s));
    if(!prose.length)throw new Error('README has no usable introductory paragraph');
    row.description=prose.slice(0,2).join(' ').replace(/\s+/g,' ').slice(0,800);
    row.description_source={kind:'readme',sha:doc.sha,url:typeof doc.html_url==='string'&&doc.html_url.startsWith(`https://github.com/${row.name}/blob/`)?doc.html_url:`https://github.com/${row.name}/blob/${row.default_branch}/README.md`};
    }
   }catch(e){failures.push({name:row.name,stage:'readme_summary',error:e.message});}
  if(!row.description_source)row.description_source={kind:'repository_description',url:row.url};
  if(!entry.launch_evidence?.checked_at || Date.parse(now)-Date.parse(entry.launch_evidence.checked_at)>30*DAY) {
   try{entry.launch_evidence=await releaseEvidence(row.name,async path=>(await api.request(path)).data,token,now);}
   catch(e){failures.push({name:row.name,stage:'release_date',error:e.message});}
  }
  row.launch_evidence=entry.launch_evidence??null;
 }
 // daily/rising contain separate row copies; copy display metadata back to both.
 for(const row of [...ranked.daily,...ranked.rising])Object.assign(row,displayed.get(row.name));
 const summaries=await readJson(join(output,'summary-cache.json'),{schema:1,entries:{}});
 if(summaries.schema!==1||!summaries.entries||typeof summaries.entries!=='object'||Array.isArray(summaries.entries))throw new Error('Damaged summary cache');
 await summarizeRanked({feed:{...ranked,failures},cache:summaries,now,
  readme:async name=>{const doc=readmes.get(name);if(!doc)throw new Error('README unavailable');return doc;},
  model:process.env.SUMMARY_MODEL??'gpt-6.1-sol',generate:summaryGenerator??configuredSummaryGenerator(token)});
 summaries.entries=Object.fromEntries(Object.entries(summaries.entries).sort((a,b)=>Date.parse(b[1].used_at??b[1].evidence.generated_at)-Date.parse(a[1].used_at??a[1].evidence.generated_at)).slice(0,500));
 if(rows.some(r=>r.window_start!==rows[0].window_start||r.window_end!==rows[0].window_end))throw new Error('Inconsistent source day windows; previous feed preserved');
 const feed={schema:1,collector_revision:3,metric,generated_at:now,window_start:rows[0].window_start,window_end:rows[0].window_end,
  collection_finished_at:new Date().toISOString(),scope:'dynamic Trending and GitHub search candidates; not all GitHub',
  monitored_repositories:evaluated,coverage:{discovered:candidateCount,evaluated,counted:rows.length,excluded:excluded.length,selected:candidates.length,sources,...api.stats()},excluded,
  policy:{top:15,rising_maximum_age_days:183,rising_maximum_current_stars:10000,rising_minimum_new_stars:30,denominator_floor:100},
  observations:rows.map(r=>({name:r.name,stars:r.stars,created_at:r.created_at,new_stars_day:r.new_stars_day,star_evidence:r.star_evidence,candidate_sources:r.candidate_sources})),
  ...ranked,unranked,failures};
 state.entries=Object.fromEntries(Object.entries(state.entries).filter(([,v])=>Date.parse(now)-Date.parse(v.used_at)<35*DAY).sort((a,b)=>Date.parse(b[1].used_at)-Date.parse(a[1].used_at)).slice(0,200));
 await atomic(join(output,'discovery-cache.json'),state);
 await atomic(join(output,'summary-cache.json'),summaries);
 await archiveFeed(output,feed);await atomic(join(output,'rankings.json'),feed);
 return feed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const i=process.argv.indexOf('--output');
 const feed=await collectDynamic({output:resolve(i<0?'data':process.argv[i+1])});
 console.log(JSON.stringify({generated_at:feed.generated_at,coverage:feed.coverage,daily:feed.daily.map(r=>({name:r.name,new:r.new_stars_day})),rising:feed.rising.map(r=>({name:r.name,new:r.new_stars_day})),failures:feed.failures}));
}
