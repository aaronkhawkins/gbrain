# Operational Observability Operator Guide (Phase 1A)

GBrain owns operational meaning. Prometheus only transports metrics; Grafana only displays them; alerts only apply hold periods and routing.

## What Phase 1A answers

- Is each configured brain reachable via its observer?
- Are registered sources healthy (commit-relative lag, queue depth, recent failures)?
- Did expected recurring Minion work and Dream phases complete inside cadence + grace?
- Are embeddings ready and identity-compatible?
- Which items need destashing attention?

Phase 1A does **not** prove semantic end-to-end retrieval (Phase 1C) and does **not** auto-repair.

## Architecture

```
per-brain: gbrain observe serve  →  /metrics (OpenMetrics)
                                    /healthz
central:   Prometheus scrapes over Tailscale
           Grafana fleet + detail dashboards
           Grafana-managed alerts → Mattermost
```

One observer process per `GBRAIN_HOME`. No universal credential spanning brains.

## Commands

```bash
# One-shot content-free snapshot
gbrain observe snapshot

# Long-running scrape target (probe-only DB; never migrates)
gbrain observe serve --bind <tailnet-ip> --port <port>

# Additive status section
gbrain status --section operational --json
```

## Configuration (file plane)

In `$GBRAIN_HOME/config.json`:

```json
{
  "observability": {
    "brain_id": "personal",
    "observer": {
      "bind": "100.x.y.z",
      "port": 9108,
      "refresh_ms": 30000,
      "collect_timeout_ms": 15000
    },
    "work": {
      "minion.autopilot-cycle.<source-id>": {
        "cadence_seconds": 3600,
        "grace_seconds": 900
      },
      "minion.maintain": {
        "cadence_seconds": 86400,
        "grace_seconds": 3600
      }
    },
    "external_work": [
      { "key": "legacy_processor", "required": false }
    ]
  }
}
```

- `brain_id` must match `[A-Za-z0-9._-]{1,64}` (opaque metric label).
- Source-scoped Minion work keys end in the registry's sanitized opaque source
  segment: `minion.<job-name>.<source-id>`. Overrides match the full generated
  key exactly. Global work such as `minion.maintain` has no source suffix.
- Every enabled native-intake target is discovered from its registered source
  policy and appears as `minion.ingest_capture.s_<opaque>`. Idle event-driven
  intake is healthy when its Minion evidence queries succeed. These rows flow
  through the existing generic item panels and alerts; no dashboard allowlist
  or per-adapter declaration is required.
- Only numeric loopback and Tailscale addresses (`100.64.0.0/10`,
  `fd7a:115c:a1e0::/48`) are accepted by default. Any other bind requires the
  explicit unsafe `allow_public_bind: true` override.
- `external_work` entries always report `unknown / instrumentation_missing` until Phase 1B receipts.
- Observer collection runs inside an enforced read-only database boundary.
  Pending or unreadable schema versions report `unknown / schema_incompatible`
  for database-backed work; the observer never applies migrations.

## launchd (macOS host)

Template: `ops/launchd/ai.gbrain.observer.plist.template`

1. Copy once per brain; substitute `{{GBRAIN_HOME}}`, `{{BIND}}`, `{{PORT}}`, etc.
2. Install under `~/Library/LaunchAgents/`.
3. `launchctl load` / `bootstrap`.
4. Confirm `curl -s http://$BIND:$PORT/healthz`.

## Metric families

| Metric | Meaning |
|---|---|
| `gbrain_observer_info` | Process identity |
| `gbrain_observer_snapshot_timestamp_seconds` | Snapshot generation time (staleness) |
| `gbrain_brain_state` | One-hot brain rollup |
| `gbrain_expected_work_info` | Bounded `kind`, `required`, `enabled`, and repair-runbook metadata |
| `gbrain_expected_work_state` | One-hot per work item |
| `gbrain_expected_work_*_timestamp_seconds` | Last attempt / success / next due |
| `gbrain_expected_work_backlog_items` | Backlog count |
| `gbrain_expected_work_oldest_pending_age_seconds` | Age of the oldest waiting/active/delayed item |
| `gbrain_expected_work_recent_failures` | Recent failures, or all currently unresolved failures for durable event-driven work |
| `gbrain_expected_work_reason` | One-hot reason code |

Labels are only bounded `brain`, `work`, `kind`, `required`, `enabled`,
`runbook`, `state`, `reason`, and `build` values — never URLs, source slugs,
payloads, or errors.

Operational agents with admin scope can call the input-free
`get_operational_snapshot` operation. It uses the same read-only builder and
bounded serializer as `gbrain observe snapshot`; the observer HTTP server
exposes only `/healthz` and `/metrics`.

## State semantics

| State | Meaning |
|---|---|
| healthy | Fresh success + backlog within policy |
| degraded | Inside grace, intermittent failures, or warn backlog |
| failed | Missed deadline, blocking failure, or fail backlog |
| unknown | Missing / unsupported evidence |
| disabled | Explicitly not expected |

Absence of evidence is **never** healthy.

## Repair runbooks

- [Observer missing / stale](../runbooks/observability/observer-missing.md)
- [Missed work](../runbooks/observability/missed-work.md)
- [Backlog](../runbooks/observability/backlog.md)
- [Embedding](../runbooks/observability/embedding.md)

## External monitoring deployment

Prometheus scrape targets, Grafana dashboards, and Mattermost alert routing
live in the deployment-local observability repository. Deploy those
independently after observers are listening.
