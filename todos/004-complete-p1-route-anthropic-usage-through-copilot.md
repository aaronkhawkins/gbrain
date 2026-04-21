---
status: complete
priority: p1
issue_id: "004"
tags: [copilot, claude, auth, llm, benchmarks, docs]
dependencies: []
---

# Route Anthropic Usage Through Copilot

Replace direct Anthropic SDK usage across runtime code, tests, benchmarks, and docs with a shared GitHub Copilot Claude path.

## Problem Statement

The repo still depends on direct Anthropic access for Claude-backed features and supporting tooling. That forces `ANTHROPIC_API_KEY` into runtime and test workflows even though the desired provider is GitHub Copilot OAuth.

## Findings

- Runtime query expansion in `src/core/search/expansion.ts` imports `@anthropic-ai/sdk` directly and pins `claude-haiku-4-5-20251001`.
- Benchmark harnesses in `test/e2e/bench-vs-openclaw/` still construct Anthropic clients directly and gate on `ANTHROPIC_API_KEY`.
- The eval generator in `eval/generators/gen.ts` also uses `@anthropic-ai/sdk`, so the migration scope is broader than the initial runtime-only inventory.
- `src/core/config.ts` still exposes `anthropic_api_key?`, and repo docs/tests still describe `ANTHROPIC_API_KEY` as a normal prerequisite.
- The approved plan requires one-to-one Claude model intent preservation per call site, with no direct Anthropic fallback.

## Proposed Solutions

### Option 1: Shared Copilot Claude layer for all current Anthropic usages

**Approach:** Add `@github/copilot-sdk`, create one Copilot-backed Claude helper in `src/core/llm/`, and migrate every real Anthropic call site to it.

**Pros:**
- Matches the approved plan and provider requirement
- Keeps model mapping centralized and testable
- Removes Anthropic billing/auth assumptions from the repo

**Cons:**
- Requires adapting current single-shot code to Copilot session APIs
- Touches runtime, tests, docs, and eval tooling in one pass

**Effort:** Medium

**Risk:** Medium

---

### Option 2: Partial runtime migration only

**Approach:** Move the main query expansion path first and leave benchmarks/eval/docs for later.

**Pros:**
- Smaller first code diff
- Lower short-term implementation risk

**Cons:**
- Violates the approved repo-wide scope
- Leaves lingering Anthropic dependency surface and mixed guidance

**Effort:** Small

**Risk:** High

## Recommended Action

Implement the full approved migration in one pass: shared Copilot Claude layer, runtime query expansion swap, benchmark/eval migration, then config/doc/dependency cleanup. Keep exact Claude family/version intent at each call site via an explicit mapping table.

## Technical Details

**Affected files:**
- `src/core/search/expansion.ts`
- `src/core/config.ts`
- `src/core/llm/*` (new)
- `test/e2e/bench-vs-openclaw/*`
- `test/e2e/skills.test.ts`
- `eval/generators/gen.ts`
- `README.md`
- `INSTALL_FOR_AGENTS.md`
- `docs/architecture/infra-layer.md`
- benchmark docs
- `package.json`

## Resources

- Plan: `docs/plans/2026-04-20-refactor-route-all-anthropic-usage-through-github-copilot-plan.md`
- GitHub docs: Copilot SDK auth, GitHub OAuth, supported models, SDK quickstart

## Acceptance Criteria

- [x] Runtime Claude usage goes through the shared Copilot path
- [x] Benchmark and eval Claude usage goes through the shared Copilot path
- [x] `ANTHROPIC_API_KEY` is removed from normal runtime/test prerequisites
- [x] Model mapping is explicit and preserves current Claude intent per call site
- [x] `@anthropic-ai/sdk` is removed from dependencies
- [x] Relevant tests pass and docs are updated

## Work Log

### 2026-04-20 - Migration kickoff

**By:** Codex

**Actions:**
- Re-read the approved plan and current Anthropic-backed call sites
- Confirmed active work branch is `codex/ollama-embedding-provider`
- Identified additional in-scope Anthropic usage in `eval/generators/gen.ts`
- Verified GitHub Copilot SDK auth guidance from official GitHub docs

**Learnings:**
- The current scope is repo-wide, not just runtime query expansion
- Exact model parity needs a dedicated mapping artifact to avoid silent drift
- Local shell path does not include `bun`, but the binary exists at `/opt/homebrew/bin/bun`

### 2026-04-20 - Migration completed

**By:** Codex

**Actions:**
- Added a shared Copilot-backed Claude layer under `src/core/llm/`
- Migrated runtime query expansion, benchmark harnesses, and the eval prose generator off direct Anthropic SDK usage
- Removed `anthropic_api_key` from config handling and updated setup/docs to use GitHub Copilot auth
- Added targeted tests for Copilot auth resolution, model mapping, and mocked Copilot Claude calls
- Removed `@anthropic-ai/sdk` from dependencies and regenerated the Bun lockfile
- Ran targeted Bun test coverage plus benchmark compile/skip validation and the JSONB safety check

**Learnings:**
- Copilot SDK's session model is workable for both plain text completions and tool-style structured output when wrapped in one narrow helper
- The benchmark/eval surface needed migration too; stopping at runtime search would have left hidden provider drift in the repo
