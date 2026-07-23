# Phase 1A Observability Acceptance

Content-free acceptance checklist. Do not paste knowledge bodies, credentials, source URLs, or raw job payloads into this file or any ticket that links here.

## Preconditions

- [x] Personal observer running with its own `GBRAIN_HOME`, bind, and port
- [x] Second-brain observer running with a separate `GBRAIN_HOME`, bind, and port
- [x] Prometheus on the observability host scrapes both targets over Tailscale
- [x] Grafana fleet dashboard provisioned
- [x] Mattermost observability contact point already exists (no new credential in Phase 1A)

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

## Live acceptance

- [x] Both observers are present and current
- [x] No cross-brain credential or metrics bleed
- [x] Every expected recurring activity is either observed or explicitly `instrumentation_missing`
- [x] No protected material in metrics, dashboards, or alerts

## Acceptance evidence

- On 2026-07-23, both native observers returned `ok: true` with distinct
  opaque brain identities and current snapshots.
- Prometheus reported both `gbrain-observer` targets as `UP` and both
  `gbrain_brain_state_code` series as `0` (`healthy`).
- Grafana and Prometheus were healthy after the final deployment, and the
  provisioned dashboard and alert contract suite passed all 17 checks.
- The content-free metrics scan found no credential, connection-string,
  protected-content, or JWT-shaped values.
- A live `observability-delivery-canary` drill became active at
  2026-07-23T19:35:28Z. Grafana sent one firing notification through the
  existing notifier. After restoring the normal disabled configuration,
  Grafana sent the resolved notification at 2026-07-23T19:37:28Z and the
  active canary set returned empty.
- The live acceptance check exposed and corrected a deployment-local routing
  error where the personal launchd wrapper named the AKH repository. The
  personal and AKH autopilots now use their intended repositories and both
  brains returned healthy before sign-off.
- The personal facts migration was replayed against only its six clean target
  pages, fencing eight legacy facts while preserving unrelated repository
  changes. A deployed `extract_facts` run then completed successfully and
  reported the brain healthy.

## Sign-off

| Field | Value |
|---|---|
| Date | 2026-07-23 |
| Operator | Aaron / Codex |
| Personal observer version | GBrain 0.42.64.1 / `phase-1a-observability-2026-07-23` |
| Second-brain observer version | GBrain 0.42.64.1 / `phase-1a-observability-2026-07-23` |
| Residual instrumentation follow-ups | `runtime.autopilot-install-isolation` |

Phase 1A does **not** claim semantic end-to-end canary proof. That remains Phase 1C.
