# Phase 1B Processing Inventory

This inventory decides which recurring paths need the generic processing
receipt. It deliberately reuses native GBrain evidence whenever that evidence
already proves the work.

| Recurring capability | GBrain owner | Existing durable evidence | Phase 1B action |
|---|---|---|---|
| Repository/source synchronization | Intake source + autopilot | source checkpoint and ingestion log | Reuse; no processing receipt |
| Core extraction, facts, embeddings, graph, and schema-pack phases | Dream | Dream phase results and domain rollups | Reuse; no processing receipt |
| Durable asynchronous work | Minions | Minion job state, attempts, and completion | Reuse; no processing receipt |
| Bookmark collection from the upstream service | External collector | None before GBrain receives the files | Register one collector receipt |
| Bookmark atom and concept enrichment | Dream creator phases | Dream phase results | Retire the legacy external analysis/synthesis path |
| Media-link discovery/materialization | External multi-step processor | Partial filesystem state only | Register one processor receipt until moved into a native pass |
| Media transcription | External worker/orchestrator | External result files only | Register one processor receipt and retain external queue semantics |
| Coding-session export | External collector | Source checkpoint proves only received files | Register a collector receipt in the next adapter batch |
| Assistant-session export | External collector | Source checkpoint proves only received files | Register a collector receipt in the next adapter batch |
| Mail archive pilot | Bounded, unscheduled pilot | Pilot report | Do not register or schedule until pilot approval |

## Duplicate work to retire

- The legacy nightly script duplicates native Dream execution and must be
  disabled after the creator-capable schema pack is active and its phases
  complete successfully.
- The legacy bookmark analysis and synthesis steps remain disabled in the live
  collector. Native creator Dream phases own those transformations.
- A separate scheduled source-sync process is redundant where that same brain's
  autopilot already schedules the source. Remove it only after the isolated
  autopilot service is verified.

## Runtime boundary

GBrain owns intake/source identity, Dream coordination, Minion durability,
processing receipts, evaluation, and operational meaning. External schedulers
may trigger a collector or platform-specific worker, but they do not infer
health. Prometheus and Grafana display GBrain's content-free snapshot.
