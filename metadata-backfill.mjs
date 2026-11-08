import {readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {client} from './dynamic.mjs';
import {skillEvidence} from './metadata.mjs';
import {releaseEvidence} from './collector.mjs';
import {verifyFeed} from './verify-feed.mjs';

export async function repairMetadata(output,{api=client(process.env.GITHUB_TOKEN),now=new Date().toISOString()}={}) {
 const file=join(output,'rankings.json'),feed=JSON.parse(await readFile(file,'utf8'));
 verifyFeed(feed);
 const rows=new Map([...feed.daily,...feed.rising].map(row=>[row.name,row]));
 const targets=new Map(feed.failures.filter(f=>rows.has(f.name)&&(
  ['skill_presence','release_date'].includes(f.stage)||
  (f.stage==='readme_summary'&&/^HTTP 404$/.test(f.error))
 )).map(f=>[`${f.name}:${f.stage}`,f]));
 const repaired=[],failed=[],unknown=[];
 const cacheFile=join(output,'discovery-cache.json');
 const cache=JSON.parse(await readFile(cacheFile,'utf8'));
 if(cache.schema!==1||!cache.entries||typeof cache.entries!=='object'||Array.isArray(cache.entries))throw new Error('Damaged discovery cache');
 for(const [key,target]of targets) {
  const row=rows.get(target.name);
  try {
   if(target.stage==='skill_presence') {
    const result=await skillEvidence(row.name,row.default_branch,async(path,options)=>(await api.request(path,options)).data,now);
    Object.assign(row,{skill_paths:result.paths,skill_evidence:result.evidence,repository_type:result.paths.length?'skill':'project'});
    if(result.paths.length)row.skill_verified_at=now;else delete row.skill_verified_at;
   } else if(target.stage==='readme_summary') {
    // Clear only after the repository still exists, is confirmed still without a README,
    // and the description-based summary basis is present; a repository that gained a README
    // keeps its failure for the next full collection to read normally.
    let repoItem;
    try{repoItem=(await api.request(`/repos/${row.name}`)).data;}
    catch(error){
     if(/^HTTP 404$/.test(error.message))throw new Error('Repository missing, renamed or private; keep failure for the next collection');
     throw new Error('Repository check failed: '+error.message);
    }
    if(repoItem.full_name?.toLowerCase()!==row.name.toLowerCase()||repoItem.private===true)throw new Error('Repository missing, renamed or private; keep failure for the next collection');
    try{await api.request(`/repos/${row.name}/readme`);throw new Error('README is now readable; next collection will read it');}
    catch(error){if(!/^HTTP 404$/.test(error.message))throw error;}
    if(!String(row.description??'').trim())throw new Error('Repository description empty; summary basis unconfirmed');
   } else {
    const evidence=await releaseEvidence(row.name,async path=>(await api.request(path)).data,undefined,now);
    if(!evidence.complete)unknown.push({name:row.name,stage:target.stage,reason:'Release history exceeds the 300-record verification budget; earliest release remains unknown'});
    row.launch_evidence=evidence;
    const entry=cache.entries[row.name.toLowerCase()]??={used_at:now};entry.launch_evidence=evidence;
   }
   repaired.push(key);
  } catch(error){failed.push({name:row.name,stage:target.stage,error:error.message});}
 }
 if(!repaired.length)return {repaired,failed,unknown,written:false};
 const fixed=new Set(repaired);
 feed.failures=feed.failures.filter(f=>!fixed.has(`${f.name}:${f.stage}`));
 for(const row of [...feed.daily,...feed.rising]) {
  const source=rows.get(row.name);
  if(row===source)continue;
  for(const key of ['skill_paths','skill_evidence','repository_type','skill_verified_at','launch_evidence']){delete row[key];if(source[key]!==undefined)row[key]=source[key];}
 }
 verifyFeed(feed);
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(feed.generated_at));
 const dailyFile=join(output,'daily',day+'.json');
 const daily=JSON.parse(await readFile(dailyFile,'utf8'));
 if(daily.generated_at!==feed.generated_at)throw new Error('Daily archive belongs to a different batch; nothing written');
 for(const [target,data]of [[file,feed],[dailyFile,feed],[cacheFile,cache]]){await writeFile(target+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(target+'.tmp',target);}
 return {repaired,failed,unknown,written:true,requests:api.stats?.()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const result=await repairMetadata(resolve(process.argv[2]??'data'));console.log(JSON.stringify(result));
 // Partial successful repairs may be committed; unresolved checks remain visible.
 if(result.failed.length&&!result.written)process.exitCode=1;
}
