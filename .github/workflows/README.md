# Validation workflow

`.github/workflows/test.yml` exposes two stable aggregate checks:

- `pr-fast-status` is the default pull-request gate. It covers `bun run verify`,
  gitleaks, the real-Postgres JSONB parity regression guard, and Tier 1
  mechanical E2E.
- `master-full-status` is the integration-confidence gate. It runs on every
  push to `master`, nightly, manually, and on pull requests carrying the
  `full-validation` label. It adds all 10 unit-test shards, serial tests, slow
  evaluations, and Tier 2 LLM skill tests.

On a full-validation pull request and its following `master` push, the
successful-content cache may skip only unit, serial, and slow tests after that
exact content hash passed previously. Security, verification, Postgres, and
Tier 2 checks still run. Nightly and manual runs bypass the cache and execute
every full-suite job.

## When a pull request needs full validation

Create/apply the `full-validation` label and keep it on the pull request before
merging changes to:

- migrations or schema;
- authentication or security boundaries;
- concurrency, queues, minions, or workers;
- search, retrieval, or ranking.

The label is durable: each subsequent push to that pull request reruns the full
path. A maintainer can also select the branch and run the `Validation` workflow
from the Actions tab for one-off full validation.

Heavy ops-shape tests remain separate in `heavy-tests.yml`. They run nightly,
manually, or on a pull request carrying the `heavy-tests` label.
