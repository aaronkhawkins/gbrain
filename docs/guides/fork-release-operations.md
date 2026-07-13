# Managed Fork Release Operations

The research fork is deployed as an immutable compiled release, never as a
symlink into a development worktree. Building a release does not deploy it to
the live installation: the operator first uses an isolated prefix, reviews its
manifest, and runs the required gates.

## Build and rollback

Create and push a fork-only release tag from a clean, reviewed commit. The tag
must identify `HEAD`, and the recorded upstream ref must be available locally.

```sh
scripts/build-fork-release.sh build \
  --prefix /path/to/isolated/gbrain-fork \
  --tag research-v0.42.59.0-1 \
  --channel private-research-fork \
  --upstream-ref origin/master
```

The builder compiles `gbrain`, embeds the channel, tag, SHA, upstream base and
clean-tree state, and repeats them in `release-manifest.json`. The adjacent
checksum protects the manifest; the manifest protects the binary. A failed
build, identity check or smoke command never changes `current` or `previous`.
Successful selection uses relative, atomic symlinks:

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
compiled smoke check, a later operator-controlled procedure may select it for
the live CLI. This guide does not authorize changing the live symlink,
scheduler, database or configuration.

Rollback only changes code selection and does not roll back persisted data:

```sh
scripts/build-fork-release.sh rollback --prefix /path/to/isolated/gbrain-fork
```

Rollback verifies the previous manifest, binary checksum, embedded identity
and optional smoke command before atomically reselecting it. If a release has
run migrations or changed persisted state, follow that migration's separate
restore procedure instead of assuming code rollback is sufficient.

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
