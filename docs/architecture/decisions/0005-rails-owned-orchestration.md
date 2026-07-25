# ADR 0005: PersonalOS Rails owns pipeline scheduling and orchestration

- **Date:** 2026-07-24
- **Decision:** Accepted
- **Supersedes:** The n8n-as-parent-orchestrator clause in ADR 0001

## Context

ADR 0001 named n8n the initial parent orchestrator because it was already deployed.
Since then, scheduled pipelines have failed silently for days because their schedules, execution history, and operator notifications had no single owner.
The workflows are predominantly linear poll, transform, and deliver flows.
A separate visual orchestrator adds another control surface without solving the missing self-reporting and dead-man responsibilities.

PersonalOS now exists as a Rails control plane that already needs a durable ledger, recurring watchdog work, an operator API, and application-level alerting.
Splitting scheduling from that state would preserve the failure mode the control plane exists to remove.

## Decision

The PersonalOS Rails application owns pipeline scheduling and orchestration.
Solid Queue provides recurring and asynchronous execution on the always-on Mac.
Pipelines migrate one executable component at a time, and exactly one scheduler is authoritative for a component during cutover.

n8n remains installed as a consulting and workflow-prototyping sandbox, but it is not part of the production critical path.

Instrumentation precedes migration.
Existing pipelines first report heartbeats and runs without changing their behavior, and scheduling ownership changes only after that reporting and alerting path is working.

Everything else in ADR 0001 stands.
The parent workflow remains portable across knowledge sinks, GBrain keeps post-admission enrichment, and the workflow contract does not depend on any scheduler's private execution tables.

## Consequences

- Scheduling, run state, watchdog expectations, and alerts have one owner.
- The Rails application and jobs are independently monitored so a live web process cannot conceal a dead scheduler.
- Each cutover has a simple rollback: re-enable the previous scheduler, keep reporting in place, and fix forward.
- PersonalOS stays a small operator control plane rather than becoming a general-purpose workflow engine.
- A future scheduler replacement must preserve the reporting API and ledger contracts rather than expose its private execution tables as the contract.

## Rejected alternatives

### Keep n8n as the parent orchestrator

This retains visual inspection but leaves scheduling and health split across systems, weakening the silent-failure fix.

### Use a hybrid scheduler indefinitely

A temporary one-component-at-a-time cutover is required, but permanent shared ownership makes missed schedules and duplicate execution harder to diagnose.
