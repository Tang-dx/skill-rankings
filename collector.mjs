import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOUR = 3600000;
export const policy = {
  minimum_interval_hours: 20, maximum_interval_hours: 28,
  rising_maximum_age_days: 183, rising_maximum_baseline_stars: 10000,
  rising_minimum_net_stars: 30, growth_denominator_floor: 100,
};
const validName = name => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(name) && !name.endsWith('/..');

export function buildFeed(state, now) {
  const time = Date.parse(now);
  const daily = [], rising = [], unranked = [];
  for (const repo of state.repositories) {
    if (!validName(repo.name) || repo.archived || !repo.skill_paths?.length) continue;
    const samples = repo.samples.filter(s => Number.isSafeInteger(s.stars) && s.stars >= 0 && Number.isFinite(Date.parse(s.at)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const current = samples.at(-1);
    const row = {
      name: repo.name, url: `https://github.com/${repo.name}`, description: repo.description,
      created_at: repo.created_at, skill_paths: repo.skill_paths,
      launch_evidence: repo.launch_evidence ?? null,
      skill_verified_at: repo.verified_at, stars: current?.stars ?? null,
      sampled_at: current?.at ?? null, net_stars: null,
      source_url: `https://api.github.com/repos/${repo.name}`,
    };
    if (!current || current.at !== now) {
      unranked.push({ ...row, reason: 'current_sample_unavailable' }); continue;
    }
    const baseline = samples.filter(s => {
      const hours = (time - Date.parse(s.at)) / HOUR;
      return hours >= policy.minimum_interval_hours && hours <= policy.maximum_interval_hours;
    }).sort((a, b) => Math.abs(time - Date.parse(a.at) - 24 * HOUR) - Math.abs(time - Date.parse(b.at) - 24 * HOUR))[0];
    if (!baseline) { unranked.push({ ...row, reason: 'daily_baseline_unavailable' }); continue; }
    const delta = current.stars - baseline.stars;
    if (delta <= 0) continue;
    const ranked = { ...row, net_stars: delta, baseline_stars: baseline.stars,
      baseline_at: baseline.at, interval_hours: (time - Date.parse(baseline.at)) / HOUR,
      growth_percent: baseline.stars > 0 ? delta / baseline.stars * 100 : null,
      rising_score: delta / Math.max(baseline.stars, policy.growth_denominator_floor) };
    daily.push(ranked);
    const age = (time - Date.parse(repo.created_at)) / (24 * HOUR);
    if (age >= 0 && age <= policy.rising_maximum_age_days && baseline.stars < policy.rising_maximum_baseline_stars && delta >= policy.rising_minimum_net_stars) rising.push(ranked);
  }
  const stable = (a, b) => a.name.localeCompare(b.name);
  daily.sort((a, b) => b.net_stars - a.net_stars || stable(a, b));
  rising.sort((a, b) => b.rising_score - a.rising_score || b.net_stars - a.net_stars || stable(a, b));
  return { schema: 1, generated_at: now, metric: 'net_star_change_between_observed_snapshots',
    scope: 'verified Skill repositories in monitored pool; not all GitHub', policy,
    monitored_repositories: state.repositories.length, daily: daily.slice(0, 20),
    rising: rising.slice(0, 20), unranked, failures: [] };
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DevCockpit-Skill-Rankings',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

async function atomicJson(file, data) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export async function archiveFeed(output, feed) {
  const timestamp = Date.parse(feed.generated_at);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid archive time');
  const day = new Date(timestamp + 8 * HOUR).toISOString().slice(0, 10);
  const directory = join(output, 'daily');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${day}.json`);
  const batches = join(output, 'batches', day);
  await mkdir(batches, { recursive: true });
  const preserve = async value => {
    const batch = join(batches, `${new Date(value.generated_at).toISOString().replace(/[:.]/g, '-')}.json`);
    try { await writeFile(batch, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  try {
    const previous = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isFinite(Date.parse(previous.generated_at))) throw new Error('Damaged daily archive');
    await preserve(previous);
    if (Date.parse(previous.generated_at) >= timestamp) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await preserve(feed);
  await atomicJson(file, feed);
}

// Release dates are evidence of a version publication, not proof of project launch.
export async function releaseEvidence(name, request, token, checkedAt) {
  const releases = [];
  // Smaller pages bound large release bodies/assets. Keep the 300-record cap.
  const perPage=10;
  for (let page = 1; page <= 30; page++) {
    const batch = await request(`/repos/${name}/releases?per_page=${perPage}&page=${page}`, token);
    if (!Array.isArray(batch)||batch.length>perPage) throw new Error('Invalid release response');
    releases.push(...batch.filter(r => !r.draft && Number.isFinite(Date.parse(r.published_at)) && Date.parse(r.published_at) <= Date.parse(checkedAt) && typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${name}/releases/tag/`)));
    if (batch.length < perPage) {
      releases.sort((a,b) => Date.parse(a.published_at)-Date.parse(b.published_at));
      const first=releases[0];
      return { kind: 'release_record', checked_at: checkedAt, published_at: first?.published_at ?? null, url: first?.html_url ?? null, complete: true };
    }
  }
  return { kind: 'release_record', checked_at: checkedAt, published_at: null, url: null, complete: false };
}

