import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeed, collect, archiveFeed, releaseEvidence } from './collector.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = '2026-11-01T16:00:00Z';
const yesterday = '2026-10-31T16:00:00Z';
const repo = (name, stars, previous, options = {}) => ({
  name, description: name, created_at: '2026-09-01T00:00:00Z',
  verified_at: yesterday, skill_paths: ['skills/example/SKILL.md'],
  samples: [
    ...(previous === null ? [] : [{ at: yesterday, stars: previous }]),
    { at: now, stars },
  ], ...options,
});
const feed = (repos) => buildFeed({ schema: 1, repositories: repos }, now);

test('release evidence follows pagination, excludes drafts and never equates releases to launch', async () => {
  const release = (published_at) => ({published_at,html_url:'https://github.com/a/b/releases/tag/v1'});
  const evidence = await releaseEvidence('a/b', async path => path.endsWith('page=1')
    ? Array.from({length:10},()=>release('2026-10-01T00:00:00Z'))
    : [release('2026-05-01T00:00:00Z'), {...release('2026-01-01T00:00:00Z'),draft:true}], null, now);
  assert.equal(evidence.kind,'release_record');
  assert.equal(evidence.published_at,'2026-05-01T00:00:00Z');
  const incomplete=await releaseEvidence('a/b',async()=>Array.from({length:10},()=>release(now)),null,now);
  assert.equal(incomplete.complete,false);assert.equal(incomplete.published_at,null);
  const empty=await releaseEvidence('a/b',async()=>[],null,now);assert.equal(empty.published_at,null);
});

