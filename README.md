# Skill rankings

Public GitHub Skill repository metadata snapshots, collected daily without AI model calls.

The desktop app reads the generated JSON on demand. Your computer need not stay on.

## Data

- data/rankings.json: generated rankings and first-observation/unavailable rows.
- data/state.json: historical public repository star observations.
- Daily ranking uses net change between actual observations 20-28 hours apart, not an exact calendar day.
- Rising ranking: repository age <=183 days, baseline stars <10000, net increase >=30; score is delta/max(baseline,100).
- Coverage is a bounded monitored pool, not all GitHub. First observations are unranked.
- Only explicitly public repositories containing a SKILL.md file are monitored. File presence is not quality, safety, or usage verification.
- No private project source, passwords, session cookies, personal tokens, or model credentials are stored here.

## Operation

Node.js 22+, no package installation. Run node --test collector.test.mjs, then node collector.mjs --discover --output data. GitHub Actions runs daily at about 20:00 Asia/Shanghai; delays, API limits, and gaps are reported.

The desktop uses the official GitHub contents API with the raw media type and a local cache. Opening the rankings page reads cache only; fetching is explicit. No AI model is called for collection or ranking.
