import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRanked, sourceText, responsesSummaryGenerator, chatSummaryGenerator, configuredJsonGenerator, summaryPromptVersion } from './summary-model.mjs';

test('natural multi-sentence descriptions need no forced use case; legacy prompt caches regenerate',async()=>{
 const feed={daily:[{name:'a/tool',description:'Inspect code and export a report.'}],rising:[],failures:[]};
 const cache={entries:{}};let calls=0;
 const purpose='分析已有代码，找出需要检查的位置。可以把检查结果导出为报告，方便后续修改。';
 const options={feed,cache,model:'test',readme:async()=>null,generate:async()=>{calls++;return [{name:'a/tool',purpose,use_case:''}];}};
 await summarizeRanked(options);
 assert.equal(feed.daily[0].summary_zh,purpose);
 assert.equal(feed.daily[0].summary_evidence.prompt_version,summaryPromptVersion);
 assert.equal(feed.daily[0].summary_source,'ai_grounded_summary_v1');
 await summarizeRanked(options);assert.equal(calls,1);
 delete cache.entries['a/tool'].prompt_version;
 await summarizeRanked(options);assert.equal(calls,2);
 cache.entries['a/tool'].prompt_version='previous-prompt';
 await summarizeRanked(options);assert.equal(calls,3);
});

test('optional use case does not weaken Chinese content or project identity validation',async()=>{
 for(const item of [
  {name:'a/tool',purpose:'',use_case:''},
  {name:'a/tool',purpose:'分析代码。',use_case:'For developers.'},
  {name:'another/tool',purpose:'分析代码。',use_case:''},
 ]) {
  const feed={daily:[{name:'a/tool',description:'Inspect code.'}],rising:[],failures:[]};
  await summarizeRanked({feed,cache:{},readme:async()=>null,generate:async()=>[item]});
  assert.equal(feed.daily[0].summary_zh,undefined);
  assert.equal(feed.failures[0].stage,'chinese_summary');
 }
});

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
 await assert.rejects(responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>({ok:false,status:429,text:async()=>'{"error":"rate limit"}'})})([]),/429.*rate limit/);
 await assert.rejects(responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>({ok:true,json:async()=>({status:'incomplete',output_text:'{"summaries":[]}'})})})([]),/incomplete/);
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
 const before=structuredClone(feed.daily[0]);
 const rebound=async()=>({...await readme(),sha:'def',url:'https://github.com/a/tool/blob/main/Readme.md'});
 await summarizeRanked({feed,cache,readme:rebound,generate,now:'2026-11-24T00:00:00Z'});assert.equal(calls,1);
 const after=feed.daily[0];
 assert.equal(after.summary_zh,before.summary_zh);
 assert.equal(after.summary_evidence.generated_at,before.summary_evidence.generated_at);
 assert.equal(after.summary_evidence.sources[1].sha,'def');
 assert.equal(after.summary_evidence.sources[1].url,(await rebound()).url);
 assert.notEqual(after.summary_evidence.input_hash,before.summary_evidence.input_hash);
 assert.deepEqual(after.summary_evidence,feed.rising[0].summary_evidence);
 await summarizeRanked({feed,cache,readme:async()=>({...await rebound(),text:'A drawing editor.'}),generate});assert.equal(calls,2);
 await summarizeRanked({feed,cache,readme,generate,model:'other-model'});assert.equal(calls,3);
});

test('configured usage distinguishes retries and unknown usage without logging request content', async t=>{
 const keys={SUMMARY_API_KEY:'test-only',SUMMARY_BASE_URL:'https://example.test',SUMMARY_API_STYLE:'chat'};
 for(const [key,value] of Object.entries(keys)){
  const prior=process.env[key];process.env[key]=value;
  t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
 }
 const response={ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{}'}}],
  usage:{prompt_tokens:120,completion_tokens:40,prompt_cache_hit_tokens:0}})};
 const logs=[];
 let current=response;
 const generate=configuredJsonGenerator({operation:'skill_card',request:async()=>current,log:line=>logs.push(JSON.parse(line))});
 await generate('private source',{});
 current={ok:false,status:503,text:async()=>''};
 await assert.rejects(generate('private source',{},{retry:true}),/503/);
 process.env.SUMMARY_API_STYLE='responses';
 const failedEvent={type:'response.incomplete',response:{usage:{input_tokens:45,output_tokens:12,input_tokens_details:{cached_tokens:5}}}};
 const stream=configuredJsonGenerator({request:async()=>new Response('data: '+JSON.stringify(failedEvent)+'\n\n',
  {headers:{'content-type':'text/event-stream'}}),log:line=>logs.push(JSON.parse(line))});
 await assert.rejects(stream('private source',{}),/did not complete/);
 assert.deepEqual(logs,[
  {event:'model_usage',operation:'skill_card',retry:false,input_tokens:120,output_tokens:40,cached_input_tokens:0},
  {event:'model_usage',operation:'skill_card',retry:true,input_tokens:null,output_tokens:null,cached_input_tokens:null},
  {event:'model_usage',operation:'ranking_summary',retry:false,input_tokens:45,output_tokens:12,cached_input_tokens:5},
 ]);
});

test('HTTP diagnostics redact echoed credentials and bound error detail',async()=>{
 const generate=responsesSummaryGenerator({baseUrl:'https://example.test',token:'secret-for-test',model:'test',request:async()=>({ok:false,status:400,text:async()=>`Invalid secret-for-test Bearer another-secret ${'x'.repeat(1000)}`})});
 await assert.rejects(generate([]),error=>{
  assert.match(error.message,/HTTP 400/);
  assert(!error.message.includes('secret-for-test'));
  assert(!error.message.includes('another-secret'));
  assert(error.message.length<550);
  return true;
 });
});

