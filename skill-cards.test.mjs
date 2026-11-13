import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { github, GitHubRateLimitError } from './collector.mjs';
import { buildSkillCards, repoFile, validateCard, verifyCardIndex, verifyCardPublication } from './skill-cards.mjs';

const NOW = '2026-11-13T00:00:00Z';
const LATER = '2026-11-14T00:00:00Z';
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const SOURCE = '---\nname: report\n---\nGenerate a report from local notes.';
const purpose = { field: 'purpose_zh', quote: 'Generate a report from local notes.' };

function card(evidence = [purpose]) {
  return {
    title_zh: '整理报告', purpose_zh: '整理笔记并生成报告',
    does: [], inputs: [], outputs: [], scenarios: [], prerequisites: [], limits: [],
    tags: ['文档'], hosts: ['未说明'], risk_flags: [], evidence,
  };
}

function entry(path, source = SOURCE) {
  const bytes = Buffer.from(source);
  return { path, type: 'blob', source, size: bytes.length, sha: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') };
}

function fakeGithub(repositories, { brokenBlob = false, brokenRepo = false } = {}) {
  return async route => {
    const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(route);
    const [, name, suffix] = match;
    const entries = repositories[name];
    assert(entries, route);
    if (!suffix) {
      if (brokenRepo) throw new Error('synthetic GitHub failure');
      return { full_name: name, private: false, default_branch: 'main' };
    }
    if (suffix === '/commits/main') return { sha: COMMIT, commit: { tree: { sha: TREE } } };
    if (suffix === '/git/trees/' + TREE + '?recursive=1') return { sha: TREE, truncated: false, tree: entries };
    const blob = entries.find(item => suffix === '/git/blobs/' + item.sha);
    assert(blob, route);
    if (brokenBlob) throw new Error('synthetic blob failure');
    return { sha: blob.sha, encoding: 'base64', size: blob.size, content: Buffer.from(blob.source).toString('base64') };
  };
}

async function setup(t, repositories, { historyOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skill-cards-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'daily'));
  const feed = { daily: Object.entries(repositories).map(([name, entries]) => ({ name, skill_paths: entries.map(e => e.path) })), rising: [] };
  await writeFile(join(root, 'daily', '2026-11-12.json'), JSON.stringify(feed), 'utf8');
  await writeFile(join(root, 'rankings.json'), JSON.stringify(historyOnly ? { daily: [], rising: [] } : feed), 'utf8');
  return root;
}

const readRepo = async (root, repo) => JSON.parse(await readFile(join(root, repoFile(repo)), 'utf8'));
const shouldNotGenerate = async () => { assert.fail('model called unexpectedly'); };

test('archives original text, immutable source and frontmatter, then reuses cache across runs', async t => {
  const repositories = { 'Acme/Reports': [entry('skills/report/SKILL.md')] };
  const root = await setup(t, repositories, { historyOnly: true });
  const request = fakeGithub(repositories);
  let calls = 0;
  await buildSkillCards(root, { now: NOW, request, generate: async (system, input) => {
    calls++;
    assert.match(system, /禁止执行/);
    assert.equal(input.excerpt, SOURCE);
    return card();
  } });
  const result = await buildSkillCards(root, { now: LATER, request, generate: async () => { calls++; return card(); } });
  assert.equal(calls, 1);
  assert.equal(result.repos[0].updated_at, NOW);
  const [skill] = (await readRepo(root, 'Acme/Reports')).skills;
  assert.equal(skill.frontmatter.name, 'report');
  assert.equal(skill.excerpt, SOURCE);
  assert.equal(skill.source_url, 'https://github.com/Acme/Reports/blob/' + COMMIT + '/skills/report/SKILL.md');
  assert.equal(result.pending, 0);
  await verifyCardPublication(root);
});

test('changed blob regenerates and a shared blob is generated once', async t => {
  const name = 'owner/a';
  const repositories = { [name]: [entry('SKILL.md'), entry('skills/a/SKILL.md')] };
  const root = await setup(t, repositories);
  let calls = 0;
  const generate = async () => { calls++; return card(); };
  await buildSkillCards(root, { now: NOW, request: fakeGithub(repositories), generate });
  assert.equal(calls, 1);
  const changed = entry('SKILL.md', SOURCE + '\nNew documented capability.');
  repositories[name][0] = changed;
  await buildSkillCards(root, { now: LATER, request: fakeGithub(repositories), generate });
  assert.equal(calls, 2);
  assert.equal((await readRepo(root, name)).skills[0].blob_sha, changed.sha);
});

