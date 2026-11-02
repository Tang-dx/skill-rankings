import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRanked, sourceText, responsesSummaryGenerator } from './summary-model.mjs';

test('does not present an old machine translation as a grounded summary', async () => {
 const feed={daily:[{name:'a/tool',description:'Something',summary_zh:'旧机译'}],rising:[],failures:[]};
 await summarizeRanked({feed,cache:{entries:{}},readme:async()=>{throw new Error('HTTP 503');},generate:async()=>[]});
 assert.equal(feed.daily[0].summary_zh,undefined);
 assert(feed.failures.some(f=>f.stage==='chinese_summary'));
});

test('Responses summary uses bounded public evidence and refuses HTTP failures',async()=>{
 let body;
 const generate=responsesSummaryGenerator({baseUrl:'https://example.test/v1',token:'test-only',model:'test',request:async(url,init)=>{
  body=JSON.parse(init.body);assert.equal(init.redirect,'error');assert.equal(String(url),'https://example.test/v1/responses');
  return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({summaries:[{name:'a/tool',purpose:'整理已有代码。',use_case:'适合开发时查看。'}]})}]}]})};
 }});
 assert.equal((await generate([{name:'a/tool',description:'public source',readme:'public README'}]))[0].name,'a/tool');
 assert.equal(body.store,false);assert.equal(body.max_output_tokens,5000);
 await assert.rejects(responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>({ok:false,status:429})})([]),/429/);
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
