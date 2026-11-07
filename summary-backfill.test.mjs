import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enrichRecentReport} from './summary-backfill.mjs';
import {summaryPromptVersion} from './summary-model.mjs';

test('explicit repair refreshes old writing rules, preserves other fields and skips current rules',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'skill-summary-version-'));
 try {
  await mkdir(join(directory,'daily'));
  const feed={generated_at:'2026-11-07T04:07:12Z',daily:[{name:'a/tool',description:'Inspect code',new_stars_day:123,summary_zh:'旧中文总结。',summary_source:'ai_grounded_summary_v1',summary_evidence:{generated_at:'2026-11-07T05:00:00Z'}}],rising:[],failures:[{name:'a/tool',stage:'skill_presence',error:'size budget'}]};
  const initial=JSON.stringify(feed);
  await writeFile(join(directory,'rankings.json'),initial);
  await writeFile(join(directory,'summary-cache.json'),'{}');
  let calls=0;
  const options={readme:async()=>null,generate:async()=>{calls++;return [{name:'a/tool',purpose:'检查代码，帮助发现需要修改的地方。',use_case:''}];}};
  await enrichRecentReport(directory,undefined,options);
  assert.equal(await readFile(join(directory,'rankings.json'),'utf8'),initial);assert.equal(calls,0);
  await enrichRecentReport(directory,undefined,{...options,repairLatest:true});
  const repaired=await readFile(join(directory,'rankings.json'),'utf8'),result=JSON.parse(repaired);
  assert.equal(calls,1);assert.equal(result.daily[0].summary_evidence.prompt_version,summaryPromptVersion);
  assert.equal(result.daily[0].summary_zh,'检查代码，帮助发现需要修改的地方。');
  assert.equal(result.daily[0].new_stars_day,123);assert.equal(result.generated_at,feed.generated_at);
  assert.deepEqual(result.failures,feed.failures);
  await enrichRecentReport(directory,undefined,{...options,repairLatest:true});
  assert.equal(calls,1);assert.equal(await readFile(join(directory,'rankings.json'),'utf8'),repaired);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('backfill repairs a populated latest report without changing star evidence or immutable batches',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'skill-summary-'));
 try {
  await mkdir(join(directory,'daily'));
  await mkdir(join(directory,'batches'));
  await writeFile(join(directory,'batches','original.json'),'original star evidence');
  const feed={generated_at:'2026-11-04T04:07:13Z',daily:[{name:'a/tool',url:'https://github.com/a/tool',description:'Inspect code',new_stars_day:123,star_evidence:{history:[1,2]}}],rising:[],failures:[{name:'a/tool',stage:'chinese_summary',error:'Unexpected end of JSON input'}]};
  await writeFile(join(directory,'rankings.json'),JSON.stringify(feed));
  await writeFile(join(directory,'summary-cache.json'),JSON.stringify({schema:1,entries:{}}));
  await enrichRecentReport(directory,undefined,{repairLatest:true,readme:async()=>null,generate:async()=>[{name:'a/tool',purpose:'帮助阅读和分析已有代码。',use_case:'适合接手项目时整理实现思路。'}]});
  const result=JSON.parse(await readFile(join(directory,'rankings.json'),'utf8'));
  assert.match(result.daily[0].summary_zh,/分析已有代码/);
  assert.equal(result.daily[0].new_stars_day,123);
  assert.deepEqual(result.daily[0].star_evidence,feed.daily[0].star_evidence);
  assert.equal(result.generated_at,feed.generated_at);
  assert.deepEqual(result.failures,[]);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'daily','2026-11-04.json'),'utf8')),result);
  assert.equal(await readFile(join(directory,'batches','original.json'),'utf8'),'original star evidence');
  const newer=JSON.stringify({...feed,generated_at:'2026-11-04T06:17:00Z',daily:[{...feed.daily[0],new_stars_day:999}]});
  await writeFile(join(directory,'daily','2026-11-04.json'),newer);
  await writeFile(join(directory,'rankings.json'),JSON.stringify(feed));
  await enrichRecentReport(directory,undefined,{repairLatest:true,readme:async()=>null,generate:async()=>{throw new Error('cache should be used');}});
  assert.equal(await readFile(join(directory,'daily','2026-11-04.json'),'utf8'),newer);
 } finally {await rm(directory,{recursive:true,force:true});}
});