test('README strips embedded scripts and code and bounds input',()=>{
 const value=sourceText('# Title\n<script>bad()</script>\n```sh\nrm -rf /\n```\nA tool for inspecting code.');
 assert(!value.includes('bad()'));assert(!value.includes('rm -rf'));assert(value.includes('inspecting code'));
 assert(sourceText('a'.repeat(5000)).length<=2200);
});

test('Responses accepts a nonempty top-level output_text even when output is an empty array',async()=>{
 const summaries=[{name:'a/tool',purpose:'帮助理解已有项目。',use_case:'接手代码时使用。'}];
 const generate=responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>({ok:true,json:async()=>({status:'completed',output:[],output_text:JSON.stringify({summaries})})})});
 assert.deepEqual(await generate([]),summaries);
});

test('Chat Completions accepts the GitHub Models response shape',async()=>{
 let requested;
 const summary={summaries:[{name:'a/tool',purpose:'整理已有代码并提供清晰说明。',use_case:'适合开发时快速了解项目用途。'}]};
 const generate=chatSummaryGenerator({baseUrl:'https://example.test/v1',token:'test',model:'openai/gpt-4.1-mini',request:async(url,init)=>{
  requested={url:String(url),body:JSON.parse(init.body)};
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(summary)}}]})};
 }});
 assert.deepEqual(await generate([{name:'a/tool',description:'工具',readme:'说明'}]),summary.summaries);
 assert.equal(requested.url,'https://example.test/v1/chat/completions');
 assert.equal(requested.body.response_format.type,'json_object');
});

test('empty and malformed model text give specific diagnostics, never an opaque JSON EOF',async()=>{
 for(const data of [{output:[]},{output_text:'{"summaries":['}]) {
  const generate=responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>({ok:true,json:async()=>data})});
  await assert.rejects(generate([]),/Summary model (returned no text|returned invalid JSON)/);
 }
});


test('Responses stream accepts split UTF-8 deltas only after terminal completion',async()=>{
 const summaries=[{name:'a/tool',purpose:'帮助理解项目用途。',use_case:'适合开发时查看。'}];
 const text=JSON.stringify({summaries});
 const delta=`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\r\n\r\n`;
 const completed=`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[]}})}\r\n\r\n`;
 const make=(body)=>responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async(_url,init)=>{
  assert.equal(JSON.parse(init.body).stream,true);
  const bytes=new TextEncoder().encode(body);
  return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 }});
 assert.deepEqual(await make(delta+completed)([]),summaries);
 await assert.rejects(make(delta)([]),/before completion/);
 await assert.rejects(make(delta+'data: {"type":"response.incomplete"}\n\n')([]),/did not complete/);
});


test('Responses stream allows protocol overhead but bounds the wire size',async()=>{
 const summaries=[{name:'a/tool',purpose:'帮助理解项目。',use_case:'适合接手代码。'}];
 const event={type:'response.completed',response:{status:'completed',output_text:JSON.stringify({summaries})}};
 const generate=body=>responsesSummaryGenerator({baseUrl:'https://example.test',token:'test',model:'test',request:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})});
 const overhead=`data: ${JSON.stringify({type:'response.created',padding:'x'.repeat(300000)})}\n\n`;
 assert.deepEqual(await generate(overhead+`data: ${JSON.stringify(event)}\n\n`)([]),summaries);
 await assert.rejects(generate('x'.repeat(2*1024*1024+1))([]),/size budget/);
});


test('Chat diagnostics redact echoed token rather than losing the HTTP failure cause',async()=>{
 const generate=chatSummaryGenerator({baseUrl:'https://example.test',token:'chat-secret',model:'test',request:async()=>({ok:false,status:400,text:async()=>`protocol_not_supported chat-secret Bearer another-secret ${'x'.repeat(900)}`})});
 await assert.rejects(generate([]),error=>{assert.match(error.message,/HTTP 400.*protocol_not_supported/);assert(!error.message.includes('chat-secret'));assert(!error.message.includes('another-secret'));assert(error.message.length<550);return true;});
});

test('DeepSeek summaries disable default thinking without changing other Chat providers',async()=>{
 for(const baseUrl of ['https://api.deepseek.com','https://api.deepseek.com/v1','https://example.test/v1','https://api.deepseek.com.example.test']) {
  let body;
  const generate=chatSummaryGenerator({baseUrl,token:'test-only',model:'deepseek-flash',request:async(_url,init)=>{
   body=JSON.parse(init.body);assert.equal(init.redirect,'error');
   return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"summaries":[]}'}}]})};
  }});
  await generate([]);
  assert.deepEqual(body.thinking,new URL(baseUrl).hostname==='api.deepseek.com'?{type:'disabled'}:undefined);
  assert.equal(body.max_tokens,5000);
 }
});

test('Chat rejects truncated or filtered output even when JSON parses, without exposing model text',async()=>{
 for(const reason of ['length','content_filter','tool_calls','test-only-secret',null,undefined,'']) {
  const generate=chatSummaryGenerator({baseUrl:'https://example.test',token:'test-only-secret',model:'test',request:async()=>({ok:true,json:async()=>({choices:[{finish_reason:reason,message:{content:'{"summaries":[]}',reasoning_content:'private reasoning'}}],usage:{completion_tokens:5000,completion_tokens_details:{reasoning_tokens:5000}}})})});
  await assert.rejects(generate([]),error=>{assert.match(error.message,/did not complete/);assert.match(error.message,/completion_tokens=5000; reasoning_tokens=5000/);assert(!error.message.includes('private reasoning'));assert(!error.message.includes('test-only-secret'));return true;});
 }
});
