# Skill rankings

Public GitHub Skill repository metadata snapshots, collected daily without AI model calls.

The desktop app reads data/rankings.json on demand. Your computer need not stay on.

Daily ranking uses net star change between observed snapshots 20-28 hours apart, not an exact calendar day. Rising ranking uses repository age <=183 days, baseline stars <10000, net increase >=30, scored by delta/max(baseline,100). First observations are unranked. Coverage is a bounded monitored pool, not all GitHub.

Only explicitly public repositories with a SKILL.md file are monitored. File presence is not quality or safety verification. No project source, user documents, passwords, or model credentials are stored here.

Requires Node.js 22+. Run node --test collector.test.mjs, then node collector.mjs --discover --output data. GitHub Actions runs at about 00:07 Asia/Shanghai; delays and gaps are possible.
