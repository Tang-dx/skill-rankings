import {readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {summarizeRanked,configuredSummaryGenerator} from './summary-model.mjs';

export async function enrichRecentReport(output,token=process.env.GITHUB_TOKEN,{generate,readme,repairLatest=false}={}) {
 const latest=JSON.parse(await readFile(join(output,'rankings.json'),'utf8'));
 if(latest.daily.length||latest.rising.length) {
  if(!repairLatest||![...latest.daily,...latest.rising].some(row=>!row.summary_zh))return;
 }
 let file=join(output,'rankings.json'),feed=latest;
 if(!feed.daily.length&&!feed.rising.length) {
  const days=(await readdir(join(output,'daily'))).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse().slice(0,7);
  for(const day of days) {
   const candidate=JSON.parse(await readFile(join(output,'daily',day),'utf8'));
   if(candidate.daily.length||candidate.rising.length){file=join(output,'daily',day);feed=candidate;break;}
  }
 }
 if(!feed.daily.length&&!feed.rising.length)return;
 const cache=JSON.parse(await readFile(join(output,'summary-cache.json'),'utf8'));
 const names=new Set([...feed.daily,...feed.rising].map(r=>r.name));
 feed.failures=feed.failures.filter(f=>!(names.has(f.name)&&f.stage==='chinese_summary'));
 await summarizeRanked({feed,cache,model:process.env.SUMMARY_MODEL??'gpt-6.1-sol',generate:generate??configuredSummaryGenerator(token),readme:readme??(async name=>{
  const response=await fetch(`https://api.github.com/repos/${name}/readme`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`README HTTP ${response.status}`);
  const doc=await response.json();
  if(doc.encoding!=='base64'||typeof doc.content!=='string'||typeof doc.sha!=='string')throw new Error('Invalid README');
  return {text:Buffer.from(doc.content,'base64').toString('utf8'),sha:doc.sha,url:doc.html_url};
 })});
 const summaryFailures=feed.failures.filter(f=>f.stage==='chinese_summary');
 if(summaryFailures.length)throw new Error(`Archived summaries incomplete; preserve prior archive: ${[...new Set(summaryFailures.map(f=>f.error))].join('; ').slice(0,600)}`);
 for(const [target,data] of [[file,feed],[join(output,'summary-cache.json'),cache]]) {
  await writeFile(target+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(target+'.tmp',target);
 }
 if(file===join(output,'rankings.json')) {
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(feed.generated_at));
  const daily=join(output,'daily',date+'.json');
  let existing=null;
  try {existing=JSON.parse(await readFile(daily,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!existing||existing.generated_at===feed.generated_at) {
   await writeFile(daily+'.tmp',JSON.stringify(feed,null,2)+'\n');await rename(daily+'.tmp',daily);
  }
 }
 console.log(JSON.stringify({summary_report:feed.generated_at,projects:names.size,failures:feed.failures.filter(f=>f.stage==='chinese_summary')}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await enrichRecentReport(resolve(process.argv[2]??'data'),process.env.GITHUB_TOKEN,{repairLatest:process.argv.includes('--repair-latest')});
