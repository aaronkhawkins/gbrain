---
title: refactor: Add Ollama Qwen3 embedding provider
type: refactor
status: completed
date: 2026-04-20
---

# refactor: Add Ollama Qwen3 embedding provider

## Overview

Swap GBrain's embedding path from an OpenAI-only implementation to a provider-based embedding layer that can target `qwen3-embedding:8b` over Ollama on `skippy.local`, while preserving the existing `1536`-dimension pgvector schema and keeping OpenAI as a fallback.

This plan assumes we will flip your default embedding path to Ollama/Qwen3 without a pre-flip evaluation gate. OpenAI stays available as a second implementation so you can switch back and forth if needed.

## Problem Statement

GBrain currently hard-wires embeddings to OpenAI in one shared module, then gates vector search and auto-embedding on `OPENAI_API_KEY`. That makes local embeddings impossible without patching multiple call sites, even though the database schema already matches the target `1536` dimension we want to keep.

The current shape creates four constraints:

- `src/core/embedding.ts:1` hard-codes `OpenAI`, `text-embedding-3-large`, and `1536`.
- `src/core/search/hybrid.ts:80` disables vector search entirely when `OPENAI_API_KEY` is absent.
- `src/core/operations.ts:233` disables page-time embedding when `OPENAI_API_KEY` is absent.
- `src/core/config.ts:26` and `openclaw.plugin.json:6` only surface OpenAI-shaped embedding config.

## Proposed Solution

Introduce a small embedding provider abstraction with two implementations:

1. `openai`
2. `ollama`

Use that abstraction everywhere GBrain currently imports `embed()` / `embedBatch()`, and replace "has OpenAI key" checks with "has configured embedding provider" checks.

For the Lenovo path, target:

```bash
GBRAIN_EMBEDDING_PROVIDER=ollama
GBRAIN_EMBEDDING_MODEL=qwen3-embedding:8b
GBRAIN_EMBEDDING_BASE_URL=http://skippy.local:11434
GBRAIN_EMBEDDING_DIMENSIONS=1536
```

Keep OpenAI available as the fallback:

```bash
GBRAIN_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=...
GBRAIN_EMBEDDING_MODEL=text-embedding-3-large
GBRAIN_EMBEDDING_DIMENSIONS=1536
```

## Technical Approach

### Architecture

Keep the existing public embedding API stable:

- `embed(text)`
- `embedBatch(texts)`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`

But change the implementation behind it from "OpenAI service" to "provider resolver."

Proposed file shape:

```text
src/core/embedding/
  index.ts
  provider.ts
  openai.ts
  ollama.ts
