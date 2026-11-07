import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile,writeFile,rename,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyFeed} from './verify-feed.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_REPORT=2*1024*1024,MAX_EXPANDED=8*1024*1024,MAX_PACK=2*1024*1024;
async function atomic(file,bytes){await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);}

// Only packages existing public reports. No GitHub discovery or model calls.
export async function buildHistory(output,{now=new Date().toISOString(),maxExpanded=MAX_EXPANDED,maxPack=MAX_PACK}={}) {
 const root=join(output,'history'),packRoot=join(root,'packs');await mkdir(packRoot,{recursive:true});
 const names=(await readdir(join(output,'daily'))).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
 if(names.length>10000)throw new Error('History index exceeds the 10000-report budget');
 const months=new Map();
 for(const name of names) {
  const content=await readFile(join(output,'daily',name),'utf8'),bytes=Buffer.byteLength(content),feed=JSON.parse(content);
  if(bytes>MAX_REPORT)throw new Error('History report exceeds size budget');
  const day=name.slice(0,10);
  if(!Number.isFinite(Date.parse(feed.generated_at))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||new Date(Date.parse(feed.generated_at)+8*3600000).toISOString().slice(0,10)!==day)throw new Error('History report date mismatch');
  if(['github_reported_daily_new_stars'].includes(feed.metric))verifyFeed(feed);
  else if(feed.metric!=='net_star_change_between_observed_snapshots'||!Array.isArray(feed.daily)||!Array.isArray(feed.rising))throw new Error('Unsupported history report');
  const month=day.slice(0,7);if(!months.has(month))months.set(month,[]);
  months.get(month).push({day,sha256:hash(content),content});
 }
 const packs=[],reports=[];
 for(const [month,items]of months) {
  let part=0;
  const emit=async group=>{
   const plain=Buffer.from(JSON.stringify({schema:1,reports:group}));const gzip=gzipSync(plain,{level:9});
   if(plain.length>maxExpanded||gzip.length>maxPack) {
    if(group.length===1)throw new Error('Single report cannot fit a history package');
    const half=Math.ceil(group.length/2);await emit(group.slice(0,half));await emit(group.slice(half));return;
   }
   const sha256=hash(gzip),file=`${month}-${String(++part).padStart(3,'0')}-${sha256}.json.gz`;
   await atomic(join(packRoot,file),gzip);
   packs.push({file,sha256,bytes:gzip.length,expanded_bytes:plain.length,days:group.map(r=>r.day)});
   for(const row of group)reports.push({day:row.day,sha256:row.sha256,pack:file});
  };
  await emit(items);
 }
 const revision=hash(JSON.stringify({reports,packs}));
 let previous=null;try{previous=JSON.parse(await readFile(join(root,'index.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(previous?.revision===revision)return previous;
 const index={schema:1,published_at:now,revision,reports,packs};
 const bytes=Buffer.from(JSON.stringify(index,null,2)+'\n');if(bytes.length>MAX_REPORT)throw new Error('History index exceeds size budget');
 // Publish the index last; immutable old packages remain valid during CDN rollout.
 await atomic(join(root,'index.json'),bytes);return index;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const index=await buildHistory(resolve(process.argv[2]??'data'));
 console.log(JSON.stringify({reports:index.reports.length,packs:index.packs.length,revision:index.revision}));
}
