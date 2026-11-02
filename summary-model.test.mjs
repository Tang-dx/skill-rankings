import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRanked, sourceText } from './summary-model.mjs';

test('does not present an old machine translation as a grounded summary', async () => {
 const feed={daily:[{name:'a/tool',description:'Something',summary_zh:'旧机译'}],rising:[],failures:[]};
 await summarizeRanked({feed,cache:{entries:{}},readme:async()=>{throw new Error('HTTP 503');},generate:async()=>[]});
 assert.equal(feed.daily[0].summary_zh,undefined);
 assert(feed.failures.some(f=>f.stage==='chinese_summary'));
});

test('ranked duplicates share one summary; cache invalidates when README changes', async () => {
 const row={name:'a/tool',description:'Inspect code'};
 const feed={daily:[row],rising:[{...row}],failures:[]};
 const cache={entries:{}};let calls=0;
 const readme=async()=>({text:'Inspect an existing codebase and prepare changes.',sha:'abc',url:'https://github.com/a/tool/blob/main/README.md'});
 const generate=async items=>{calls++;assert.equal(items.length,1);return [{name:'a/tool',purpose:'帮助开发者分析现有代码，整理需要修改的内容。',use_case:'适合接手陌生项目或准备功能改动。'}];};
 await summarizeRanked({feed,cache,readme,generate});
 assert.equal(calls,1);assert.equal(feed.daily[0].summary_source,'ai_grounded_summary_v1');
 assert.equal(feed.daily[0].summary_zh,feed.rising[0].summary_zh);
 assert.equal(feed.daily[0].summary_evidence.sources[1].sha,'abc');
 await summarizeRanked({feed,cache,readme,generate});assert.equal(calls,1);
 await summarizeRanked({feed,cache,readme:async()=>({...await readme(),sha:'def'}),generate});assert.equal(calls,2);
 await summarizeRanked({feed,cache,readme:async()=>({...await readme(),text:'A drawing editor.'}),generate});assert.equal(calls,3);
});

test('README strips embedded scripts and code and bounds input',()=>{
 const value=sourceText('# Title\n<script>bad()</script>\n```sh\nrm -rf /\n```\nA tool for inspecting code.');
 assert(!value.includes('bad()'));assert(!value.includes('rm -rf'));assert(value.includes('inspecting code'));
 assert(sourceText('a'.repeat(5000)).length<=2200);
});
