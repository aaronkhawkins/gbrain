# ADR 0002: Use a neutral ledger for end-to-end workflow state

- **Date:** 2026-07-24
- **Decision:** Accepted

## Context

Operational state is currently distributed among n8n execution history, filesystem queues, GBrain processing receipts, model traces, logs, notifications, and generated knowledge.
None is sufficient to answer where an arbitrary source item is, what outcome it produced, or whether it became searchable.

n8n execution storage is optimized for operating n8n and may be pruned.
GBrain Minion state and request logs are runtime infrastructure rather than portable workflow history.
Raw source systems and GBrain remain authoritative for their respective content, so copying content into another store would create privacy and consistency problems.

## Decision

One neutral ledger will be authoritative for workflow identity, correlation, stage, decisions, attempts, failures, handoff receipts, and outcomes across all sources and brains.
It will retain references, hashes, versions, timestamps, classifications, targets, trace identifiers, and resulting artifact references.
It will not retain raw message bodies, media, documents, transcripts when those remain authoritative elsewhere, or binary attachments.

The ledger will distinguish at least two end-to-end milestones:

- `delivered`: a knowledge sink accepted the portable evidence.
- `knowledge_ready`: the required knowledge processing completed and the result is searchable.

The ledger is not a workflow engine, source archive, knowledge store, or model-trace store.

## Consequences

- The operator receives one end-to-end view across otherwise separate systems.
- Successful acquisition or transcription does not repeat when later knowledge enrichment fails.
- Workflow history survives an orchestrator or knowledge-sink replacement.
- The ledger contains cross-domain operational metadata and therefore requires protection even though it contains no raw source content.
- Participating systems need stable correlation identifiers and receipts.

## Rejected Alternatives

### Use n8n execution history as the ledger

This is initially smaller but couples durable status to n8n retention, internal schemas, and workflow versions.

### Keep a ledger in every brain

This preserves domain isolation but prevents a single fleet view and complicates cross-brain routing corrections.

### Store complete payloads for easier replay

This simplifies local replay but creates another sensitive source-of-record copy and conflicts with source-reference-based privacy.
