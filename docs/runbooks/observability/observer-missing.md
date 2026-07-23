# Runbook: Observer missing or stale

## Signals

- Prometheus target DOWN for a brain scrape job
- `gbrain_observer_snapshot_timestamp_seconds` not advancing
- Brain state `unknown` with reason `db_unreachable`, `collector_timeout`, or `schema_incompatible`

## Checks

1. Is the launchd/systemd unit loaded for that brain only?
2. `curl -s http://$BIND:$PORT/healthz`
3. `GBRAIN_HOME=$THAT_BRAIN gbrain observe snapshot` (local)
4. `gbrain doctor` on that brain for connectivity / migrations
5. Confirm bind is the private Tailscale address, not a public wildcard

## Repair

- Restart the observer unit for **that** brain only
- If schema pending: `gbrain apply-migrations --yes` from an operator shell (observer never migrates)
- If DB unreachable: fix network / credentials in that brain's `GBRAIN_HOME` only

## Do not

- Share one observer credential across hard-boundary brains
- Mark the brain healthy because HTTP 200 returned once without a fresh snapshot timestamp
