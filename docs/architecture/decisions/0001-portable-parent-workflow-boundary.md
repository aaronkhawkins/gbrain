# ADR 0001: Keep the parent workflow portable across knowledge sinks

- **Date:** 2026-07-24
- **Decision:** Accepted

## Context

Bookmark, media, and email processing form workflows that begin outside GBrain and may invoke collectors, OCR, transcription, classifiers, agents, archives, notifications, and human feedback.
Putting the full sequence inside GBrain makes the source workflow dependent on one storage implementation.
Keeping all enrichment outside GBrain instead reduces GBrain to a passive index and duplicates its native Dream, Minion, graph, fact, concept, embedding, and retrieval lifecycle.

## Decision

A durable parent workflow will own source acquisition, orchestration, source-specific transformation, routing, and delivery to a knowledge-sink adapter.
It may produce portable source artifacts such as normalized evidence, OCR text, media metadata, and transcripts.

GBrain is the first knowledge sink.
After admission it owns durable knowledge promotion, facts, entities, concepts, Dream enrichment, Minion work, embeddings, graph construction, and retrieval.

n8n is the initial parent orchestrator because it is already deployed and supplies visual workflows, persisted waits, retries, schedules, and execution inspection.
The workflow contract will not depend on n8n-specific execution tables.
LangGraph, DeepAgents, and similar frameworks may implement bounded AI activities but do not own the parent workflow by default.

## Consequences

- Source acquisition and expensive transformations survive a future GBrain replacement.
- GBrain remains useful as a knowledge system rather than becoming a generic workflow engine.
- The same source workflow can target another knowledge sink through an adapter.
- End-to-end completion requires receipts from both the parent workflow and the knowledge sink.
- Existing BirdClaw-specific orchestration inside GBrain must be assessed against this boundary rather than automatically preserved or removed.

## Rejected Alternatives

### Put the complete workflow in GBrain

This maximizes native reuse but couples source processing and workflow history to GBrain.

### Build finished knowledge entirely outside GBrain

This keeps workflows portable but duplicates GBrain-native enrichment and makes GBrain primarily a storage index.

### Replace n8n before proving a limitation

This adds tool-selection and migration work without evidence that the deployed orchestrator is blocking the desired behavior.
