# Phase 1A Observability Acceptance

Content-free acceptance checklist. Do not paste knowledge bodies, credentials, source URLs, or raw job payloads into this file or any ticket that links here.

## Preconditions

- [ ] Personal observer running with its own `GBRAIN_HOME`, bind, and port
- [ ] Second-brain observer running with a separate `GBRAIN_HOME`, bind, and port
- [ ] Prometheus on the observability host scrapes both targets over Tailscale
- [ ] Grafana fleet dashboard provisioned
- [ ] Mattermost observability contact point already exists (no new credential in Phase 1A)

## Smoke

1. `curl -s http://$PERSONAL_BIND:$PORT/healthz` → `ok: true`, opaque brain id
2. `curl -s http://$SECOND_BRAIN_BIND:$PORT/healthz` → different brain id
3. Prometheus targets: both **UP**
4. Grafana fleet view: both brains visible with item rows
5. Content scan of `/metrics` for each observer: no `postgres://`, passwords, API keys, JWT-like strings

## Failure demonstrations (safe)

| Action | Expected |
|---|---|
| Stop personal observer only | Personal target DOWN; second brain remains visible |
| Seed / wait for a failed required test job (or pause a safe schedule) | Work item → failed/degraded; one Mattermost alert after hold |
| Restore success | Alert resolves; dashboard returns healthy/degraded honestly |
| Restart Prometheus or Grafana | Dashboard shows last known / stale without inventing healthy |

## 24-hour observation

- [ ] No unexplained missing observer
- [ ] No cross-brain credential or metrics bleed
- [ ] Every expected recurring activity is either observed or explicitly `instrumentation_missing`
- [ ] No protected material in metrics, dashboards, or alerts

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Operator | |
| Personal observer version | |
| Second-brain observer version | |
| Residual instrumentation follow-ups | (list work keys only) |

Phase 1A does **not** claim semantic end-to-end canary proof. That remains Phase 1C.
