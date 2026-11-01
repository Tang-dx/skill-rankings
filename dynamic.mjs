import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveFeed, releaseEvidence } from './collector.mjs';

const DAY=86400000;
const validName=name=>typeof name==='string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(name) && !name.endsWith('/..');
export const metric='github_reported_daily_new_stars';
// Official aggregate endpoint; stargazer identities are restricted since July 2026.
// Bucket boundaries belong to GitHub and are not promised to be Beijing/UTC days.
export function dailyHistory(data,now) {
 if(!Array.isArray(data)||!data.length)throw new Error('Missing GitHub daily star history');
 const weeks=new Set();
 for(const row of data) {
  if(!Number.isSafeInteger(row.week)||row.week<0||weeks.has(row.week)||!Array.isArray(row.days)||row.days.length!==7||row.days.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(row.total)||row.total!==row.days.reduce((a,b)=>a+b,0))throw new Error('Invalid GitHub daily star history');
  weeks.add(row.week);
 }
 const at=Date.parse(now);
 const matches=data.filter(row=>row.week*1000<=at&&at<row.week*1000+7*DAY);
 if(matches.length!==1)throw new Error('Current GitHub statistics week unavailable');
 const week=matches[0],index=Math.floor((at-week.week*1000)/DAY);
 const start=week.week*1000+index*DAY;
 return {count:week.days[index],window_start:new Date(start).toISOString(),window_end:new Date(start+DAY).toISOString(),consistency:'github_daily_history',source_week:week.week,source_day_index:index};
}
export function parseTrending(html) {
 return [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].flatMap(match=>{
  const heading=match[0].match(/<h2\b[^>]*>[\s\S]*?<\/h2>/)?.[0];
  const name=heading?.match(/href="\/([^"?#]+)"/)?.[1];
  return validName(name)?[name]:[];
 });
}
export function interleave(groups,limit=24) {
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
 const daily=[...positive].sort(stable).slice(0,10);
 const rising=positive.filter(r=>{const age=(Date.parse(now)-Date.parse(r.created_at))/DAY;return age>=0&&age<=183&&r.stars<10000&&r.new_stars_day>=30;})
  .sort((a,b)=>b.rising_score-a.rising_score||stable(a,b)).slice(0,10);
 return {daily,rising};
}

async function atomic(file,value) {const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n','utf8');await rename(temp,file);}
async function readJson(file,fallback) {try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function client(token) {
 const began=Date.now();let requests=0;
 async function fetchLimited(url,headers={}) {
  if(Date.now()-began>235000||requests>=300)throw new Error('Collection request/time budget reached');
  requests++;
  const response=await fetch(url,{headers:{'User-Agent':'DevCockpit-Skill-Rankings',...headers},redirect:'error',signal:AbortSignal.timeout(Math.min(10000,240000-(Date.now()-began)))});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  let bytes=0,text='';const decoder=new TextDecoder();
  for await(const chunk of response.body) {bytes+=chunk.length;if(bytes>4*1024*1024)throw new Error('Response exceeds size budget');text+=decoder.decode(chunk,{stream:true});}
  text+=decoder.decode();
  return {text,link:response.headers.get('link')??''};
 }
 const request=async(path)=>{
  if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid API path');
  const result=await fetchLimited('https://api.github.com'+path,{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(token?{Authorization:`Bearer ${token}`}:{})});
  return {...result,data:JSON.parse(result.text)};
 };
 return {request,fetchLimited,stats:()=>({requests,elapsed_ms:Date.now()-began})};
}

export async function collectDynamic({output,token=process.env.GITHUB_TOKEN,transport,observedAt}={}) {
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
  try {const group=parseTrending((await api.fetchLimited(path)).text);if(!group.length)throw new Error('Trending returned no parseable repositories');groups.push(group);sources.push({source:path,candidates:group.length});}
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
   const group=result.items.map(r=>r.full_name).filter(validName);groups.push(group);sources.push({source:`GitHub search: ${q} (${sort})`,candidates:group.length});
  }catch(e){failures.push({stage:'discovery',error:e.message});}
 }
 const candidates=interleave(groups,24),candidateCount=new Set(groups.flat().map(n=>n.toLowerCase())).size;
 if(!candidates.length)throw new Error('No dynamic candidates; previous feed preserved');
 const rows=[],unranked=[];let cursor=0,evaluated=0;
 async function worker() {
  while(cursor<candidates.length) {
   const name=candidates[cursor++];
   let row;
   try {
    const item=(await api.request(`/repos/${name}`)).data;evaluated++;
    if(item.private!==false||item.archived||item.full_name?.toLowerCase()!==name.toLowerCase()||!Number.isSafeInteger(item.stargazers_count)||item.stargazers_count<0)throw new Error('Repository not eligible or identity invalid');
    const canonical=item.full_name,entry=state.entries[canonical.toLowerCase()]??{};entry.used_at=now;state.entries[canonical.toLowerCase()]=entry;
    row={name:canonical,url:`https://github.com/${canonical}`,description:item.description??'',created_at:item.created_at,
     stars:item.stargazers_count,net_stars:null,new_stars_day:null,sampled_at:now,window_start:windowStart,window_end:now,
     skill_paths:[],repository_type:'project',launch_evidence:entry.launch_evidence??null,
     candidate_sources:groups.flatMap((g,i)=>g.some(n=>n.toLowerCase()===name.toLowerCase())?[sources[i].source]:[])};
    try {
     const tree=(await api.request(`/repos/${canonical}/git/trees/${encodeURIComponent(item.default_branch)}?recursive=1`)).data;
     row.skill_paths=(tree.tree??[]).filter(r=>r.type==='blob'&&/(^|\/)SKILL\.md$/.test(r.path)).map(r=>r.path);
     if(row.skill_paths.length){row.repository_type='skill';row.skill_verified_at=now;}
    }catch(e){failures.push({name:canonical,stage:'skill_presence',error:e.message});}
    const observation=dailyHistory((await api.request(`/repos/${canonical}/stargazers/history?per_page=2`)).data,now);
    Object.assign(row,{new_stars_day:observation.count,window_start:observation.window_start,window_end:observation.window_end,source_week:observation.source_week,source_day_index:observation.source_day_index,consistency:observation.consistency,collection_finished_at:new Date().toISOString()});
    rows.push(row);
   }catch(e){failures.push({name,stage:'count',error:e.message});if(row)unranked.push({...row,new_stars_day:null,reason:'observation_incomplete'});}
  }
 }
 await Promise.all(Array.from({length:3},()=>worker()));
 if(!rows.length)throw new Error('No comparable star observations; previous feed preserved: '+JSON.stringify(failures));
 const ranked=rankRows(rows,now);
 const displayed=new Map([...ranked.daily,...ranked.rising].map(row=>[row.name,row]));
 // Enrich only displayed results, reusing cached translations on an exact description match.
 for(const row of displayed.values()) {
  const entry=state.entries[row.name.toLowerCase()];
  if(row.description) {
   try {
    if(entry.description!==row.description||!entry.summary_zh) {
     const source=row.description.replace(/https?:\/\/\S+/g,'').slice(0,500);
     const translated=JSON.parse((await api.fetchLimited('https://translate.googleapis.com/translate_a/single?'+new URLSearchParams({client:'gtx',sl:'auto',tl:'zh-CN',dt:'t',q:source}))).text);
     const chinese=translated[0].map(part=>part[0]).join('').replace(/\s+/g,' ').trim();
     if(!/[\u4e00-\u9fff]/.test(chinese))throw new Error('No Chinese translation returned');
     entry.description=row.description;entry.summary_zh=[...chinese].slice(0,220).join('');
    }
    row.summary_zh=entry.summary_zh;row.summary_source='machine_translation_of_repository_description';
   }catch(e){failures.push({name:row.name,stage:'chinese_summary',error:e.message});}
  }
  if(!entry.launch_evidence?.checked_at || Date.parse(now)-Date.parse(entry.launch_evidence.checked_at)>30*DAY) {
   try{entry.launch_evidence=await releaseEvidence(row.name,async path=>(await api.request(path)).data,token,now);}
   catch(e){failures.push({name:row.name,stage:'release_date',error:e.message});}
  }
  row.launch_evidence=entry.launch_evidence??null;
 }
 // daily/rising contain separate row copies; copy display metadata back to both.
 for(const row of [...ranked.daily,...ranked.rising])Object.assign(row,displayed.get(row.name));
 const feed={schema:1,metric,generated_at:now,window_start:rows[0].window_start,window_end:rows[0].window_end,
  collection_finished_at:new Date().toISOString(),scope:'dynamic Trending and GitHub search candidates; not all GitHub',
  monitored_repositories:evaluated,coverage:{discovered:candidateCount,evaluated,counted:rows.length,selected:candidates.length,sources,...api.stats()},
  policy:{top:10,rising_maximum_age_days:183,rising_maximum_current_stars:10000,rising_minimum_new_stars:30,denominator_floor:100},
  ...ranked,unranked,failures};
 state.entries=Object.fromEntries(Object.entries(state.entries).filter(([,v])=>Date.parse(now)-Date.parse(v.used_at)<35*DAY).sort((a,b)=>Date.parse(b[1].used_at)-Date.parse(a[1].used_at)).slice(0,200));
 await atomic(join(output,'discovery-cache.json'),state);
 await archiveFeed(output,feed);await atomic(join(output,'rankings.json'),feed);
 return feed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const i=process.argv.indexOf('--output');
 const feed=await collectDynamic({output:resolve(i<0?'data':process.argv[i+1])});
 console.log(JSON.stringify({generated_at:feed.generated_at,coverage:feed.coverage,daily:feed.daily.map(r=>({name:r.name,new:r.new_stars_day})),rising:feed.rising.map(r=>({name:r.name,new:r.new_stars_day})),failures:feed.failures}));
}
