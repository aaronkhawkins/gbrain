---
title: "refactor: Rebuild managed embedding cohorts"
type: refactor
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-001-gbrain-knowledge-runtime-requirements.md
---

# refactor: Rebuild managed embedding cohorts

## Summary

Rebuild the personal and AKH Software text-embedding projections from canonical
knowledge using the shared local Nemotron text model while preserving each
brain's independent credentials, database, configuration, and source
boundaries. Rehearse the complete migration on restored Postgres copies before
changing either live embedding cohort, then cut over and verify the brains
sequentially.

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
- R4. Standardize every brain's text-semantic embedding surfaces on
  `nvidia-nim:nvidia/nemotron-3-embed-1b`, 2048 dimensions, and the compatible
  preprocessing/storage identity; never relabel an existing vector.
- R5. Keep lexical retrieval available during a rebuild and enable semantic
  ranking only after the complete cohort passes identity checks.
- R6. Prove semantic retrieval with held queries where the expected vector
  branch contributes the winning result, not cache or lexical fallback.
- R7. Preserve pre-migration artifacts and a tested rollback coordinate until
  the observation window closes.
- R8. Apply the Nemotron text-embedding standard to future employment and
  confidential-service brain provisioning without weakening their independent
  database and access boundaries.

---

## Scope Boundaries

- Do not merge the personal and company databases or expose one brain's
  credentials, source identities, or content to the other.
- Do not delete or normalize canonical knowledge to improve embedding metrics.
- Do not resume broad Dream or backlog work during clone rehearsal or cutover.
- Do not route image or multimodal vectors through the text-only Nemotron
  model; their 1024-dimensional columns remain owned by the vision embedding
  route.

---

## Key Technical Decisions

- Treat vectors and page embedding signatures as disposable derived state, but
  retain all non-vector database state because it contains durable runtime and
  provenance history not fully represented by repository files.
- Rehearse against restored Postgres databases rather than a PGLite surrogate;
  vector types, HNSW indexes, RLS, triggers, and migration behavior are
  engine-specific.
- Process personal first and AKH only after personal acceptance. AKH changes
  from mixed 768/1536-dimensional text spaces to Nemotron 2048, but its smaller
  corpus does not justify weakening its independent security and restore gates.
- Standardize page chunks, facts, takes, and query-cache vectors; leave
  image/multimodal columns outside this text-model migration.
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

**Goal:** Migrate every AKH text embedding surface from its mixed legacy widths
to the shared Nemotron 2048-dimensional identity.

**Requirements:** R1-R7

**Dependencies:** U3 acceptance, AKH administrative restore target

**Files:**
- Modify: `docs/operations/managed-fork-integration-report.md`

**Approach:**
- Repeat U1-U3 with AKH-specific credentials, backup, restored target,
  configuration receipt, source scope, and semantic query set.
- Clear text-derived vectors, change compatible text columns and HNSW indexes
  to the Nemotron 2048-dimensional storage identity, update the AKH embedding
  configuration, and recompute rather than cast or relabel vectors.
- Preserve the separate image/multimodal columns and their model identity.

**Test scenarios:**
- Happy path: the independent AKH clone and live cohort rebuild every text
  surface with Nemotron 2048 while image/multimodal column definitions remain
  unchanged.
- Error path: lack of restore-target privileges, route drift, source leakage,
  or mixed embedding identity blocks company cutover.
- Security: no personal configuration or corpus data appears in AKH receipts,
  jobs, or retrieval results.

**Verification:**
- AKH passes its own immediate and observation-window gates, with no dependency
  on personal credentials or corpus data.

- U5. **Make Nemotron the future brain text-embedding default**

**Goal:** Ensure employment, confidential-service, and later hard-boundary
brains start with the same local text-embedding capability instead of drifting
back to paid or mixed providers.

**Requirements:** R3, R4, R8

**Dependencies:** U4

**Files:**
- Modify: `docs/architecture/brains-and-sources.md`
- Modify: `docs/guides/fork-release-operations.md`

**Approach:**
- Document Nemotron 2048 as the managed provisioning default for text
  embeddings while requiring a unique database, credentials, configuration,
  and receipt set per brain.
- Keep model selection explicit in each brain's configuration so a shared
  runtime does not become a shared data boundary.

**Test scenarios:**
- Happy path: a new isolated brain initializes every text-semantic column with
  the managed Nemotron identity.
- Security: provisioning a new brain neither reuses another brain's database
  credentials nor grants cross-brain source access.
- Edge case: an unavailable Nemotron endpoint leaves the new brain lexical-only
  rather than silently falling back to a different embedding space.

**Verification:**
- Provisioning guidance and checks reject mixed text-embedding identities while
  preserving separate vision embedding configuration.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| A full personal rebuild takes hours | Run as bounded durable work with progress, resume, and stale-count telemetry. |
| Semantic retrieval is enabled on a partial cohort | Fail closed until every eligible page and chunk matches the exact v2 identity. |
| Backup exists but cannot restore | Restore and validate before any live vector mutation. |
| AKH application credentials cannot create a clone | Require a separately provisioned administrative restore target; do not reuse personal infrastructure. |
| A text column retains its old 768/1536 width | Inventory every vector column and fail cutover until chunks, facts, takes, and query cache share the accepted Nemotron identity. |
| Provider/model changes during rebuild | Bind the effective configuration receipt at start and stop on drift. |

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-07-22-001-gbrain-knowledge-runtime-requirements.md`
- `docs/plans/2026-07-22-002-refactor-stabilize-managed-fork-plan.md`
- `docs/embedding-migrations.md`
- `docs/guides/fork-release-operations.md`
- `docs/operations/managed-fork-integration-report.md`
