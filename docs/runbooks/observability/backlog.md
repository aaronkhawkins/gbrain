# Runbook: Growing backlog

## Signals

- `gbrain_expected_work_backlog_items` above warn/fail thresholds
- Reasons: `backlog_warn`, `backlog_fail`
- Destash panel shows unembedded chunks, waiting jobs, or source queue depth

## Checks

1. Identify work key (`embedding.coverage`, `source.*`, minion name)
2. `gbrain sources status` for per-source embed coverage and queue depth
3. `gbrain jobs list` filtered to waiting/active/dead
4. Confirm workers are live (`gbrain jobs supervisor status`)

## Repair

- Drain embed backlog: `gbrain embed --stale` (consider `--pace` under pool pressure)
- Clear dead jobs after root-causing failures
- Destash is visibility-first: deletion/cleanup remains an explicit operator action

## Do not

- Auto-delete pages because they appear on the destash view
- Raise fail thresholds to silence a real stall
