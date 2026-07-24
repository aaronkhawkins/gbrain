# ADR 0004: Treat AI systems as observable, replaceable activities

- **Date:** 2026-07-24
- **Decision:** Accepted

## Context

Some workflow steps are deterministic integrations while others require classification, extraction, research, or multi-step agent behavior.
LangChain, LangGraph, DeepAgents, local models, hosted models, and LangSmith may each help implement or observe those steps.
Making any one framework the parent workflow contract would couple durable orchestration to a fast-changing AI toolchain.

Full-content traces would simplify debugging but would also create another copy of private email, employer material, service information, transcripts, and documents.
Metadata-only traces must still preserve enough linkage to build reproducible evaluation datasets.

## Decision

AI frameworks and model runtimes will implement bounded workflow activities behind stable activity contracts.
LangGraph or DeepAgents may own internal state for an AI-heavy activity when that activity needs durable reasoning, interrupts, or multi-step tool use.
They do not replace the parent workflow ledger.

LangSmith or another AI observability system may record traces and evaluations.
Tracing defaults to metadata and redacted content.
Traces retain stable source references, content hashes, activity and prompt versions, model configuration, timing, confidence, reason codes, proposed outcomes, final outcomes, and ledger correlation identifiers.

Versioned evaluation datasets are derived artifacts.
They may resolve approved examples from authoritative source systems and combine them with routing corrections or adjudicated outcomes from the ledger.
They are not another raw-content system of record.

## Consequences

- AI implementations and models can change without changing the end-to-end workflow contract.
- Deterministic workflow steps do not inherit agent-framework complexity.
- Classifier corrections can become measurable regression tests.
- Debugging private failures may require authorized access to the original source because redacted traces intentionally omit full content.
- Selective example capture may be introduced when a redacted trace is insufficient, without globally enabling full-content tracing.

## Rejected Alternatives

### Use LangGraph as the universal parent orchestrator

This provides durable agent execution but unnecessarily represents deterministic integration work as agent graphs and overlaps with the deployed workflow system.

### Store complete model inputs and outputs in every trace

This maximizes debugging convenience but creates another sensitive content store.

### Exclude AI tooling from the architecture

This avoids framework coupling but would also omit the trace, correction, and evaluation contracts needed to improve classifiers and enrichment over time.
