import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Independently recompute the published rankings from archived source arrays.
// No calls to collector ranking/counting functions, no network or AI calls.
export function verifyFeed(feed) {
 assert.equal(feed.collector_revision,2);
 const names=new Set(feed.coverage.sources.flatMap(s=>s.names).map(n=>n.toLowerCase()));
 assert.equal(names.size,feed.coverage.discovered);
 assert.equal(feed.coverage.selected,names.size);
 const observed=new Map();
 for(const row of feed.observations) {
  const key=row.name.toLowerCase();assert(names.has(key));assert(!observed.has(key));
  const evidence=row.star_evidence;
  assert.equal(evidence.url,`https://api.github.com/repos/${row.name}/stargazers/history?per_page=2`);
  assert(Date.parse(evidence.requested_at)>=Date.parse(feed.generated_at));
  assert(Date.parse(evidence.requested_at)<=Date.parse(feed.collection_finished_at));
  let matched=0,added;
  for(const week of evidence.history) {
   assert.equal(week.days.length,7);assert(week.days.every(n=>Number.isSafeInteger(n)&&n>=0));
   assert.equal(week.total,week.days.reduce((a,b)=>a+b,0));
   const index=Math.floor((Date.parse(feed.generated_at)/1000-week.week)/86400);
   if(index>=0&&index<7) {
    matched++;added=week.days[index];
    assert.equal(Date.parse(feed.window_start),1000*(week.week+index*86400));
    assert.equal(Date.parse(feed.window_end),1000*(week.week+(index+1)*86400));
   }
  }
  assert.equal(matched,1);assert.equal(row.new_stars_day,added);
  observed.set(key,{...row,added,score:added/Math.max(row.stars,100)});
 }
 for(const row of feed.excluded) {const key=row.name.toLowerCase();assert(names.has(key));assert(!observed.has(key));assert(['private','archived'].includes(row.reason));names.delete(key);}
 assert.deepEqual([...observed.keys()].sort(),[...names].sort());
 assert.equal(feed.coverage.counted,observed.size);
 const positive=[...observed.values()].filter(r=>r.added>0);
 const byCount=(a,b)=>b.added-a.added||a.name.localeCompare(b.name);
 const expectedDaily=[...positive].sort(byCount).slice(0,15);
 const expectedRising=positive.filter(r=>{const age=(Date.parse(feed.generated_at)-Date.parse(r.created_at))/86400000;return age>=0&&age<=183&&r.stars<10000&&r.added>=30;}).sort((a,b)=>b.score-a.score||byCount(a,b)).slice(0,15);
 for(const [key,expected] of [['daily',expectedDaily],['rising',expectedRising]]) {
  assert.deepEqual(feed[key].map(r=>r.name),expected.map(r=>r.name));
  for(const row of feed[key]) {
   const original=observed.get(row.name.toLowerCase());assert.equal(row.new_stars_day,original.added);
   assert.deepEqual(row.star_evidence,original.star_evidence);
   if(row.description) {
    if(row.summary_zh)assert.match(row.summary_zh,/[\u4e00-\u9fff]/);
    else assert(feed.failures.some(f=>f.name===row.name&&f.stage==='chinese_summary'),'Missing Chinese summary must have a recorded translation failure');
   }
  }
 }
 return {discovered:feed.coverage.discovered,counted:observed.size,excluded:feed.excluded.length,daily:feed.daily.length,rising:feed.rising.length,originalEvidenceVerified:true,allCandidatesAccountedFor:true,rankingRecomputed:true};
}
if(process.argv[1]?.endsWith('verify-feed.mjs')&&process.argv[2]) console.log(JSON.stringify(verifyFeed(JSON.parse(await readFile(process.argv[2],'utf8'))),null,2));
