# Upstream Sync Cadence

Keep fork drift out of active feature slices. Upstream reliability work is
absorbed on purpose — at a **phase boundary** or on a **fixed cadence** — never
as opportunistic mid-slice merges.

This guide is the standing contract for issue-sized work after Phase 0. The
Phase 0 closure artifacts remain historical evidence; this cadence keeps the
habit alive for every later phase.

## Why

Silent mid-slice upstream pulls create three failure modes:

1. **Collision** — feature branches re-resolve the same semantic overlaps the
   behavior ledger already decided.
2. **False health** — a green feature suite on a mixed base does not mean the
   fork pin is still the one production will run.
3. **Unowned deferrals** — useful upstream fixes get neither adopted nor
   explicitly deferred, so they resurface as surprise conflicts.

## Cadence bounds

| Bound | Default | Effect when exceeded |
|---|---|---|
| Review interval | **7 days** | `review_due` — schedule a fixed-cadence review |
| Max unreviewed days | **30 days** | `pause_feature_work` until reconciliation |
| Max unreviewed releases | **2** | `pause_feature_work` until reconciliation |

These match the maintenance contract in
[Fork Release Operations](fork-release-operations.md). Crossing either hard bound
pauses feature slices and deployments until the ledger records a new review.

## When review is allowed to merge

| Trigger | Active feature slice? | Merge allowed? |
|---|---|---|
| `phase-boundary` | yes or no | **Yes** — preferred absorb point |
| `fixed-cadence` | **no** | **Yes** — absorb adopted rows |
| `fixed-cadence` | **yes** | **No merge** — ledger may record deferred/conflicting rows only |
| `blocking-exception` | yes | **Yes, narrow** — only with `disposition=blocking` + written reason |

**No mid-slice sync unless blocking.** "Nice to have" upstream commits wait for
the next phase boundary or an idle fixed-cadence window.

## Ledger requirements

Every review appends to
[`docs/operations/upstream-sync-ledger.md`](../operations/upstream-sync-ledger.md)
and updates the machine JSON block.

Required fields:

- `trigger`: `phase-boundary` | `fixed-cadence` | `blocking-exception`
- `fork_head`, `upstream_pin`, `upstream_head` (object ids / version pins)
- At least one disposition row: `adopted` | `deferred` | `conflicting` |
  `blocking` | `no-op`
- Memory-bounded verification receipt (below)

Semantic overlaps still need a behavior-ledger style row (producer, consumers,
compatibility, proving test) before an `adopted` disposition on a conflicting
surface — reuse the tables in
[Managed Fork Integration Report](../operations/managed-fork-integration-report.md)
or add a focused follow-up review section. Do not re-open Phase 0 wholesale.

## Memory-bounded verification

Repository acceptance for cadence work is **change-focused**, not "run every
test file in the monorepo."

Required for every absorb or policy change:

1. `bun run typecheck`
2. `bun run verify`
3. Focused unit/script tests for touched paths
4. Only the changed real-Postgres / compiled E2E surfaces when a compatibility
   plane moves (migrations, queue payloads, embedding identity, release
   selection)

Do **not** claim all-files green. Record focused paths in the ledger
`verification.focused_tests` array. Full-fleet observation and live brain
canaries stay in deployment receipts — never in this ledger.

## Operator commands

Content-free CLI (JSON only):

```sh
# Validate the standing ledger
bun scripts/upstream-sync-cadence.ts validate \
  --ledger docs/operations/upstream-sync-ledger.md

# Assess drift (exit 2 when feature work must pause)
bun scripts/upstream-sync-cadence.ts assess \
  --ledger docs/operations/upstream-sync-ledger.md \
  --now 2026-08-01 \
  --upstream-version 0.42.66.0

# Decide whether a merge is allowed under the active slice
bun scripts/upstream-sync-cadence.ts decide \
  --ledger docs/operations/upstream-sync-ledger.md \
  --trigger phase-boundary

bun scripts/upstream-sync-cadence.ts decide \
  --ledger docs/operations/upstream-sync-ledger.md \
  --trigger blocking-exception \
  --blocking-reason "CVE fix required before slice can ship"
```

Policy module + tests:

- `scripts/upstream-sync-cadence.ts`
- `test/upstream-sync-cadence.test.ts`

## Active feature slice discipline

While `active_feature_slice` is non-null in the ledger:

1. Land feature work on its own branch/worktree.
2. Do not merge `origin/master` into that slice unless `blocking-exception`.
3. At slice close (phase boundary), run a full review: adopt, defer, or mark
   conflicting; clear or advance `active_feature_slice`; refresh `upstream_pin`
   only for adopted absorbs.
4. Update the machine JSON so `validate` remains green.

## Privacy and security

- Ledger and CLI output: refs, versions, disposition labels, test paths,
  opaque reasons.
- Never store credentials, production brain names as content, page bodies,
  emails, or personal/company knowledge.
- Upstream review does not create or imply a contribution PR to upstream.

## Related

- [Fork Release Operations](fork-release-operations.md) — build, select, rollback
- [Managed Fork Integration Report](../operations/managed-fork-integration-report.md) — Phase 0 behavior ledger
- [Roadmap delivery principles](../roadmaps/2026-07-22-001-gbrain-knowledge-runtime-roadmap.md) — phase-boundary absorb rule