```

`src/core/embedding/index.ts` becomes the shared facade used by:

- `src/core/import-file.ts:112`
- `src/commands/embed.ts:103`
- `src/core/search/hybrid.ts:113`
- `src/core/search/eval.ts:224`

### Implementation Phases

#### Phase 1: Provider foundation

Tasks:

- Add an `EmbeddingProvider` interface.
- Move the current OpenAI logic from `src/core/embedding.ts:10` into `src/core/embedding/openai.ts`.
- Add `src/core/embedding/ollama.ts` using Ollama's `POST /api/embed` API with `model`, `input`, and `dimensions`.
- Add config helpers for:
  - `GBRAIN_EMBEDDING_PROVIDER`
  - `GBRAIN_EMBEDDING_MODEL`
  - `GBRAIN_EMBEDDING_DIMENSIONS`
  - `GBRAIN_EMBEDDING_BASE_URL`
- Preserve the current default behavior when no new env vars are set.

Success criteria:

- Existing OpenAI behavior still works unchanged.
- Calling `embed()` no longer assumes OpenAI internally.

Estimated effort:

- Small to medium

#### Phase 2: Replace OpenAI-only gates

Tasks:

- Replace `!process.env.OPENAI_API_KEY` guards in:
  - `src/core/search/hybrid.ts:80`
  - `src/core/operations.ts:233`
- Introduce a helper such as `hasEmbeddingProviderConfig()`.
- Ensure `gbrain query` and `put_page` use embeddings whenever a valid provider is configured, not only when OpenAI is configured.
- Update config loading in `src/core/config.ts:26` to preserve new embedding settings in config-file and env merge logic.

Success criteria:

- Vector search works with Ollama and no `OPENAI_API_KEY`.
- `gbrain embed --stale` works with Ollama and no `OPENAI_API_KEY`.

Estimated effort:

- Small

#### Phase 3: Ollama quality and runtime tuning

Tasks:

- Add provider-specific batching and timeout behavior for Ollama.
- Lower default local concurrency for `gbrain embed --all` / `--stale` when provider is `ollama`, because `src/commands/embed.ts:126` is currently tuned for OpenAI RPM, not a single local box.
- Add dimension validation so we fail fast if Ollama returns something other than `1536`.
- Decide whether to read base URL from `GBRAIN_EMBEDDING_BASE_URL` first and fall back to `OLLAMA_HOST`.

Success criteria:

- No silent dimension mismatch.
- Embedding refresh runs stably on `skippy.local` without overdriving Ollama.

Estimated effort:

- Medium

#### Phase 4: Fork and ownership setup

Tasks:

- Create a GitHub fork because you do not control upstream `garrytan/gbrain`.
- Change local remotes so:
  - `origin` points to your fork
  - `upstream` points to `garrytan/gbrain`
- Do the embedding work on your fork-first branch rather than against upstream directly.
- Keep the change set usable locally even if upstream never accepts it.

Success criteria:

- You can push and iterate without upstream permissions.
- Upstream remains available for rebases and cherry-picks.

Estimated effort:

- Small

#### Phase 5: Docs and operator UX

Tasks:

- Update install/setup docs that currently assume OpenAI-only embeddings:
  - `README.md`
  - `INSTALL_FOR_AGENTS.md`
  - `docs/GBRAIN_VERIFY.md`
  - `docs/ENGINES.md`
- Update plugin config in `openclaw.plugin.json:6` to surface provider-oriented settings instead of only `openai_api_key`.
- Add a short Lenovo-specific example using remote Ollama on `skippy.local`.

Success criteria:

- A user can configure local embeddings without reading source.
- Docs no longer say embeddings require OpenAI.

Estimated effort:

- Small

## Alternative Approaches Considered

### Option A: Directly replace OpenAI with Ollama in `src/core/embedding.ts`

Pros:

- Fastest code change
- Minimal refactor

Cons:

- Bakes in a second one-off provider
- Leaves OpenAI fallback awkward
- Makes future provider work harder, not easier

Why not recommended:

- This solves today's need but makes tomorrow's model swap harder.

### Option B: Keep OpenAI available and flip your default to Ollama

Pros:

- Easy rollback
- Lets you switch between local Ollama and OpenAI without another refactor
- Keeps the code useful even if one provider is temporarily unavailable

Cons:

- Slightly more work than a pure hard-coded Ollama swap

Why recommended:

- It matches your stated goal: default to Ollama now, but preserve the ability to move back and forth.

### Option C: Change the schema to a different embedding dimension

Pros:

- Opens up more candidate models

Cons:

- Requires pgvector schema migration and full re-embedding
- Adds operational risk without clear quality upside

Why rejected:

- You explicitly want to keep `1536`, and keeping the current dimension avoids the riskiest part of the change.

## Acceptance Criteria

### Functional Requirements

- [x] GBrain supports `openai` and `ollama` embedding providers behind one shared API.
- [x] `gbrain query` performs vector search when `ollama` is configured and `OPENAI_API_KEY` is unset.
- [x] `gbrain embed --stale` works against `qwen3-embedding:8b` on `skippy.local`.
- [x] Page import auto-embedding works with Ollama.
- [x] The embedding model name recorded in chunk metadata reflects the active provider/model.

### Non-Functional Requirements

- [x] All embedding vectors written by the Ollama path are validated as `1536` dimensions.
- [x] Local embedding runs do not use OpenAI network calls when provider is `ollama`.
- [x] Default local embedding concurrency is safe for a single self-hosted Ollama instance.

### Quality Gates

- [x] Existing embedding tests continue to pass after the refactor.
- [x] Add provider-specific tests for:
  - config resolution
  - dimension mismatch failure
  - Ollama response parsing
  - "no OpenAI key but Ollama configured" search behavior

## Success Metrics

- `qwen3-embedding:8b` on `skippy.local` is operational for batch embeddings and query-time embeddings.
- Ollama is the default embedding path for your local workflow.
- OpenAI can still be used as a fallback with no schema changes.

## Dependencies & Prerequisites

- `skippy.local` must keep Ollama reachable on port `11434`.
- `qwen3-embedding:8b` must finish pulling successfully on the Lenovo box.
- The remote host must return `1536`-dimensional vectors when `dimensions=1536` is requested.

Current runtime validation:

- Host: `skippy.local`
- OS: Ubuntu Linux `aarch64`
- RAM: `119 GiB` total, about `85 GiB` available during inspection
- Ollama: `0.20.2`
- Model pull completed: `ollama pull qwen3-embedding:8b`
- Live embed verified: `qwen3-embedding:8b` returned `1536` dimensions from `http://127.0.0.1:11434/api/embed`