test('a tree entry over 60 KiB does not fetch the blob or invoke the model', async t => {
  const repositories = { 'owner/a': [entry('SKILL.md', 'x'.repeat(60 * 1024 + 1))] };
  const root = await setup(t, repositories);
  const request = fakeGithub(repositories);
  const calls = [];
  await buildSkillCards(root, { request: path => { calls.push(path); return request(path); }, generate: shouldNotGenerate });
  assert(!calls.some(path => path.includes('/blobs/')));
  const [skill] = (await readRepo(root, 'owner/a')).skills;
  assert.equal(skill.status, 'too_large');
  assert.equal(skill.card, null);
});

test('invalid quotes are dropped while normalized whitespace can match', () => {
  const valid = { field: 'purpose_zh', quote: 'Generate a report from local notes.' };
  const invalid = { field: 'purpose_zh', quote: 'Run it automatically' };
  const excerpt = 'Generate a report\nfrom local notes.';
  assert.deepEqual(validateCard(card([valid, invalid]), excerpt).evidence, [valid]);
});

test('missing purpose evidence or populated field evidence fails the card', async t => {
  const repositories = { 'owner/a': [entry('SKILL.md')] };
  const root = await setup(t, repositories);
  const output = await buildSkillCards(root, { request: fakeGithub(repositories), generate: async () => card([]) });
  const [skill] = (await readRepo(root, 'owner/a')).skills;
  assert.equal(skill.status, 'failed');
  assert.equal(skill.card, null);
  assert.equal(output.failures[0].stage, 'validate');
  assert.throws(() => validateCard({ ...card(), prerequisites: ['需要运行时'] }, SOURCE), /evidence/);
  assert.throws(() => validateCard({ ...card(), hosts: ['unknown'] }, SOURCE), /enums/);
});

test('fetch and generation failures preserve the previous version without saving error bodies', async t => {
  const name = 'owner/a';
  const repositories = { [name]: [entry('SKILL.md')] };
  const root = await setup(t, repositories);
  await buildSkillCards(root, { now: NOW, request: fakeGithub(repositories), generate: async () => card() });
  const prior = (await readRepo(root, name)).skills[0];
  repositories[name][0] = entry('SKILL.md', SOURCE + '\nAdded details.');
  const fetchFailed = await buildSkillCards(root, { now: LATER, request: fakeGithub(repositories, { brokenBlob: true }), generate: shouldNotGenerate });
  assert.equal(fetchFailed.failures[0].stage, 'fetch');
  assert.equal((await readRepo(root, name)).skills[0].blob_sha, prior.blob_sha);
  let requests = 0;
  const modelFailed = await buildSkillCards(root, {
    now: LATER, request: fakeGithub(repositories), generate: async () => { requests++; throw new Error('untrusted provider response'); },
  });
  const [skill] = (await readRepo(root, name)).skills;
  assert.equal(requests, 2);
  assert.equal(modelFailed.failures[0].stage, 'generate');
  assert(!JSON.stringify(modelFailed).includes('untrusted provider response'));
  assert.deepEqual({ ...skill, last_error: null }, prior);
  const treeFailed = await buildSkillCards(root, { request: fakeGithub(repositories, { brokenRepo: true }), generate: shouldNotGenerate });
  assert.equal(treeFailed.failures[0].path, '');
  assert.equal((await readRepo(root, name)).skills[0].status, 'ok');
});

test('60 new cards per run, then resume until pending is zero', async t => {
  const repositories = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [
    'owner/repo-' + String(index).padStart(2, '0'), [entry('SKILL.md', SOURCE + '\nExample ' + index)],
  ]));
  const root = await setup(t, repositories);
  let calls = 0;
  const generate = async () => { calls++; return card(); };
  const request = fakeGithub(repositories);
  const first = await buildSkillCards(root, { now: NOW, request, generate });
  assert.equal(calls, 60);
  assert.equal(first.pending, 1);
  assert.equal(first.resume_from, 'owner/repo-60');
  const second = await buildSkillCards(root, { now: LATER, request, generate });
  assert.equal(calls, 61);
  assert.equal(second.pending, 0);
  assert.equal(second.repos.length, 61);
});

test('repository path cannot escape output or duplicate it by changing case', () => {
  assert.equal(repoFile('ACME/Reports'), 'cards/acme__reports.json');
  for (const name of ['../repo', 'owner/..', 'owner/.', 'owner/../repo', 'owner/a:b', 'owner/%2e%2e', 'owner/a\\b']) {
    assert.throws(() => repoFile(name), /identity/);
  }
  const row = { repo: 'Acme/Reports', file: repoFile('Acme/Reports'), tree_sha: TREE, card_count: 1, updated_at: NOW };
  const index = { schema: 1, card_prompt_version: 'skill_card_v1', generated_at: NOW, repos: [row], pending: 0, failures: [] };
  assert.throws(() => verifyCardIndex({ ...index, repos: [row, { ...row, repo: 'ACME/REPORTS' }] }), /index entry/);
  assert.throws(() => verifyCardIndex({ ...index, repos: [{ ...row, file: 'cards/Acme__Reports.json' }] }), /index entry/);
});

