---
status: complete
priority: p2
issue_id: "003"
tags: [code-review, embeddings, config, plan-drift]
dependencies: []
---

# Make Ollama The Actual Default For This Workflow

The plan marks “Flip the default provider for your local workflow to Ollama” as complete, but the runtime still only selects Ollama when the operator explicitly sets `GBRAIN_EMBEDDING_PROVIDER`, `GBRAIN_EMBEDDING_BASE_URL`, or `OLLAMA_HOST`. That means the branch added provider support, but it did not encode a real default flip on its own.

## Findings

- [docs/plans/2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md](/Users/akh/.codex/worktrees/0ab8/gbrain/docs/plans/2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md:371) marks the Ollama default flip as done.
- [src/core/embedding/provider.ts](/Users/akh/.codex/worktrees/0ab8/gbrain/src/core/embedding/provider.ts:50) only auto-selects a provider from ambient config; Ollama wins only when a base URL is already present.
- [openclaw.plugin.json](/Users/akh/.codex/worktrees/0ab8/gbrain/openclaw.plugin.json:13) exposes provider fields but does not establish an Ollama default value.
- Existing installs that already have `OPENAI_API_KEY` set but do not add the new Ollama env/config will continue using OpenAI, so the branch behavior does not match the “just flip it” rollout intent.

## Proposed Solutions

### Option 1: Add an explicit fork-local default

**Approach:** Default provider resolution to `ollama` with `http://127.0.0.1:11434` when neither provider is explicitly configured, while still allowing explicit `openai` override.

**Pros:**
- Matches the stated rollout intent
- Makes the branch behave the way the docs describe

**Cons:**
- Changes default behavior for anyone using the fork without a local Ollama instance

**Effort:** 30-60 minutes

**Risk:** Medium

---

### Option 2: Downgrade the claim and keep manual opt-in

**Approach:** Leave runtime behavior as-is, but change the plan/docs/checklists to say Ollama is supported and recommended, not the actual default.

**Pros:**
- No runtime behavior change
- Preserves current backward compatibility

**Cons:**
- Does not fulfill the original “flip now” ask
- Leaves the implementation as provider support rather than an actual default switch

**Effort:** 15-30 minutes

**Risk:** Low

## Recommended Action

Changed provider resolution so this fork now defaults to local Ollama at `http://127.0.0.1:11434` unless the operator explicitly selects `openai`. Updated docs and plugin descriptions to match that behavior and added tests for the new default and explicit OpenAI override.

## Technical Details

**Affected files:**
- [src/core/embedding/provider.ts](/Users/akh/.codex/worktrees/0ab8/gbrain/src/core/embedding/provider.ts:37)
- [openclaw.plugin.json](/Users/akh/.codex/worktrees/0ab8/gbrain/openclaw.plugin.json:13)
- [2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md](/Users/akh/.codex/worktrees/0ab8/gbrain/docs/plans/2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md:362)

## Resources

- Branch under review: `codex/ollama-embedding-provider`
- Provider resolution: [provider.ts](/Users/akh/.codex/worktrees/0ab8/gbrain/src/core/embedding/provider.ts:37)

## Acceptance Criteria

- [x] The runtime behavior and the documented rollout agree on whether Ollama is truly the default
- [x] A fresh local install on this fork either defaults to Ollama or the docs/checklists stop claiming that it does
- [x] Switching back to OpenAI remains possible through explicit configuration

## Work Log

### 2026-04-20 - Review Finding

**By:** Codex

**Actions:**
- Compared the plan’s implementation checklist against provider selection logic
- Traced how the active embedding provider is resolved at runtime
- Verified there is no code-level default flip beyond explicit operator configuration

**Learnings:**
- The branch successfully adds multi-provider support
- The “default flip” is currently a documentation/config convention, not an enforced runtime default

### 2026-04-20 - Fix Applied

**By:** Codex

**Actions:**
- Updated [provider.ts](/Users/akh/.codex/worktrees/0ab8/gbrain/src/core/embedding/provider.ts:37) so the fallback provider is now Ollama instead of “whatever ambient config happens to imply”
- Added tests in [embedding-provider.test.ts](/Users/akh/.codex/worktrees/0ab8/gbrain/test/embedding-provider.test.ts:36) for default Ollama selection, explicit OpenAI override, and the flipped precedence
- Updated [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:36), [INSTALL_FOR_AGENTS.md](/Users/akh/.codex/worktrees/0ab8/gbrain/INSTALL_FOR_AGENTS.md:22), [openclaw.plugin.json](/Users/akh/.codex/worktrees/0ab8/gbrain/openclaw.plugin.json:13), [docs/GBRAIN_VERIFY.md](/Users/akh/.codex/worktrees/0ab8/gbrain/docs/GBRAIN_VERIFY.md:160), and [docs/ENGINES.md](/Users/akh/.codex/worktrees/0ab8/gbrain/docs/ENGINES.md:135) to describe the new default accurately

**Learnings:**
- The cleanest way to honor the original “flip now” request is to require explicit `GBRAIN_EMBEDDING_PROVIDER=openai` for fallback usage on this fork