test('daily archives use Beijing dates, preserve other days and reject older same-day batches', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-daily-'));
  try {
    const first = feed([]);
    await archiveFeed(output, first);
    const file = join(output, 'daily', '2026-11-02.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first);
    const later = { ...first, generated_at: '2026-11-01T17:00:00Z' };
    await archiveFeed(output, later);
    await archiveFeed(output, first);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), later);
    assert.deepEqual(JSON.parse(await readFile(join(output,'batches','2026-11-02','2026-11-01T16-00-00-000Z.json'),'utf8')),first);
    assert.deepEqual(JSON.parse(await readFile(join(output,'batches','2026-11-02','2026-11-01T17-00-00-000Z.json'),'utf8')),later);
    await archiveFeed(output, { ...first, generated_at: '2026-11-02T16:00:00Z' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), later);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('daily sorts actual net growth; rising distinguishes small rapid growth', () => {
  const result = feed([
    repo('a/famous', 200000, 199000),
    repo('b/small', 500, 200),
    repo('c/tiny', 10, 1),
  ]);
  assert.deepEqual(result.daily.map(r => r.name), ['a/famous', 'b/small', 'c/tiny']);
  assert.equal(result.daily[0].net_stars, 1000);
  assert.deepEqual(result.rising.map(r => r.name), ['b/small']);
  assert.equal(result.rising[0].growth_percent, 150);
  assert.equal(result.rising[0].interval_hours, 24);
});

test('first discovery, missing day, stale current sample cannot invent a daily delta', () => {
  const result = feed([
    repo('a/new', 500, null),
    repo('b/gap', 500, 200, { samples: [{ at: '2026-10-28T16:00:00Z', stars: 200 }, { at: now, stars: 500 }] }),
    repo('c/failed', 500, null, { samples: [{ at: yesterday, stars: 500 }] }),
  ]);
  assert.equal(result.daily.length, 0);
  assert.equal(result.rising.length, 0);
  assert.equal(result.unranked.length, 3);
  assert.ok(result.unranked.every(r => r.net_stars === null));
});

test('negative deltas, archived and unverified repos do not enter positive rankings', () => {
  const result = feed([
    repo('a/shrink', 100, 200),
    repo('b/archive', 500, 200, { archived: true }),
    repo('c/unverified', 500, 200, { skill_paths: [] }),
  ]);
  assert.deepEqual(result.daily, []);
  assert.deepEqual(result.rising, []);
});

test('age and previous star cap are explicit, old repos can still enter daily', () => {
  const result = feed([
    repo('a/old', 500, 200, { created_at: '2020-01-01T00:00:00Z' }),
    repo('b/large', 12000, 11000),
    repo('c/fresh', 10050, 9900),
  ]);
  assert.equal(result.daily.length, 3);
  assert.deepEqual(result.rising.map(r => r.name), ['c/fresh']);
});

test('similar-time duplicate runs do not replace the daily baseline', () => {
  const input = repo('a/repeat', 530, 200);
  input.samples.splice(1, 0, { at: '2026-11-01T15:50:00Z', stars: 520 });
  const result = feed([input]);
  assert.equal(result.daily[0].net_stars, 330);
  assert.equal(result.daily[0].baseline_at, yesterday);
});

test('collector persists real observations, repeated runs remain unranked, failures preserve files', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-rankings-'));
  try {
    const request = async path => path.includes('/git/trees/')
      ? { tree: [{ type: 'blob', path: 'skills/example/SKILL.md' }] }
      : { full_name: 'a/example', private: false, stargazers_count: 500, default_branch: 'main',
          created_at: '2026-09-01T00:00:00Z', archived: false };
    const first = await collect({ output, repos: ['a/example'], request });
    assert.equal(first.monitored_repositories, 1);
    assert.equal(first.daily.length, 0);
    const second = await collect({ output, repos: ['a/example'], request });
    assert.equal(second.daily.length, 0);
    const state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'));
    assert.equal(state.repositories[0].samples.length, 1);
    const saved = await readFile(join(output, 'rankings.json'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(collect({ output, request: async () => { throw new Error('network'); } }), /No current samples/);
    assert.equal(await readFile(join(output, 'rankings.json'), 'utf8'), saved);
    await writeFile(join(output, 'state.json'), '{damaged');
    await assert.rejects(collect({ output, request }));
    assert.equal(await readFile(join(output, 'state.json'), 'utf8'), '{damaged');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('a repository without SKILL.md does not get a feed, mismatched identity is rejected', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-rankings-'));
  try {
    const request = async path => path.includes('/git/trees/') ? { tree: [] }
      : { full_name: 'a/example', private: false, stargazers_count: 500, default_branch: 'main' };
    await assert.rejects(collect({ output, repos: ['a/example'], request }), /No verified/);
    await assert.rejects(collect({ output, repos: ['a/example'], request: async () => ({ full_name: 'b/wrong', stargazers_count: 500 }) }), /No verified/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('discovery rotates past rejected candidates so the next run reaches new skills', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-rankings-'));
  try {
    const searches = Array.from({ length: 20 }, (_, i) => ({ full_name: `a/entry${i}` }));
    const request = async path => {
      if (path.startsWith('/search/')) return { items: searches };
      const name = path.split('/').slice(2, 4).join('/');
      if (path.includes('/git/trees/')) return { tree: name === 'a/seed' || name === 'a/entry19' ? [{ type: 'blob', path: 'SKILL.md' }] : [] };
      return { full_name: name, private: false, stargazers_count: 500, default_branch: 'main', created_at: '2026-09-01T00:00:00Z' };
    };
    await collect({ output, repos: ['a/seed'], request, observedAt: '2026-11-01T16:07:00Z' });
    await collect({ output, discover: true, request, observedAt: '2026-11-01T16:08:00Z' });
    const third = await collect({ output, discover: true, request, observedAt: '2026-11-02T16:09:00Z' });
    assert.equal(third.monitored_repositories, 2);
    assert.ok(third.unranked.some(r => r.name === 'a/entry19'));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('manual runs seven hours later preserve the next scheduled daily baseline', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-rankings-'));
  try {
    let stars = 100;
    const request = async path => path.includes('/git/trees/') ? { tree: [{ type: 'blob', path: 'SKILL.md' }] }
      : { full_name: 'a/example', private: false, stargazers_count: stars, default_branch: 'main', created_at: '2026-09-01T00:00:00Z' };
    const run = observedAt => collect({ output, repos: ['a/example'], request, observedAt });
    await run('2026-10-31T16:07:00Z');
    stars = 200; assert.equal((await run('2026-11-01T16:07:00Z')).daily[0].net_stars, 100);
    stars = 230; await run('2026-11-01T23:07:00Z');
    stars = 300; const result = await run('2026-11-02T16:07:00Z');
    assert.equal(result.daily[0].net_stars, 100);
    assert.equal(result.daily[0].baseline_at, '2026-11-01T16:07:00Z');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('private repositories can never be published even with an authenticated caller', async () => {
  const output = await mkdtemp(join(tmpdir(), 'skill-rankings-'));
  try {
    await assert.rejects(collect({ output, repos: ['a/private'], request: async () => ({
      full_name: 'a/private', private: true, stargazers_count: 500, description: 'secret',
    }) }), /No verified/);
    await assert.rejects(readFile(join(output, 'rankings.json')), { code: 'ENOENT' });
  } finally { await rm(output, { recursive: true, force: true }); }
});
