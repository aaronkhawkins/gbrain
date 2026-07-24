# Runbook: Missed expected work

## Signals

- `gbrain_expected_work_state{state="failed|degraded"}` for a work key
- Reasons: `missed_cadence`, `within_grace`, `recent_failures`, `stalled`, `dead`, `instrumentation_missing`

## Checks

1. Note the opaque `work` label (e.g. `minion.autopilot-cycle`, `dream.extract_atoms`)
2. `gbrain status --section operational --json` or `gbrain observe snapshot`
3. `gbrain jobs list` / `gbrain jobs supervisor status` for Minion items
4. `gbrain status --section cycle` for Dream cycle recency
5. If reason is `instrumentation_missing`: the process has no durable GBrain receipt — file a Phase 1B instrumentation task; do not invent healthy

## Repair

- Re-run the owning cycle/job when safe (`gbrain dream`, `gbrain jobs submit …`)
- For `minion.ingest_capture.s_<opaque>`, follow the backlog runbook and retry
  only the failed job. Newer successful intake does not resolve an older
  failed/dead row.
- Fix handler crashes from supervisor audit, not from Grafana
- Adjust cadence/grace only via `observability.work` overrides when the schedule intentionally changed

## Do not

- Collapse multiple work items into one “pipeline healthy” judgment
- Use Doctor category scores as operational truth