Current git ownership setup:

- Fork created: `https://github.com/aaronkhawkins/gbrain`
- `origin`: `https://github.com/aaronkhawkins/gbrain.git`
- `upstream`: `https://github.com/garrytan/gbrain.git`

## Risk Analysis & Mitigation

### Risk: Qwen quality is worse than OpenAI on your real data

Mitigation:

- Keep OpenAI provider intact as fallback.
- Make provider selection configuration-only so rollback is fast.

### Risk: Ollama returns a different dimension than expected

Mitigation:

- Validate returned vector length per request and fail loudly.
- Add a startup verification command to test one sample embedding.

### Risk: Local concurrency overwhelms Ollama

Mitigation:

- Make embedding concurrency provider-aware.
- Start with a low default for Ollama, then tune upward only if metrics look healthy.

### Risk: Docs and setup paths continue telling users they need OpenAI

Mitigation:

- Treat docs updates as part of the same plan, not follow-up cleanup.

## Resource Requirements

- One code change set touching embedding/config/docs/test paths
- One Lenovo-hosted Ollama instance
- One GitHub fork for safe iteration outside upstream permissions

## Future Considerations

- The Anthropic query-expansion path in `src/core/search/expansion.ts:17` should be refactored separately behind an LLM client abstraction so GitHub Copilot OAuth can back Claude-compatible calls.
- If Qwen works well, we can later add `gbrain doctor` checks for embedding provider health.
- If you want full remote self-hosted operation later, we can add a dedicated Lenovo deployment guide.

## Documentation Plan

- Document both provider modes in `README.md`.
- Update `INSTALL_FOR_AGENTS.md` so embeddings are no longer described as OpenAI-only.
- Update `docs/GBRAIN_VERIFY.md` health checks to mention provider-based embedding config.
- Update `docs/ENGINES.md` to say embeddings are provider-based rather than OpenAI-specific.

## References & Research

### Internal References

- OpenAI-only embedding implementation: `src/core/embedding.ts:1`
- Query-time vector gate: `src/core/search/hybrid.ts:80`
- Import-time embedding path: `src/core/import-file.ts:112`
- Bulk embedding command: `src/commands/embed.ts:22`
- Page write OpenAI gate: `src/core/operations.ts:233`
- Eval harness for A/B testing: `src/core/search/eval.ts:206`
- Current config shape: `src/core/config.ts:26`
- Current schema default and fixed dimension:
  - `src/schema.sql:37`
  - `src/schema.sql:164`
  - `src/core/pglite-schema.ts:45`
  - `src/core/pglite-schema.ts:163`
- Plugin config surface: `openclaw.plugin.json:6`

### External References

- Ollama embeddings capability docs: [docs.ollama.com/capabilities/embeddings](https://docs.ollama.com/capabilities/embeddings)
- Ollama embed API: [docs.ollama.com/api/embed](https://docs.ollama.com/api/embed)
- Ollama Qwen3 embedding model page: [ollama.com/library/qwen3-embedding](https://ollama.com/library/qwen3-embedding)

## Implementation Checklist

- [x] Fork `garrytan/gbrain` and repoint remotes before implementation
- [x] Finish pulling `qwen3-embedding:8b` on `skippy.local`
- [x] Verify `dimensions=1536` on the live Ollama endpoint
- [x] Refactor `src/core/embedding.ts` into provider-based modules
- [x] Replace OpenAI-only gating in search and operations
- [x] Add provider-aware tests
- [x] Update docs and plugin config
- [x] Flip the default provider for your local workflow to Ollama

## Execution Notes

- Targeted validation passed:
  - `scripts/check-jsonb-pattern.sh`
  - `bun test test/config.test.ts test/doctor.test.ts test/init-migrate-only.test.ts test/embed.test.ts test/embedding-provider.test.ts test/hybrid-ollama.test.ts test/query-sanitization.test.ts`
- Repo-wide `bun test` still reproduces pre-existing local fixture failures unrelated to this refactor. On this machine they fail when fixture setup tries to create git commits and prompts for `/Users/akh/.ssh/id_akh` passphrase inside:
  - `test/handlers.test.ts`
  - `test/doctor-fix.test.ts`
  - `test/dry-fix.test.ts`
