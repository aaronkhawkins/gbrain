---
date: 2026-07-23
topic: phase-1b-processing-receipts-and-assisted-repair
origin: docs/plans/2026-07-23-001-feat-establish-operational-truth-plan.md
status: ready
---

# Phase 1B — Processing Receipts and Assisted Repair

## Outcome

Every recurring GBrain enhancement that cannot already prove its work through a
source checkpoint, Dream phase, Minion job, embedding receipt, or retrieval
receipt has one generic durable processing receipt. The Phase 1A observer,
dashboard, and alerts discover those registrations without processor-specific
logic. When work needs attention, GBrain can propose and explicitly dispatch a
bounded repair through its existing durable job system.

This plan does not build a second workflow engine. Dream remains the
coordinator, Minions remain the durable execution substrate, and GBrain remains
the owner of operational meaning. Grafana displays state; it does not infer it.

## Scope

Included:

- A generic registration and receipt contract for external or multi-step
  processors that have no existing durable GBrain evidence.
- Migration of current personal-brain integrations onto that contract,
  beginning with the X/BirdClaw media path as a reference implementation.
- Automatic observer and dashboard discovery of registered processors.
- Content-free failure, backlog, and next-action reporting.
- Explicit, bounded repair dispatch for already-supported idempotent Minion
  work.
- Multi-brain autopilot installation isolation so managing one brain cannot
  overwrite another brain's service wrapper.

Deferred:

- Intake normalization, dead-letter design, and processor chaining owned by
  roadmap Phase 2.
- The full first-class enrichment-pass lifecycle owned by roadmap Phase 3.
- Automatic deletion, unreviewed content promotion, arbitrary shell repair, or
  self-healing policy.
- Synthetic semantic transactions and fault injection owned by Phase 1C.

## Contract

A registered processor declares only bounded operational metadata:

- stable key and version
- owning source or posture
- cadence, grace, and criticality
- receipt kind and expected completion evidence
- optional backlog evidence
- supported repair job name
- runbook key

A receipt records:

- processor key and version
- opaque source/scope identity
- input fingerprint
- attempt and completion timestamps
- bounded outcome (`completed`, `partial`, `failed`, `skipped`)
- bounded counts and reason code
- lineage identifiers needed to find the owning GBrain evidence

Receipts never contain page bodies, URLs, prompts, model responses, credentials,
or raw errors.

## Implementation units

### 1B.0 — Inventory and isolate deployed work

**Goal:** Establish the exact current paths and close the discovered
multi-brain service-installation hazard before adding a new persistence
contract.

**Work:**

- Inventory each recurring personal and second-brain process and map it to its existing
  source, Dream, Minion, embedding, retrieval, or missing evidence.
- Record only missing-evidence paths as receipt candidates.
- Make autopilot installation artifacts brain-scoped, including wrapper,
  label, logs, and uninstall behavior; add an isolation regression test.
- Verify the existing personal and second-brain launchd services remain independently
  restartable.

**Done when:** No deployed process is double-counted, and installing or
reinstalling one brain's autopilot cannot alter the other brain's service.

### 1B.1 — Add the generic processing receipt

**Goal:** Give missing-evidence processors one durable, idempotent GBrain
contract.

**Work:**

- Add the smallest database schema and service API for registrations and
  append/update-safe receipts.
- Enforce stable bounded identifiers, input fingerprints, versioning, and
  content-free result fields.
- Define retry and replay semantics without introducing a new queue.
- Add unit and focused real-Postgres tests; do not run the full memory-heavy
  E2E suite by default.

**Done when:** A fixture processor can register, start, complete, fail, retry,
and replay without duplicate success receipts or protected data.

### 1B.2 — Instrument current processor paths

**Goal:** Prove the contract against real workflows without baking their names
into GBrain core.

**Order:**

1. X/BirdClaw bookmark discovery and media-link expansion.
2. Media materialization and transcription.
3. MsgVault email intake pilot.
4. Any remaining deployed custom processor identified by 1B.0.

Each integration owns its adapter in its plugin or integration package. It
submits durable work to Minions where asynchronous execution is needed and
writes the generic receipt at the GBrain boundary.

**Done when:** Each enabled path either has a current receipt or is visibly
`instrumentation_missing`; no dashboard or observer code mentions BirdClaw,
MsgVault, or a media provider.

### 1B.3 — Discover and observe receipts

**Goal:** Extend Phase 1A automatically for every registered processor.

**Work:**

- Add one generic receipt collector to expected-work discovery.
- Reuse the existing state evaluator, OpenMetrics families, fleet dashboard,
  alert policies, and runbooks.
- Show last success, next due, backlog, version, and bounded reason.
- Preserve per-brain credentials and content-free telemetry.

**Done when:** Registering a fixture processor makes it appear without Grafana
changes, and a missed/failed receipt produces and resolves the existing bounded
alert path.

### 1B.4 — Add explicit assisted repair

**Goal:** Turn a visible problem into a safe operator action without creating an
autonomous repair agent.

**Work:**

- Map bounded reason codes to a runbook and, where supported, one idempotent
  Minion job.
- Add a read-only repair plan command and a separate explicit dispatch command.
- Require brain scope, expected-work key, confirmation, and an audit receipt.
- Reject arbitrary commands, deletion, cross-brain credentials, and repair
  types without a registered handler.

**Done when:** A failed fixture can be inspected, explicitly requeued, observed
through completion, and audited without direct database edits.

### 1B.5 — Live cutover and acceptance

**Goal:** Put the generic contract into normal use without an observation-window
gate.

**Work:**

- Deploy schema and runtime changes to personal first, then the second brain if
  it has registered processors.
- Run one safe processor failure/recovery drill.
- Confirm both brains remain healthy and isolated.
- Record any remaining missing-evidence work keys for the next adapter batch.

**Done when:** Current registered processors are visible, alerts recover, repair
dispatch is bounded, telemetry scans clean, and the Phase 1A dashboard requires
no processor-specific edits.

## Sequence and parallelism

1B.0 and the design/test fixtures for 1B.1 may proceed in parallel. 1B.1 must
land before integration adapters. After the first reference adapter proves the
contract, the remaining 1B.2 adapters can proceed independently. 1B.3 follows
the stable receipt schema. 1B.4 follows the observer state and repair mapping.
1B.5 is the final live cutover.

## Verification

- Focused typecheck, repository guards, receipt unit tests, and one
  real-Postgres receipt test.
- Integration-owned adapter tests for idempotency, retry, and protected-content
  rejection.
- Existing observer, OpenMetrics, dashboard, and alert contract suites.
- Live personal-first failure/recovery and explicit-repair drill.
- Metrics, alerts, logs, and receipts scanned for protected material.

## Decision gate

Phase 1B may begin from this plan. Before 1B.1 schema work, 1B.0 must produce the
receipt-candidate inventory so an existing GBrain receipt is reused whenever it
already proves the work.
