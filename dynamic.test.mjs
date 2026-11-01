import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrending, interleave, dailyHistory, rankRows, collectDynamic } from './dynamic.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const end='2026-11-01T12:00:00Z';
const start='2026-10-31T12:00:00Z';
test('official history uses the current source day, including non-UTC boundaries, without inventing a 24h delta',()=>{
 const week=Date.parse('2026-11-01T03:00:00Z')/1000;
 const data=[{week,total:1323,days:[1323,0,0,0,0,0,0]}];
 const row=dailyHistory(data,end);
 assert.equal(row.count,1323);assert.equal(row.window_start,'2026-11-01T03:00:00.000Z');
 assert.equal(row.window_end,'2026-11-02T03:00:00.000Z');
 assert.equal(dailyHistory(data,'2026-11-02T03:00:00Z').count,0);
 assert.throws(()=>dailyHistory(data,'2026-10-31T23:00:00Z'),/unavailable/);
 assert.throws(()=>dailyHistory([{...data[0],total:999}],end),/Invalid/);
 assert.throws(()=>dailyHistory([...data,...data],end),/Invalid/);
 assert.throws(()=>dailyHistory([],end),/Missing/);
});
test('discovery interleaves sources without a historical pool; trending links are scoped to headings',()=>{
 assert.deepEqual(interleave([['new/a','new/b'],['fresh/a','new/a']],4),['new/a','fresh/a','new/b']);
 assert.deepEqual(parseTrending('<article class="Box-row"><h2><a href="/new/project">x</a></h2><a href="/sponsor/else">sponsor</a></article>'),['new/project']);
});
test('both lists are capped at ten and rising uses share of current stars, not a fictitious baseline',()=>{
 const rows=Array.from({length:15},(_,i)=>({name:`a/r${i}`,stars:1000,new_stars_day:100+i,created_at:'2026-10-01T00:00:00Z'}));
 const result=rankRows(rows,end);
 assert.equal(result.daily.length,10);assert.equal(result.rising.length,10);
 assert.equal(result.daily[0].new_stars_day,114);
 assert.equal(result.rising[0].recent_share_percent,11.4);
 const zero=rankRows([{name:'a/zero',stars:0,new_stars_day:40,created_at:'2026-10-01T00:00:00Z'}],end);
 assert.equal(zero.daily[0].recent_share_percent,null);assert.equal(zero.rising[0].rising_score,0.4);
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
    if(path.includes('/stargazers/history'))return {data:[{week:Date.parse('2026-11-01T00:00:00Z')/1000,total:40,days:[40,0,0,0,0,0,0]}]};
    if(path.includes('/releases?'))return {data:[]};
    return {data:{full_name:'fresh/new',private:false,stargazers_count:50,created_at:'2026-10-01T00:00:00Z',description:'Make data reports',default_branch:'main'}};
   }
  };
  const result=await collectDynamic({output,observedAt:end,transport});
  assert.equal(result.daily[0].name,'fresh/new');assert.equal(result.daily[0].new_stars_day,40);
  assert.equal(result.daily[0].summary_zh,'帮助制作中文数据报告。');assert.equal(result.rising.length,1);
  assert(!requested.some(path=>path.includes('/old/')));
  assert.equal(JSON.parse(await readFile(join(output,'daily','2026-11-01.json'),'utf8')).metric,result.metric);
  const saved=await readFile(join(output,'rankings.json'),'utf8');
  await assert.rejects(collectDynamic({output,observedAt:end,transport:{...transport,fetchLimited:async()=>{throw new Error('offline');},request:async()=>{throw new Error('offline');}}}),/No dynamic candidates/);
  assert.equal(await readFile(join(output,'rankings.json'),'utf8'),saved);
 }finally{await rm(output,{recursive:true,force:true});}
});
