import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrending, interleave, dailyHistory, rankRows, collectDynamic } from './dynamic.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyFeed} from './verify-feed.mjs';

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
test('both lists are capped at fifteen and rising uses share of current stars, not a fictitious baseline',()=>{
 const rows=Array.from({length:20},(_,i)=>({name:`a/r${i}`,stars:1000,new_stars_day:100+i,created_at:'2026-10-01T00:00:00Z'}));
 const result=rankRows(rows,end);
 assert.equal(result.daily.length,15);assert.equal(result.rising.length,15);
 assert.equal(result.daily[0].new_stars_day,119);
 assert.equal(result.rising[0].recent_share_percent,11.899999999999999);
 const zero=rankRows([{name:'a/zero',stars:0,new_stars_day:40,created_at:'2026-10-01T00:00:00Z'}],end);
 assert.equal(zero.daily[0].recent_share_percent,null);assert.equal(zero.rising[0].rising_score,0.4);
});

test('counts all discovered candidates before ranking, finds late winner, reads README and preserves raw day evidence',async()=>{
 const output=await mkdtemp(join(tmpdir(),'rankings-complete-'));
 const names=Array.from({length:45},(_,i)=>`fresh/r${i}`);
 const reads=[];
 const transport={stats:()=>({requests:150,elapsed_ms:100}),
  fetchLimited:async url=>({text:url.includes('translate.googleapis.com')?JSON.stringify([[['通过手机和桌面控制人工智能编程代理。']]]):names.map(n=>`<article><h2><a href="/${n}">x</a></h2></article>`).join('')}),
  request:async path=>{
   reads.push(path);
   if(path.startsWith('/search/'))return {data:{items:[]}};
   const name=path.match(/^\/repos\/([^/]+\/[^/?]+)/)?.[1];
   if(path.endsWith('/readme'))return {data:{encoding:'base64',content:Buffer.from('# App\n\n![badge](https://example.com/badge)\n\nControl coding agents from mobile and desktop.\n\n## Install\nDo not run this command.').toString('base64'),sha:'abc123',html_url:`https://github.com/${name}/blob/main/README.md`}};
   if(path.includes('/stargazers/history')) {const count=name==='fresh/r44'?900:100+Number(name.split('/r')[1]);return {data:[{week:1793491200,total:count,days:[count,0,0,0,0,0,0]}]};}
   if(path.includes('/git/trees/'))return {data:{tree:[]}};
   if(path.includes('/releases?'))return {data:[]};
   return {data:{full_name:name,private:false,stargazers_count:2000,created_at:'2026-10-01T00:00:00Z',description:name==='fresh/r44'?null:'Coding helper',default_branch:'main'}};
  }};
 try {
  const result=await collectDynamic({output,observedAt:end,transport});
  assert.equal(result.coverage.counted,45);assert.equal(result.coverage.selected,45);
  assert.equal(result.daily.length,15);assert.equal(result.rising.length,15);
  const winner=result.daily[0];assert.equal(winner.name,'fresh/r44');assert.equal(winner.new_stars_day,900);
  assert.equal(winner.description,'Control coding agents from mobile and desktop.');
  assert.equal(winner.description_source.kind,'readme');assert.equal(winner.description_source.sha,'abc123');
  assert.equal(winner.star_evidence.history[0].days[0],900);
  assert.equal(result.observations.length,45);
  assert.equal(reads.filter(p=>p.includes('/git/trees/')).length,15);
  assert(!winner.description.includes('Install'));
  assert.equal(verifyFeed(result).allCandidatesAccountedFor,true);
  const altered=structuredClone(result);altered.observations.pop();assert.throws(()=>verifyFeed(altered));
  const wrongOrder=structuredClone(result);wrongOrder.daily.reverse();assert.throws(()=>verifyFeed(wrongOrder));
  const untranslated=structuredClone(result);delete untranslated.daily[0].summary_zh;assert.throws(()=>verifyFeed(untranslated));
  untranslated.failures.push({name:untranslated.daily[0].name,stage:'chinese_summary',error:'HTTP 503'});assert.equal(verifyFeed(untranslated).rankingRecomputed,true);
  const latest=await readFile(join(output,'rankings.json'),'utf8'),day=await readFile(join(output,'daily','2026-11-01.json'),'utf8');
  await assert.rejects(collectDynamic({output,observedAt:end,transport:{...transport,request:async path=>{if(path.includes('/fresh/r44/stargazers/'))throw new Error('Collection request/time budget reached');return transport.request(path);}}}),/Incomplete candidate counts/);
  assert.equal(await readFile(join(output,'rankings.json'),'utf8'),latest);assert.equal(await readFile(join(output,'daily','2026-11-01.json'),'utf8'),day);
  await assert.rejects(collectDynamic({output,observedAt:end,transport:{...transport,request:async path=>{if(path.startsWith('/search/'))throw new Error('HTTP 503');return transport.request(path);}}}),/Incomplete discovery/);
  assert.equal(await readFile(join(output,'rankings.json'),'utf8'),latest);
 }finally{await rm(output,{recursive:true,force:true});}
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
  await assert.rejects(collectDynamic({output,observedAt:end,transport:{...transport,fetchLimited:async()=>{throw new Error('offline');},request:async()=>{throw new Error('offline');}}}),/Incomplete discovery/);
  assert.equal(await readFile(join(output,'rankings.json'),'utf8'),saved);
 }finally{await rm(output,{recursive:true,force:true});}
});
