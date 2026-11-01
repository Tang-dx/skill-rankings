import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrending, interleave, recentStars, rankRows, collectDynamic } from './dynamic.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const end='2026-11-01T12:00:00Z';
const start='2026-10-31T12:00:00Z';
const stars=Array.from({length:250},(_,i)=>({starred_at:i<175?'2026-10-30T00:00:00Z':i<240?'2026-11-01T00:00:00Z':'2026-11-01T13:00:00Z',user:{id:i+1}}));
function requestFor(rows, mutate) {
 return async path=>{
  const page=Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
  mutate?.(page,rows);
  const last=Math.max(1,Math.ceil(rows.length/100));
  return {data:rows.slice((page-1)*100,page*100),link:last>1?`<https://api.github.com/repos/a/b/stargazers?per_page=100&page=${last}>; rel="last"`:''};
 };
}
test('counts only the fixed 24h window, including same-second boundaries',async()=>{
 const result=await recentStars('a/b',requestFor([...stars]),start,end);
 assert.equal(result.count,65);assert.equal(result.total,250);
 const boundary=[{starred_at:start,user:{id:1}},{starred_at:end,user:{id:2}}];
 assert.equal((await recentStars('a/b',requestFor(boundary),start,end)).count,2);
});
test('detects moving pagination and refuses a comparable count',async()=>{
 let reads=0;
 await assert.rejects(recentStars('a/b',requestFor([...stars],(page,rows)=>{
  if(page===1 && ++reads===2) rows.shift();
 }),start,end),/changed|drift/i);
});
test('discovery interleaves sources without a historical pool; trending links are scoped to headings',()=>{
 assert.deepEqual(interleave([['new/a','new/b'],['fresh/a','new/a']],4),['new/a','fresh/a','new/b']);
 assert.deepEqual(parseTrending('<article class="Box-row"><h2><a href="/new/project">x</a></h2><a href="/sponsor/else">sponsor</a></article>'),['new/project']);
});
test('both lists are capped at ten and rising uses share of current stars, not a fictitious baseline',()=>{
 const rows=Array.from({length:15},(_,i)=>({name:`a/r${i}`,stars:1000,new_stars_24h:100+i,created_at:'2026-10-01T00:00:00Z'}));
 const result=rankRows(rows,end);
 assert.equal(result.daily.length,10);assert.equal(result.rising.length,10);
 assert.equal(result.daily[0].new_stars_24h,114);
 assert.equal(result.rising[0].recent_share_percent,11.4);
});

test('full collection discovers beyond a full legacy pool, archives Chinese results and preserves feed on total failure',async()=>{
 const output=await mkdtemp(join(tmpdir(),'dynamic-skills-'));
 try {
  await writeFile(join(output,'state.json'),JSON.stringify({repositories:Array.from({length:200},(_,i)=>({name:`old/r${i}`}))}));
  const requested=[];
  const transport={
   stats:()=>({requests:20,elapsed_ms:100}),
   fetchLimited:async url=>({text:url.includes('translate.googleapis.com')?JSON.stringify([[['帮助制作中文数据报告。']]]):'<article><h2><a href="/fresh/new">new</a></h2></article>'}),
   request:async path=>{
    requested.push(path);
    if(path.startsWith('/search/'))return {data:{items:[{full_name:'fresh/new'}]}};
    if(path.includes('/git/trees/'))return {data:{tree:[]}};
    if(path.includes('/stargazers'))return {data:Array.from({length:50},(_,i)=>({starred_at:i<10?'2026-10-30T00:00:00Z':'2026-11-01T00:00:00Z',user:{id:i+1}})),link:''};
    if(path.includes('/releases?'))return {data:[]};
    return {data:{full_name:'fresh/new',private:false,stargazers_count:50,created_at:'2026-10-01T00:00:00Z',description:'Make data reports',default_branch:'main'}};
   }
  };
  const result=await collectDynamic({output,observedAt:end,transport});
  assert.equal(result.daily[0].name,'fresh/new');assert.equal(result.daily[0].new_stars_24h,40);
  assert.equal(result.daily[0].summary_zh,'帮助制作中文数据报告。');assert.equal(result.rising.length,1);
  assert(!requested.some(path=>path.includes('/old/')));
  assert.equal(JSON.parse(await readFile(join(output,'daily','2026-11-01.json'),'utf8')).metric,result.metric);
  const saved=await readFile(join(output,'rankings.json'),'utf8');
  await assert.rejects(collectDynamic({output,observedAt:end,transport:{...transport,fetchLimited:async()=>{throw new Error('offline');},request:async()=>{throw new Error('offline');}}}),/No dynamic candidates/);
  assert.equal(await readFile(join(output,'rankings.json'),'utf8'),saved);
 }finally{await rm(output,{recursive:true,force:true});}
});