export async function collect({ output, repos = [], discover = false, token = process.env.GITHUB_TOKEN, request = github, observedAt, releaseDates = false }) {
  await mkdir(output, { recursive: true });
  const statePath = join(output, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { schema: 1, repositories: [] }; }
  if (state.schema !== 1 || !Array.isArray(state.repositories)) throw new Error('Unsupported or damaged state; refusing overwrite');
  const now = observedAt ?? new Date().toISOString();
  const started = Date.now();
  const failures = [];
  let releaseChecks = 0;
  const known = new Map(state.repositories.map(repo => [repo.name.toLowerCase(), repo]));
  const candidates = new Set(repos);
  state.checked_candidates ??= {};
  if (discover) {
    const discovered = [];
    const cutoff = new Date(Date.now() - 183 * 24 * HOUR).toISOString().slice(0, 10);
    for (const query of ['topic:agent-skills stars:>=30 archived:false',
      `topic:agent-skills created:>=${cutoff} stars:30..9999 archived:false`,
      `"skills" in:name,description created:>=${cutoff} stars:30..9999 archived:false`]) {
      try {
        const data = await request(`/search/repositories?${new URLSearchParams({ q: query, sort: 'stars', order: 'desc', per_page: '30' })}`, token);
        if (!Array.isArray(data.items)) throw new Error('Invalid search response');
        if (data.incomplete_results) failures.push({ stage: 'discovery', error: 'GitHub incomplete search results' });
        discovered.push(data.items.map(item => item.full_name).filter(name => validName(name ?? '')));
      } catch (error) { failures.push({ stage: 'discovery', error: error.message }); }
    }
    // Interleave sources so popular repositories cannot starve new small ones.
    for (let index = 0; index < 30; index++) for (const group of discovered) if (group[index]) candidates.add(group[index]);
  }
  // Retain existing monitored repositories. Bound new verification per run, not its historical star delta.
  const names = [...known.values()].map(r => r.name);
  names.push(...[...candidates].filter(n => !known.has(n.toLowerCase()) &&
    (!state.checked_candidates[n.toLowerCase()] || Date.parse(now) - Date.parse(state.checked_candidates[n.toLowerCase()]) > 24 * HOUR))
    .sort((a,b) => Date.parse(state.checked_candidates[a.toLowerCase()] ?? '1970-01-01') - Date.parse(state.checked_candidates[b.toLowerCase()] ?? '1970-01-01'))
    .slice(0, 15));
  for (const name of names) {
    if (Date.now() - started > 240000) { failures.push({ stage: 'budget', error: '240 second collection budget reached' }); break; }
    if (!validName(name)) { failures.push({ name, error: 'Invalid repository name' }); continue; }
    try {
      const item = await request(`/repos/${name}`, token);
      if (item.full_name?.toLowerCase() !== name.toLowerCase() || !Number.isSafeInteger(item.stargazers_count) || item.stargazers_count < 0) throw new Error('Invalid repository identity or star count');
      if (item.private !== false) throw new Error('Only explicitly public repositories may be collected');
      let repo = known.get(name.toLowerCase());
      if (!repo) {
        state.checked_candidates[name.toLowerCase()] = now;
        if (known.size >= 200) { failures.push({ name, stage: 'budget', error: '200 repository pool limit' }); continue; }
        const tree = await request(`/repos/${name}/git/trees/${encodeURIComponent(item.default_branch)}?recursive=1`, token);
        const paths = (tree.tree ?? []).filter(entry => entry.type === 'blob' && /(^|\/)SKILL\.md$/.test(entry.path)).map(entry => entry.path);
        if (!paths.length) {
          if (tree.truncated) failures.push({ name, error: 'Truncated tree; Skill presence unknown' });
          continue;
        }
        repo = { name: item.full_name, skill_paths: paths, verified_at: now, samples: [] };
        known.set(name.toLowerCase(), repo);
      }
      Object.assign(repo, { description: item.description ?? '', created_at: item.created_at, archived: item.archived });
      if (releaseDates && repo.launch_evidence?.kind !== 'official_launch' && releaseChecks < 50 && Date.now()-started < 200000 &&
          (!repo.launch_evidence?.checked_at || Date.parse(now)-Date.parse(repo.launch_evidence.checked_at) > 30*24*HOUR)) {
        releaseChecks++;
        try { repo.launch_evidence = await releaseEvidence(repo.name,request,token,now); }
        catch(error) { failures.push({name,stage:'release_date',error:error.message}); }
      }
      // Hourly buckets limit retry noise; <=1h movement stays inside the 20–28h window.
      const bucket = Math.floor(Date.parse(now) / HOUR);
      repo.samples = repo.samples.filter(s => Math.floor(Date.parse(s.at) / HOUR) !== bucket && Date.parse(s.at) >= Date.parse(now) - 35 * 24 * HOUR);
      repo.samples.push({ at: now, stars: item.stargazers_count });
    } catch (error) { if (!known.has(name.toLowerCase())) state.checked_candidates[name.toLowerCase()] = now; failures.push({ name, error: error.message }); }
  }
  state.repositories = [...known.values()];
  state.checked_candidates = Object.fromEntries(Object.entries(state.checked_candidates).filter(([,at]) => Date.now() - Date.parse(at) < 7 * 24 * HOUR));
  const result = buildFeed(state, now);
  result.failures = failures;
  result.elapsed_ms = Date.now() - started;
  // A failed refresh must not replace a last known good feed with an empty success.
  if (state.repositories.length && !state.repositories.some(r => r.samples.at(-1)?.at === now)) throw new Error('No current samples; previous state/feed preserved');
  if (!state.repositories.length) throw new Error('No verified Skill repository sampled; no feed published');
  await atomicJson(statePath, state);
  await archiveFeed(output, result);
  await atomicJson(join(output, 'rankings.json'), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const reposIndex = args.indexOf('--repos');
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : 'data');
  const repos = reposIndex >= 0 ? args[reposIndex + 1].split(',') : [];
  if (!repos.length && !args.includes('--discover')) throw new Error('Specify --repos owner/name or --discover');
  const result = await collect({ output, repos, discover: args.includes('--discover'), releaseDates: args.includes('--release-dates') });
  console.log(JSON.stringify({ generated_at: result.generated_at, monitored: result.monitored_repositories,
    daily: result.daily.length, rising: result.rising.length, unranked: result.unranked.length,
    failures: result.failures, elapsed_ms: result.elapsed_ms }));
}
