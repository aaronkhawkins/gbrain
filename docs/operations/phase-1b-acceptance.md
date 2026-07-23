# Phase 1B Acceptance

Date: 2026-07-23

## Ownership verified

- GBrain sources and autopilot own repository intake checkpoints and sync.
- The active personal `gbrain-everything` pack owns `extract_atoms` and
  `synthesize_concepts`; BirdClaw runs collector-only and does not run either
  enrichment path.
- Native Minion job evidence remains authoritative for durable asynchronous
  GBrain work. Processing receipts are used only for work that begins outside
  GBrain.
- `bookmark.collector` and `media.transcription` are registered dynamically in
  the personal brain. The AKH brain does not inherit those registrations.
- Prometheus and Grafana display GBrain's content-free state and do not infer
  processor health.

## Deployment

- Managed fork: Phase 1B implementation on `master`
- Processing adapters: `53c2fce` on `master`
- Personal and AKH databases: schema version 129
- Personal schema pack: `gbrain-everything`
- AKH autopilot: isolated launchd service with an explicit AKH `GBRAIN_HOME`
- n8n workflow `Personal GBrain — X Video Transcription`: active, 2,400-second
  workflow timeout, both SSH paths call `run-observed-transcription.sh`
- Grafana: `https://grafana.akh.software/d/gbrain-operations`

## Duplicate work retired

- The standalone AKH repository-sync launch agent is disabled after the scoped
  AKH autopilot was observed running.
- BirdClaw's legacy analysis and synthesis path remains disabled through
  `--collector-only`.
- Concept synthesis checks evidence fingerprints before model invocation and
  changes at most 100 concept groups per cycle. Unchanged groups do not consume
  the batch, so the first creator-pack adoption can converge without blocking
  the collector's next cadence.
- The legacy personal nightly Dream launch agent is disabled. Native
  `autopilot-cycle` and `autopilot-global-maintenance` Minion receipts completed
  under the active pack.
- Take proposal enrichment skips derived `atom`, `concept`, `media`, `source`,
  and extraction-receipt pages so generated knowledge is not recursively sent
  through another LLM pass.
- Source sync cannot relabel an existing vector when it carries no replacement
  embedding, and embeddings without an explicit model use the active gateway
  model rather than a compile-time provider default.

## Verification

- Focused processing/autopilot tests: 13 passed.
- Focused Dream synthesis tests: 38 passed.
- Managed-fork verification: 31 of 31 checks passed.
- Focused provenance, processing-receipt, and take-proposal tests: 46 passed.
- BirdClaw adapter suite: 43 passed.
- n8n restarted healthy after workflow import and publication.
- BirdClaw launched with its production launchd PATH, recorded a current
  partial receipt, and retained successful intake while honestly surfacing
  recoverable no-audio X videos.
- A transcription failure was recorded honestly, and its successful ASR result
  remained durable when publication detected concurrent brain changes.
- A subsequent observed transcription cycle completed through Parakeet.
- Personal was fully re-embedded with Nemotron; AKH was already Nemotron-only.
  Retrieval identity is enforced so mixed vector provenance becomes visible.
- Link and timeline extraction was replayed. Link-backlog alert thresholds are
  sized to each brain instead of treating a fixed 500-page count as a fleet
  failure regardless of brain size.

## Rollback

- Re-enable the retained legacy launchd plists only if the corresponding native
  owner is first stopped.
- Point BirdClaw back to `run-pipeline.sh --collector-only` and n8n back to
  `run-transcription-cycle.sh` to remove receipt instrumentation without
  deleting receipt history.
- Revert the managed-fork or adapter commits normally; migrations 127-129 are
  additive and may remain.

## Post-deploy monitoring and validation

- Dashboard: watch the personal and AKH fleet tiles plus `content_processor`
  rows on the GBrain Operations dashboard.
- Healthy signals: both observers up, both autopilots loaded/running,
  source/Dream/Minion items current, and fresh completed collector/transcription
  receipts.
- Failure signals: `recent_failures`, stale running receipts, missed cadence,
  dead/stalled Minions, observer absence, or embedding mismatch.
- Mitigation: use `gbrain processing repair plan --key <processor>` for a
  content-free diagnosis. Automatic repair dispatch remains intentionally
  unavailable until a real production Minion handler exists.
- Validation window: immediate cutover checks in this record; normal Grafana
  alert hold periods own continuing validation.
