import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildHistory} from './history-bundles.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const report=day=>JSON.stringify({schema:1,metric:'net_star_change_between_observed_snapshots',generated_at:day+'T04:00:00Z',daily:[],rising:[],note:'公开资料'.repeat(40)});
test('history packages preserve original bytes, split within a month, and keep stable versions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-bundles-'));
 try {
  await mkdir(join(dir,'daily'));
  for(const day of ['2026-10-31','2026-11-01','2026-11-02','2026-11-03'])await writeFile(join(dir,'daily',day+'.json'),report(day));
  const index=await buildHistory(dir,{now:'2026-11-07T12:00:00Z',maxExpanded:1600});
  assert.equal(index.reports.length,4);assert(index.packs.length>=3);
  for(const pack of index.packs){const bytes=await readFile(join(dir,'history','packs',pack.file));assert.equal(hash(bytes),pack.sha256);const raw=gunzipSync(bytes);assert.equal(raw.length,pack.expanded_bytes);assert(raw.length<=1600);for(const item of JSON.parse(raw).reports){assert.equal(item.content,report(item.day));assert.equal(hash(item.content),item.sha256);}}
  const same=await buildHistory(dir,{now:'2026-11-08T12:00:00Z',maxExpanded:1600});assert.deepEqual(same,index);
  const october=index.packs.find(p=>p.file.startsWith('2026-10'));
  await writeFile(join(dir,'daily','2026-11-03.json'),report('2026-11-03')+'\n');
  const changed=await buildHistory(dir,{now:'2026-11-08T12:00:00Z',maxExpanded:1600});assert.notEqual(changed.revision,index.revision);assert.deepEqual(changed.packs.find(p=>p.file.startsWith('2026-10')),october);
  assert(await readFile(join(dir,'history','packs',index.packs.at(-1).file)));
  const previous=await readFile(join(dir,'history','index.json'),'utf8');
  await writeFile(join(dir,'daily','2026-11-04.json'),report('2026-11-03'));
  await assert.rejects(buildHistory(dir),/date mismatch/);assert.equal(await readFile(join(dir,'history','index.json'),'utf8'),previous);
 }finally{await rm(dir,{recursive:true,force:true});}
});
