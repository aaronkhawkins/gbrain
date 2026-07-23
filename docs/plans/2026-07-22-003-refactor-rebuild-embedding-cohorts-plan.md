---
title: "refactor: Rebuild managed embedding cohorts"
type: refactor
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-001-gbrain-knowledge-runtime-requirements.md
---

# refactor: Rebuild managed embedding cohorts

## Summary

Rebuild the personal and AKH Software embedding projections from canonical
knowledge using each brain's independently configured provider, model,
dimensions, and source boundaries. Rehearse the complete migration on restored
Postgres copies before changing either live brain, then cut over and verify the
brains sequentially.

---

## Problem Frame

The managed-fork candidate requires complete v2 embedding provenance before it
will use semantic retrieval. Existing live vectors have legacy or missing page
signatures and chunk model labels that cannot prove compatibility, so
metadata-only relabeling would trade availability for silent retrieval
corruption.

---

## Requirements

- R1. Preserve canonical pages, facts, links, timelines, sources, and queue
  history; only the derived embedding projection may be rebuilt.
- R2. Take an engine-consistent backup and prove restoration before modifying a
  live embedding cohort.
- R3. Preserve hard brain boundaries: personal and AKH use independent
  credentials, databases, configuration, backups, receipts, and cutover
  decisions.
- R4. Recompute every embedded chunk and page signature from the brain's
  effective provider/model/dimensions/preprocessing identity; never relabel an
  existing vector.
- R5. Keep lexical retrieval available during a rebuild and enable semantic
  ranking only after the complete cohort passes identity checks.
- R6. Prove semantic retrieval with held queries where the expected vector
  branch contributes the winning result, not cache or lexical fallback.
- R7. Preserve pre-migration artifacts and a tested rollback coordinate until
  the observation window closes.

---

## Scope Boundaries

- Do not copy personal model configuration into AKH or otherwise change the
  company route as part of this migration.
- Do not merge the personal and company databases or expose one brain's
  credentials, source identities, or content to the other.
- Do not delete or normalize canonical knowledge to improve embedding metrics.
- Do not resume broad Dream or backlog work during clone rehearsal or cutover.

---

## Key Technical Decisions

- Treat vectors and page embedding signatures as disposable derived state, but
  retain all non-vector database state because it contains durable runtime and
  provenance history not fully represented by repository files.
- Rehearse against restored Postgres databases rather than a PGLite surrogate;
  vector types, HNSW indexes, RLS, triggers, and migration behavior are
  engine-specific.
- Process personal first and AKH only after personal acceptance. The smaller
  AKH corpus does not justify weakening its independent security and restore
  gates.
- Stop on any mixed model, dimension, column, preprocessing, or signature
  cohort. A partial rebuild remains lexical-only and resumes from the explicit
  backfill path.

---

## Implementation Units

- U1. **Create private migration receipts and restored test targets**

**Goal:** Capture content-free baselines, take least-privilege backups, and
restore each database into an isolated target.

**Requirements:** R1, R2, R3, R7

**Dependencies:** Managed-fork U8 review fixes and clean candidate commit

**Files:**
- Modify: `docs/operations/managed-fork-integration-report.md`

**Approach:**
- Store private selectors, credentials, backup paths, and detailed fingerprints
  outside the repository.
- Record public receipts using opaque IDs and aggregate counts only.
- Validate restored schema, functions/triggers, RLS, vector columns/indexes,
  source/count aggregates, and queue state with both candidate and prior
  readers.

**Test scenarios:**
- Happy path: a consistent backup restores into an isolated Postgres database
  and all content-free aggregates match.
- Error path: missing privileges, incomplete restore, RLS drift, or vector
  schema mismatch blocks migration.
- Security: public output contains no credentials, endpoints, source names,
  page content, or backup paths.

**Verification:**
- Each brain has an independent restore receipt and rollback coordinate before
  its live cohort changes.

- U2. **Rebuild and validate the personal clone**

