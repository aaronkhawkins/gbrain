# Upstream Sync Ledger

Standing ledger for the managed fork's upstream absorption decisions.
Content-free: refs, versions, disposition labels, and test paths only.

**Policy guide:** [Upstream Sync Cadence](../guides/upstream-sync-cadence.md)
**Phase 0 closure report:** [Managed Fork Integration Report](managed-fork-integration-report.md)
**Release ops:** [Fork Release Operations](../guides/fork-release-operations.md)

## Contract (summary)

| Rule | Bound |
|---|---|
| Fixed review cadence | every **7** days (or at a phase boundary) |
| Max unreviewed calendar drift | **30** days |
| Max unreviewed upstream releases | **2** |
| Mid-slice sync | **blocking only** |
| Verification | memory-bounded: `typecheck` + `bun run verify` + focused tests |

Dispositions every review must use:

- `adopted` — absorbed into the fork at this review
- `deferred` — intentionally left out until a later boundary
- `conflicting` — semantic overlap requiring a behavior-ledger row before absorb
- `blocking` — forces a mid-slice exception when feature work is active
- `no-op` — reviewed and requires no fork change

## How to update

1. Only open an absorb merge at a **phase boundary**, on the **fixed cadence**
   when no feature slice is active, or under a documented **blocking exception**.
2. Append a human review section below.
3. Update the machine JSON block so
   `bun scripts/upstream-sync-cadence.ts validate --ledger docs/operations/upstream-sync-ledger.md`
   stays green.
4. Record memory-bounded verification evidence (paths only).

## Human review log

### 2026-07-23 — phase-boundary (Phase 0 close)

- Fork head at close: managed-fork baseline `0.42.64.1`
- Upstream pin: `origin/master@bb5a66942d7a7b0992f94fc59b4710c8e30b1830` (`0.42.64.0`)
- Trigger: phase-boundary
- Mid-slice: no
- Verification: typecheck, `bun run verify`, focused unit cohort, changed
  real-Postgres/compiled E2E paths (see integration report; memory-bounded)

| change_id | disposition | note |
|---|---|---|
| phase-0-U2..U8 | adopted | Baseline merge + policy restore closed at repository boundary |
| post-pin-upstream | deferred | Absorb only at later phase boundaries or fixed cadence |

## Machine ledger

```json
{
  "schema_version": 1,
  "bounds": {
    "maxUnreviewedReleases": 2,
    "maxUnreviewedDays": 30,
    "reviewIntervalDays": 7
  },
  "active_feature_slice": "phase-2a",
  "upstream_pin": "origin/master@bb5a66942d7a7b0992f94fc59b4710c8e30b1830",
  "upstream_version_at_pin": "0.42.64.0",
  "last_reviewed_at": "2026-07-23",
  "reviews": [
    {
      "id": "phase-0-close-2026-07-23",
      "reviewed_at": "2026-07-23",
      "trigger": "phase-boundary",
      "fork_head": "0.42.64.1",
      "upstream_pin": "origin/master@bb5a66942d7a7b0992f94fc59b4710c8e30b1830",
      "upstream_head": "origin/master@bb5a66942d7a7b0992f94fc59b4710c8e30b1830",
      "dispositions": [
        {
          "change_id": "phase-0-U2..U8",
          "disposition": "adopted",
          "note": "repository-boundary Phase 0 close"
        },
        {
          "change_id": "post-pin-upstream",
          "disposition": "deferred",
          "note": "hold until next phase boundary or idle fixed-cadence review"
        }
      ],
      "verification": {
        "typecheck": true,
        "verify": true,
        "memory_bounded": true,
        "focused_tests": [
          "test/build-identity.test.ts",
          "test/build-fork-release.test.ts",
          "test/verify-managed-fork-release.test.ts"
        ]
      }
    }
  ]
}
```
