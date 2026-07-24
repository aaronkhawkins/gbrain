# Runbook: Growing backlog

## Signals

- `gbrain_expected_work_backlog_items` above warn/fail thresholds
- `gbrain_expected_work_oldest_pending_age_seconds` shows stalled work age
- Reasons: `backlog_warn`, `backlog_fail`, `stalled`, `dead`, `recent_failures`
- Destash panel shows unembedded chunks, waiting jobs, or source queue depth
- Native-intake targets use `minion.ingest_capture.s_<opaque>`; the suffix is
  intentionally not a raw source identity

## Checks

1. Identify work key (`embedding.coverage`, `source.*`, minion name)
2. `gbrain sources status` for per-source embed coverage and queue depth
3. `gbrain jobs list` filtered to waiting/active/failed/dead; for native intake,
   keep the opaque dashboard key in the incident record and inspect job details
   only in the protected local CLI
4. Confirm workers are live (`gbrain jobs supervisor status`)

## Repair

- Drain embed backlog: `gbrain embed --stale` (consider `--pace` under pool pressure)
- After root-causing a native-intake failure, retry the specific job id.
  Completing that retry clears only its own failure; verify other unresolved failures
  remain visible before resolving the alert.
- Destash is visibility-first: deletion/cleanup remains an explicit operator action

## Do not

- Auto-delete pages because they appear on the destash view
- Raise fail thresholds to silence a real stall
