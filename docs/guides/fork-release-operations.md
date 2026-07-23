# Managed Fork Release Operations

The research fork is deployed as an immutable compiled release, never as a
symlink into a development worktree. Building a release does not deploy it to
the live installation: the operator first uses an isolated prefix, reviews its
manifest, and runs the required gates.

## Integration input freeze

Before opening an upstream merge, record exact fork, upstream, and merge-base
commit objects in the
[Managed Fork Integration Report](../operations/managed-fork-integration-report.md).
Branch names are inspection coordinates only. The merge and every regenerated
conflict/semantic inventory use the selected object IDs, so a later fetch
cannot silently change the candidate.

The freeze receipt records:

1. Full commit and tree IDs, remote-tracking reflog timestamps, four-part
   versions, schema heads, and commit counts from the merge base.
2. Included and excluded side branches, using both ancestry and behavioral
   characterization. Patch-equivalent historical branches remain excluded.
3. `git merge-tree` content conflicts assigned to an implementation unit,
   selected invariant, proving test, and resolution disposition.
4. A separate two-sided inventory of exported declarations, persisted
   contracts, config keys, migrations, queue payloads, and producer/consumer
   edges, including clean auto-merges.
5. Code, config, queue, source, data, and embedding rollback coordinates.

Do not begin the merge until default/unmarked behavior, fork provider routes,
research source scope, durable payload compatibility, generated-output
idempotency, and release identity have focused characterization coverage.

If a remote-tracking ref advances, keep the selected commit unchanged. Admit a
later commit only when a focused Phase 0 acceptance failure demonstrates the
gap and its dependency closure is recorded in the report.

## Build and rollback

Create and push a fork-only release tag from a clean, reviewed commit. The tag
must identify `HEAD`, and the recorded upstream ref must be available locally.

```sh
scripts/build-fork-release.sh build \
  --prefix /path/to/isolated/gbrain-fork \
  --tag research-v0.42.59.0-1 \
  --channel private-research-fork \
  --upstream-ref origin/master \
  --schema-min 122 \
  --schema-max 124
```

The builder compiles `gbrain`, embeds the channel, tag, SHA, upstream base and
clean-tree state, and repeats them in `release-manifest.json` with the target
OS, architecture, executable format, runtime ABI, schema compatibility, and
required runtime assets. The adjacent checksum protects the manifest; the
manifest protects the binary. Build never changes `current` or `previous`.

Verify and select through the same authority:

```sh
scripts/build-fork-release.sh install \
  --prefix /path/to/second-compatible-target \
  --from-release /path/to/first-prefix/releases/RELEASE_ID
scripts/build-fork-release.sh verify \
  --prefix /path/to/isolated/gbrain-fork \
  --release-id RELEASE_ID
scripts/build-fork-release.sh select \
  --prefix /path/to/isolated/gbrain-fork \
  --release-id RELEASE_ID
```

Install re-verifies and copies the exact binary, manifest, and checksum into a
second matching target without selecting it. Selection re-verifies identity
and checksums, then uses relative, atomic symlinks. Selection requires manifest
v2; rollback can still verify and select
a manifest-v1 previous artifact so upgrading the release tool does not erase
the existing code rollback coordinate.

```text
isolated/gbrain-fork/
  releases/research-v0.42.59.0-1-0123456789ab/
    gbrain
    release-manifest.json
    release-manifest.sha256
  current  -> releases/research-v0.42.59.0-1-0123456789ab
  previous -> releases/research-v0.42.58.0-1-fedcba987654
```

Inspect identity without opening a brain or database:

```sh
/path/to/isolated/gbrain-fork/current/gbrain version --json
```

After a staged release has passed the focused suites, diff-aware CI and a
compiled smoke check, the operator supplies a private mode-0600 deployment
descriptor to `scripts/verify-managed-fork-release.ts`. There are no default
brain-home or release paths. The verifier checks the selected immutable
artifact, target tuple, engine, and CLI/scheduler/supervisor/worker receipts.
Its output names only an opaque deployment ID and check results.

Each service receives the same opaque `GBRAIN_DEPLOYMENT_RECEIPT_ID`,
`GBRAIN_BRAIN_RECEIPT_ID`, and `GBRAIN_CONFIG_RECEIPT_ID`, plus its own
absolute receipt destination: `GBRAIN_CLI_RECEIPT_FILE`,
`GBRAIN_SCHEDULER_RECEIPT_FILE`, `GBRAIN_SUPERVISOR_RECEIPT_FILE`, or
`GBRAIN_WORKER_RECEIPT_FILE`. Receipts are atomically written mode 0600.

The private descriptor is JSON schema version 1 with: opaque
`deployment_id`; absolute `release_prefix`, `brain_home`, and `config_path`;
exact `release_id`; `expected_engine`; `require_selected`; expected channel,
four-part version, tag, full commit, upstream base, target tuple, and three receipt IDs; plus
absolute process-receipt paths keyed by `cli`, `scheduler`, `supervisor`, and
`worker`. Keep it outside the checkout and set mode 0600.

