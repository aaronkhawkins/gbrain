# Runbook: Media transcription

## Signals

- Work key `minion.media_transcription.s_<opaque>` is degraded or failed
- Reason `backlog_warn`, `backlog_fail`, `recent_failures`, `stalled`, or `dead`
- `gbrain_expected_work_recent_failures` stays non-zero after newer jobs succeed
- New BirdClaw media is not reaching a terminal Minion state

The source suffix is intentionally opaque. Keep it in incident records; resolve
the real target only through the protected local configuration and CLI.

## Checks

1. Confirm the existing worker is alive:
   `gbrain jobs supervisor status --json`.
2. Confirm all three trusted worker settings are present in the worker process:
   `GBRAIN_MEDIA_TRANSCRIPTION_CLI`,
   `GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT`, and
   `GBRAIN_MEDIA_TRANSCRIPTION_TARGET_SOURCE_ID`. Do not paste their values
   into tickets, dashboards, or chat.
3. Check configuration without touching the CLI binary or artifact root:
   `gbrain jobs media-transcription status`.
4. Inspect a known job through the protected, content-free view:
   `gbrain jobs media-transcription status JOB_ID`.
5. Use the generic bounded queue list for each state (the rows contain names
   but not media payloads):
   `gbrain jobs list --status waiting --limit 100 | rg '\bmedia_transcription\b'`,
   `gbrain jobs list --status active --limit 100 | rg '\bmedia_transcription\b'`,
   `gbrain jobs list --status failed --limit 100 | rg '\bmedia_transcription\b'`,
   and
   `gbrain jobs list --status dead --limit 100 | rg '\bmedia_transcription\b'`.
   These commands filter bounded rows locally for the exact job name;
   preserve the job id and content-free error code from the protected status
   command. Do not use `gbrain jobs get`, which includes the job payload.
6. For `artifact_missing`, `hash_mismatch`, or `input_changed`, verify the
   acquired artifact and its recorded lineage before retrying. Do not redirect
   the adapter to the legacy queue.
7. For transient runtime failures, verify the deployed #39 CLI and Parakeet
   runtime are reachable from the worker account.

## Repair

- Correct worker configuration, permissions, or runtime availability, then
  restart the existing `gbrain jobs supervisor` service. Do not start a second
  transcription daemon.
- Retry only the affected durable Minion job after the cause is fixed. A
  successful retry clears that job's failure; other unresolved failed/dead
  jobs intentionally remain visible.
- If backlog exceeds the fail threshold, reduce submission rate or increase
  the existing worker's safe concurrency only after confirming the
  transcription host has capacity.

## Cutover and rollback

Use one manually seeded canary before moving production submissions. Confirm it
completes through `media_transcription`, its duplicate submission resolves to
the same durable job, and the observer row is healthy. Only then disable the
legacy scheduled dispatcher and its legacy `processor.media.transcription`
receipt in the deployment that owns them.

To roll back, stop new native submissions and restore the legacy dispatcher.
Leave Minion job rows intact for diagnosis; do not scan, copy, or delete the
legacy filesystem queue from GBrain.

## Do not

- Add a second queue, retry loop, scheduler, receipt, or Mattermost notifier
- Point `GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT` at a shared or multi-writer
  directory. The locator check assumes this is a trusted, single-writer
  artifact root; it deliberately does not pass an open descriptor across the
  local CLI process boundary.
- Treat an empty event-driven queue as missing evidence
- Clear alerts by deleting failed/dead jobs or raising thresholds
- Expose paths, media ids, URLs, transcript text, hashes, or raw stderr in
  observer output
