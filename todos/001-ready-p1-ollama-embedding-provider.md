---
status: completed
priority: p1
issue_id: "001"
tags: [embeddings, ollama, qwen3, config]
dependencies: []
---

# Add Ollama Qwen3 embedding provider

Replace the OpenAI-only embedding path with a provider-based implementation that defaults to Ollama/Qwen3 for local use while keeping OpenAI available as a fallback.

## Problem Statement

GBrain currently hard-codes OpenAI embeddings and disables vector search and page-time embedding whenever `OPENAI_API_KEY` is not present. That blocks the Lenovo-hosted Ollama path even though the database schema already matches the desired `1536` dimensions.

## Findings

- `src/core/embedding.ts` is the shared embedding facade and hard-codes OpenAI.
- `src/core/search/hybrid.ts` and `src/core/operations.ts` both gate behavior on `OPENAI_API_KEY`.
- `src/core/config.ts` and `openclaw.plugin.json` only expose OpenAI-shaped config today.
- `skippy.local` now has `qwen3-embedding:8b` installed and a live Ollama embed call returned `1536` dimensions.

## Proposed Solutions

### Option 1: Hard swap to Ollama

**Approach:** Replace the current embedding implementation with an Ollama-only client.

**Pros:**
- Fastest path to local embeddings
- Smallest short-term diff

**Cons:**
- Removes easy fallback to OpenAI
- Makes later provider changes harder

**Effort:** 2-3 hours

**Risk:** Medium

---

### Option 2: Provider abstraction with Ollama default

**Approach:** Keep `src/core/embedding.ts` as the stable public API, move provider-specific logic behind it, and default config to Ollama/Qwen3 for this workflow.

**Pros:**
- Keeps OpenAI available as fallback
- Solves current need without locking the codebase
- Limits call-site churn

**Cons:**
- Slightly larger refactor

**Effort:** 3-5 hours

**Risk:** Low

## Recommended Action

Implement Option 2. Preserve the current `embed()` and `embedBatch()` API, add provider-aware config, replace OpenAI-only gates, update docs/plugin config, and verify with targeted tests.

## Technical Details

**Affected files:**
- `src/core/embedding.ts`
- `src/core/config.ts`
- `src/core/import-file.ts`
- `src/core/search/hybrid.ts`
- `src/core/operations.ts`
- `src/commands/embed.ts`
- `openclaw.plugin.json`
- `README.md`
- `INSTALL_FOR_AGENTS.md`
- `docs/GBRAIN_VERIFY.md`
- `docs/ENGINES.md`

## Resources

- Plan: `docs/plans/2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md`
- Lenovo runtime target: `skippy.local`
- Ollama endpoint: `http://127.0.0.1:11434/api/embed`

## Acceptance Criteria

- [x] Provider-based embedding implementation exists with `ollama` and `openai`
- [x] Ollama can be used without `OPENAI_API_KEY`
- [x] Vector search works when Ollama is configured
- [x] Page import and `gbrain embed --stale` use Ollama correctly
- [x] OpenAI remains available as a fallback implementation
- [x] Docs and plugin config reflect provider-based embeddings
- [x] Relevant tests pass

## Work Log

### 2026-04-20 - Setup

**By:** Codex

**Actions:**
- Reviewed the execution plan and current embedding call sites
- Created a feature branch for the work
- Verified `qwen3-embedding:8b` on `skippy.local` returns `1536` dimensions
- Created this todo to track execution

**Learnings:**
- The safest path is a provider abstraction behind the existing embedding API
- The repo should be worked from the new fork, not upstream

### 2026-04-20 - Execution Complete

**By:** Codex

**Actions:**
- Added provider-aware embedding resolution with `ollama` and `openai` implementations
- Swapped OpenAI-only feature gates to provider-aware checks in search and operations
- Lowered default embed concurrency for local Ollama runs and added `1536`-dimension validation
- Updated import and bulk embed flows to persist the active embedding model in chunk metadata
- Updated docs and plugin config for Ollama/Qwen3-first usage with OpenAI fallback
- Added provider-specific tests and confirmed the targeted embedding/config suites pass

**Validation:**
- Passed: `scripts/check-jsonb-pattern.sh`
- Passed: `bun test test/config.test.ts test/doctor.test.ts test/init-migrate-only.test.ts test/embed.test.ts test/embedding-provider.test.ts test/hybrid-ollama.test.ts test/query-sanitization.test.ts`
- Repo-wide `bun test` still hits pre-existing local git fixture failures caused by SSH/passphrase prompts during test-time `git commit` setup in `test/handlers.test.ts`, `test/doctor-fix.test.ts`, and `test/dry-fix.test.ts`