**Goal:** Prove the candidate can regenerate the full personal embedding cohort
with the configured local model.

**Requirements:** R1, R4, R5, R6

**Dependencies:** U1 personal restore

**Files:**
- Test: `test/embedding-identity.test.ts`
- Test: `test/hybrid-search-gate.test.ts`
- Modify: `docs/operations/managed-fork-integration-report.md`

**Approach:**
- Clear only embedding-derived columns and compatible vector indexes on the
  restored target.
- Run the compiled candidate's bounded stale backfill to completion.
- Verify exact configured identity across runtime selection, physical column,
  chunk model, page signatures, and search telemetry.

**Test scenarios:**
- Happy path: every eligible page receives a complete v2 signature and every
  eligible chunk receives a current vector.
- Edge case: interruption leaves a resumable partial cohort with semantic
  retrieval disabled.
- Integration: held semantic queries show the vector branch and expected model
  contributing the winning result with cache disabled.

**Verification:**
- Clone counts reconcile, identity checks are green, and retrieval quality and
  latency remain inside declared thresholds.

- U3. **Cut over and observe personal**

**Goal:** Apply the rehearsed rebuild to personal under quiescence and accept
the new cohort before company work begins.

**Requirements:** R2, R4, R5, R6, R7

**Dependencies:** U2, immutable candidate release, deployment preflight

**Files:**
- Modify: `docs/operations/managed-fork-integration-report.md`

**Approach:**
- Stop producers and workers, take and restore-test the final quiescent backup,
  select the verified candidate, and run one bounded worker/backfill path.
- Keep broad Dream and ingestion paused through immediate validation and the
  observation gate.

**Test scenarios:**
- Happy path: live rebuild reaches a single accepted cohort and semantic canary
  passes.
- Error path: provider failure, wrong-build receipt, unexpected vector delta,
  or queue failure stops resumption and follows the predeclared rollback or
  roll-forward repair.
- Integration: restarted CLI, scheduler, supervisor, and worker all report the
  selected immutable artifact and matching brain/config receipts.

**Verification:**
- Personal passes immediate and observation-window health, identity, queue, and
  retrieval checks before producers resume.

- U4. **Rehearse, cut over, and observe AKH independently**

**Goal:** Rebuild the AKH cohort with its existing effective embedding
configuration without inheriting personal settings.

**Requirements:** R1-R7

**Dependencies:** U3 acceptance, AKH administrative restore target

**Files:**
- Modify: `docs/operations/managed-fork-integration-report.md`

**Approach:**
- Repeat U1-U3 with AKH-specific credentials, backup, restored target,
  configuration receipt, source scope, and semantic query set.
- Keep company route configuration read-only; stop if its effective identity is
  internally inconsistent rather than repairing it implicitly.

**Test scenarios:**
- Happy path: the independent AKH clone and live cohort rebuild completely with
  its configured model and dimensions.
- Error path: lack of restore-target privileges, route drift, source leakage,
  or mixed embedding identity blocks company cutover.
- Security: no personal configuration or corpus data appears in AKH receipts,
  jobs, or retrieval results.

**Verification:**
- AKH passes its own immediate and observation-window gates, with no dependency
  on personal credentials or model settings.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| A full personal rebuild takes hours | Run as bounded durable work with progress, resume, and stale-count telemetry. |
| Semantic retrieval is enabled on a partial cohort | Fail closed until every eligible page and chunk matches the exact v2 identity. |
| Backup exists but cannot restore | Restore and validate before any live vector mutation. |
| AKH application credentials cannot create a clone | Require a separately provisioned administrative restore target; do not reuse personal infrastructure. |
| Provider/model changes during rebuild | Bind the effective configuration receipt at start and stop on drift. |

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-07-22-001-gbrain-knowledge-runtime-requirements.md`
- `docs/plans/2026-07-22-002-refactor-stabilize-managed-fork-plan.md`
- `docs/embedding-migrations.md`
- `docs/guides/fork-release-operations.md`
- `docs/operations/managed-fork-integration-report.md`
