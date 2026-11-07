import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRanked, sourceText, responsesSummaryGenerator, chatSummaryGenerator } from './summary-model.mjs';

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
 await summarizeRanked({feed,cache,readme:async()=>({...await readme(),sha:'def'}),generate});assert.equal(calls,2);
 await summarizeRanked({feed,cache,readme:async()=>({...await readme(),text:'A drawing editor.'}),generate});assert.equal(calls,3);
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