```sh
bun scripts/verify-managed-fork-release.ts \
  --descriptor /private/mode-0600/deployment.json \
  --json
```

This guide does not authorize changing the live symlink, scheduler, database
or configuration.

Rollback only changes code selection and does not roll back persisted data:

```sh
scripts/build-fork-release.sh rollback --prefix /path/to/isolated/gbrain-fork
```

Rollback verifies the previous manifest, binary checksum, embedded identity
and optional smoke command before atomically reselecting it. If a release has
run migrations or changed persisted state, follow that migration's separate
restore procedure instead of assuming code rollback is sufficient.

## Layered rollback coordinates

`current`/`previous` is only the code coordinate. Before candidate selection,
the private deployment receipt must also bind:

- the prior configuration snapshot and effective-config fingerprint;
- queue counts, accepted payload versions, and drain/quarantine disposition;
- canonical source-repository commit receipts;
- schema version and a restore-tested engine-correct backup receipt; and
- the accepted embedding provider/model/dimensions/column/preprocessing
  cohort, including legacy/unknown disposition.

Public reports contain only generic labels, object IDs, opaque receipt IDs,
counts, versions, timestamps, and statuses. Private selectors, service names,
configuration roots, endpoints, source identities, backup paths, and
secret-derived fingerprints do not belong in the repository.

Before normal writes resume, a classified restore may accompany binary
rollback when its isolated restore test passed. After normal writes resume,
database or source rollback is prohibited unless a tested delta replay/merge
procedure makes the restore lossless; otherwise use the predeclared
roll-forward repair. Vector-mutating work remains quarantined until the
embedding cohort is accepted.

## Cutover gates and stop thresholds

Each deployment receives a private preflight receipt. These are minimum gates,
not permission to infer missing values:

1. Producers and schedulers are stopped, active jobs are drained or explicitly
   quarantined, and every vector-mutating handler remains quarantined.
2. A quiescent encrypted engine backup is restored into an isolated target.
   Both candidate and previous compiled readers verify schema, aggregate row
   counts, functions/triggers, RLS, vector columns/indexes, queue state, and
   configuration.
3. Migration lock acquisition must complete within 60 seconds and the migration
   within 10 minutes. Any skipped required migration or real-Postgres test is a
   stop.
4. One isolated worker must claim and complete the deterministic canary within
   five minutes. Dead, failed, stalled, duplicate, cross-source, wrong-build,
   wrong-engine, embedding-mismatch, or non-synthetic vector deltas have zero
   tolerance.
5. The canary deployment observes 30 minutes before normal writes resume. The
   protected deployment begins only after that acceptance and receives its own
   30-minute gate. Both receive a 24-hour drift check.
6. Once normal writes resume, database or repository rollback is prohibited
   unless lossless delta replay was tested. Otherwise use the declared
   roll-forward repair.

## Upgrade posture

A binary whose channel is not `upstream` is fork-managed. Its generic
`upgrade` and `self-upgrade` paths refuse to replace it with Garry Tan's
upstream release. Build and select a new verified fork release instead. Source
checkouts and ordinary upstream binaries retain normal upstream upgrade
behavior.

## Maintenance contract

The fork operator reviews upstream at least weekly and before every release.
Unreviewed drift must never exceed either two upstream releases or 30 days.
Crossing either bound pauses feature work and deployment until reconciliation.

Every reconciliation and release requires:

1. Default/unmarked extraction and synthesis characterization tests.
2. Focused OpenCode, BirdClaw policy, indexing, status and upgrade tests.
3. Diff-aware local CI and privacy checks.
4. A clean tagged compiled build whose embedded identity matches its manifest.
5. Selection and rollback smoke tests in an isolated prefix.

Track each custom layer independently: OpenCode transport, bookmark intake,
research synthesis, generated-page indexing, research health, schema activation
and managed release packaging. Retire a layer when upstream code or supported
configuration provides equivalent behavior, its characterization tests pass
without the fork implementation, and a compiled selection/rollback rehearsal
succeeds. Deletion should be a reviewable commit, not an incidental merge edit.

Contributing any layer upstream is a separate product and privacy decision. A
fork reconciliation, tag or release never creates or implies an upstream pull
request.

## Research quality gate

Building a release is not permission to clean the live brain or release the
bookmark backlog. First run the compiled binary through the
[Isolated Research-Wiki Pilot](isolated-research-pilot.md). The pilot uses a
dedicated PGLite brain, replays immutable already-collected records, exercises
the scheduled sync/dream path twice, and requires both content idempotency and
the predeclared human scorecard. Any failed threshold leaves cleanup and backlog
release blocked.
