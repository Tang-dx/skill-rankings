import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('workflow distinguishes external scheduled retries from forced manual collection',()=>{
 const workflow=readFileSync(new URL('./collector-workflow.yml',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const source=workflow.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0].replace(/^          /gm,'').replace("import {readFileSync,appendFileSync} from 'node:fs';",'');
 const ActualDate=Date;
 for(const [at,event,scheduled,generated,collect] of [
  ['2026-11-02T22:00:00Z','schedule','','2026-11-02T21:59:59Z',true],
  ['2026-11-02T22:03:00Z','workflow_dispatch','true','2026-11-02T22:00:00Z',false],
  ['2026-11-03T00:17:00Z','workflow_dispatch','true','2026-11-02T22:00:00Z',true],
  ['2026-11-03T00:20:00Z','schedule','','2026-11-03T00:17:00Z',false],
  ['2026-11-03T02:17:00Z','workflow_dispatch','true','2026-11-03T00:17:00Z',false],
  ['2026-11-03T02:17:00Z','workflow_dispatch','true','2026-11-02T22:00:00Z',true],
  ['2026-11-03T02:17:00Z','workflow_dispatch','false','2026-11-03T00:17:00Z',true],
  ['2026-11-03T02:17:00Z','schedule','','2026-11-02T00:17:00Z',true],
  ['2026-11-03T02:17:00Z','workflow_dispatch','true','invalid',true],
  ['2026-11-03T02:17:00Z','workflow_dispatch','true','2026-11-03T02:30:00Z',true],
 ]) {
  class ClockDate extends ActualDate {constructor(...args){super(...(args.length?args:[at]));}}
  let output='';
  runInNewContext(source,{Date:ClockDate,Intl,Number,JSON,console:{log(){}},process:{env:{RUN_EVENT:event,SCHEDULED_CHECK:scheduled,GITHUB_OUTPUT:'output'}},readFileSync:()=>JSON.stringify({generated_at:generated}),appendFileSync:(_path,value)=>{output+=value;}});
  assert.equal(output,`collect=${collect}\n`,`${event}/${scheduled}/${generated}`);
 }
});