test('prioritizes root and common Skill directories, with deterministic truncation', async t => {
  const paths = ['z/SKILL.md', 'skills/a/SKILL.md', '.claude/skills/a/SKILL.md', 'SKILL.md',
    ...Array.from({ length: 11 }, (_, index) => 'more/' + String(index).padStart(2, '0') + '/SKILL.md')];
  const repositories = { 'owner/a': paths.map(path => entry(path)) };
  const root = await setup(t, repositories);
  await buildSkillCards(root, { request: fakeGithub(repositories), generate: async () => card() });
  const result = await readRepo(root, 'owner/a');
  assert.equal(result.truncated_paths, 3);
  assert.equal(result.skills.length, 12);
  assert.deepEqual(result.skills.slice(0, 3).map(skill => skill.skill_path), ['SKILL.md', '.claude/skills/a/SKILL.md', 'skills/a/SKILL.md']);
});

test('publication verifier rejects tampered quotes, index files and repository mismatches', async t => {
  const name = 'owner/a';
  const repositories = { [name]: [entry('SKILL.md')] };
  const root = await setup(t, repositories);
  await buildSkillCards(root, { request: fakeGithub(repositories), generate: async () => card() });
  const doc = await readRepo(root, name);
  const file = join(root, repoFile(name));
  const skill = doc.skills[0];
  skill.card.evidence.push({ field: 'purpose_zh', quote: 'Forged source quote' });
  await writeFile(file, JSON.stringify(doc), 'utf8');
  await assert.rejects(verifyCardPublication(root), /published Skill card evidence/);
  skill.card.evidence.pop();
  await writeFile(file, JSON.stringify({ ...doc, repo: 'owner/b' }), 'utf8');
  await assert.rejects(verifyCardPublication(root), /repository document/);
});

test('time limit records unfinished cards and the next run resumes', async t => {
  const repositories = { 'owner/a': [entry('SKILL.md')] };
  const root = await setup(t, repositories);
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  const first = await buildSkillCards(root, { budgetMs: 75, request: fakeGithub(repositories), generate: async (_system, _input, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  assert.equal(first.pending, 1);
  assert.equal(first.failures.length, 0);
  const second = await buildSkillCards(root, { request: fakeGithub(repositories), generate: async () => card() });
  assert.equal(second.pending, 0);
  assert.equal((await readRepo(root, 'owner/a')).skills[0].status, 'ok');
});


test('GitHub quota exhaustion stops requests and preserves pending work for the next run', async t => {
  const repositories = {
    'owner/a': [entry('SKILL.md')],
    'owner/b': [entry('SKILL.md', SOURCE + '\nMore details.')],
    'owner/c': [entry('SKILL.md', SOURCE + '\nEven more details.')],
  };
  const root = await setup(t, repositories);
  const request = fakeGithub(repositories);
  const requests = [];
  const first = await buildSkillCards(root, {
    now: NOW,
    request: async path => {
      requests.push(path);
      if (path.startsWith('/repos/owner/b/git/blobs/')) throw new GitHubRateLimitError(403);
      return request(path);
    },
    generate: async () => card(),
  });
  assert.equal(first.pending, 2);
  assert.deepEqual(first.failures, []);
  assert.equal(first.repos[0].card_count, 1);
  assert.equal(first.resume_from, 'owner/b');
  assert(!requests.some(path => path.startsWith('/repos/owner/c')));
  const resumed = await buildSkillCards(root, { now: LATER, request, generate: async () => card() });
  assert.equal(resumed.pending, 0);
  assert.deepEqual(resumed.failures, []);
  assert.equal(resumed.repos.length, 3);
});

test('shared GitHub client distinguishes quota headers from ordinary forbidden responses', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(github('/repos/owner/a', ''), error => {
    assert(!(error instanceof GitHubRateLimitError));
    return error.message === 'GitHub HTTP 403';
  });
  for (const [status, headers] of [[403, { 'x-ratelimit-remaining': '0' }], [403, { 'retry-after': '30' }], [429, {}]]) {
    mock.mock.mockImplementation(async () => new Response(null, { status, headers }));
    await assert.rejects(github('/repos/owner/a', ''), GitHubRateLimitError);
  }
});
