import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDynamic } from './dynamic.mjs';
import { repairMetadata } from './metadata-backfill.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const end='2026-11-01T12:00:00Z';
const summaryGenerator=async items=>items.map(i=>({name:i.name,purpose:'帮助制作中文数据报告。',use_case:'适合整理和展示已有数据。'}));

const transport={
 stats:()=>({requests:20,elapsed_ms:100}),
 fetchLimited:async url=>({text:url.includes('translate.googleapis.com')?JSON.stringify([[['帮助制作中文数据报告。']]]):'<article><h2><a href="/fresh/new">n</a></h2></article>'}),
 request:async path=>{
  if(path.startsWith('/search/'))return {data:{items:[{full_name:'fresh/new'}]}};
  if(path.endsWith('/readme'))return {data:{encoding:'base64',content:Buffer.from('Control coding agents.\n\nDetailed install docs.').toString('base64'),sha:'abc123',html_url:'https://github.com/fresh/new/blob/main/README.md'}};
  if(path.includes('/git/trees/'))return {data:{tree:[],truncated:false,sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}};
  if(path.includes('/stargazers/history'))return {data:[{week:Date.parse('2026-10-25T00:00:00Z')/1000,total:40,days:[0,0,0,0,0,0,40]},{week:Date.parse('2026-11-01T00:00:00Z')/1000,total:0,days:[0,0,0,0,0,0,0]}]};
  if(path.includes('/releases?'))return {data:[]};
  return {data:{full_name:'fresh/new',private:false,stargazers_count:50,created_at:'2026-10-01T00:00:00Z',description:'Make data reports',default_branch:'main'}};
 }
};

async function feedWithFailure(output,error){
 const result=await collectDynamic({output,observedAt:end,transport,summaryGenerator});
 result.failures.push({name:'fresh/new',stage:'readme_summary',error});
 const payload=JSON.stringify(result,null,2)+'\n';
 await writeFile(join(output,'rankings.json'),payload);
 await writeFile(join(output,'daily','2026-11-01.json'),payload);
}

test('clears a structural no-README failure after rechecking the repository still has none',async()=>{
 const output=await mkdtemp(join(tmpdir(),'backfill-noreadme-'));
 try {
  await feedWithFailure(output,'HTTP 404');
  const requests=[];
  const api={request:async path=>{requests.push(path);
   if(path==='/repos/fresh/new')return {data:{full_name:'fresh/new',private:false}};
   if(path==='/repos/fresh/new/readme')throw new Error('HTTP 404');
   throw new Error('unexpected '+path);},stats:()=>({requests:requests.length,elapsed_ms:1})};
  const result=await repairMetadata(output,{api,now:'2026-11-02T00:00:00Z'});
  assert.deepEqual(result.repaired,['fresh/new:readme_summary']);
  assert.equal(result.failed.length,0);
  assert.equal(result.written,true);
  const feed=JSON.parse(await readFile(join(output,'rankings.json'),'utf8'));
  assert.equal(feed.failures.length,0);
  assert.equal(feed.daily[0].description_source.kind,'repository_description');
  assert.equal(feed.daily[0].summary_zh,'帮助制作中文数据报告。 适合整理和展示已有数据。');
  const daily=JSON.parse(await readFile(join(output,'daily','2026-11-01.json'),'utf8'));
  assert.equal(daily.failures.length,0);
 }finally{await rm(output,{recursive:true,force:true});}
});

test('keeps the failure when the repository is deleted, README becomes readable, or the recheck itself fails',async()=>{
 const output=await mkdtemp(join(tmpdir(),'backfill-noreadme-keep-'));
 try {
  await feedWithFailure(output,'HTTP 404');
  const deleted={request:async path=>{if(path==='/repos/fresh/new')throw new Error('HTTP 404');throw new Error('unexpected '+path);},stats:()=>({requests:1,elapsed_ms:1})};
  const gone=await repairMetadata(output,{api:deleted,now:'2026-11-02T00:00:00Z'});
  assert.deepEqual(gone.repaired,[]);
  assert.equal(gone.failed.length,1);
  assert.match(gone.failed[0].error,/Repository missing, renamed or private/);
  const readable={request:async path=>{
   if(path==='/repos/fresh/new')return {data:{full_name:'fresh/new',private:false}};
   if(path==='/repos/fresh/new/readme')return {data:{encoding:'base64',content:Buffer.from('hello').toString('base64'),sha:'abc',html_url:'https://github.com/fresh/new/blob/main/README.md'}};
   throw new Error('unexpected '+path);},stats:()=>({requests:2,elapsed_ms:1})};
  const result=await repairMetadata(output,{api:readable,now:'2026-11-02T00:00:00Z'});
  assert.deepEqual(result.repaired,[]);
  assert.equal(result.failed.length,1);
  assert.equal(result.failed[0].name,'fresh/new');
  assert.equal(result.written,false);
  const feed=JSON.parse(await readFile(join(output,'rankings.json'),'utf8'));
  assert.equal(feed.failures.length,1);
  const transient={request:async()=>{throw new Error('HTTP 503');},stats:()=>({requests:1,elapsed_ms:1})};
  const result2=await repairMetadata(output,{api:transient,now:'2026-11-02T00:00:00Z'});
  assert.deepEqual(result2.repaired,[]);
  assert.match(result2.failed[0].error,/HTTP 503/);
  assert.equal(JSON.parse(await readFile(join(output,'rankings.json'),'utf8')).failures.length,1);
 }finally{await rm(output,{recursive:true,force:true});}
});
