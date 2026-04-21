---
status: complete
priority: p2
issue_id: "005"
tags: [code-review, llm, copilot, search, quality]
dependencies: []
---

# Copilot Expansion Tool Invocation Is Not Enforced

The Copilot-backed expansion path does not guarantee that the model will invoke the structured `expand_query` tool, so query expansion can silently degrade to returning only the original query.

## Problem Statement

The old Anthropic implementation forced `tool_choice` to `expand_query`, which guaranteed a structured result when the model complied. The new Copilot wrapper exposes the custom tool but never requires the model to call it. If Copilot returns plain text instead of invoking the tool, `expandQuery()` quietly falls back to `[query]`, reducing recall while appearing healthy.

## Findings

- `src/core/llm/copilot-claude.ts:57-66` creates the Copilot session with `tools` and `availableTools`, but there is no equivalent of Anthropic's forced `tool_choice`.
- `src/core/llm/copilot-claude.ts:93-121` only captures arguments if the tool handler runs; otherwise `result` stays `null`.
- `src/core/search/expansion.ts:96-121` treats a missing tool invocation as `[]`, which means `expandQuery()` returns just the original query after dedupe.
- The plan claims expansion behavior is covered by mocked Copilot tests, but `test/copilot-claude.test.ts:98-154` manually invokes the handler and never exercises the failure mode where the model emits text instead of a tool call.

## Proposed Solutions

### Option 1: Add explicit tool-call enforcement or detection in the Copilot wrapper

**Approach:** Extend `completeClaudeTool()` to detect whether the assistant actually invoked the requested tool, and fail loudly when a tool call is required but absent.

**Pros:**
- Restores parity with the old structured expansion contract
- Makes model drift visible instead of silently degrading search quality

**Cons:**
- May require deeper SDK event handling if the SDK lacks a simple tool-choice primitive
- Could expose more transient model/provider failures

**Effort:** Medium

**Risk:** Medium

---

### Option 2: Add a text fallback parser for expansion-only usage

**Approach:** If the model returns plain text instead of a tool call, parse a tightly constrained JSON/text shape as a fallback before giving up.

**Pros:**
- Improves resilience if Copilot does not reliably call custom tools
- Limits user-visible search quality regressions

**Cons:**
- Weaker contract than true forced structured output
- Adds parsing complexity and another output format to secure

**Effort:** Medium

**Risk:** Medium

## Recommended Action

Require `completeClaudeTool()` call sites to know whether tool execution is mandatory, and add a failing test that simulates a plain-text assistant reply so the current silent degradation cannot slip through unnoticed.

## Technical Details

**Affected files:**
- `src/core/llm/copilot-claude.ts`
- `src/core/search/expansion.ts`
- `test/copilot-claude.test.ts`
- likely a new `expandQuery()` behavior test

## Resources

- Plan quality gate: `docs/plans/2026-04-20-refactor-route-all-anthropic-usage-through-github-copilot-plan.md:418-423`

## Acceptance Criteria

- [x] Expansion path detects and handles missing tool invocation explicitly
- [x] A test covers the case where Copilot returns text without calling `expand_query`
- [x] Search expansion behavior is no longer silently reduced to `[query]` without a deliberate decision

## Work Log

### 2026-04-20 - Review finding

**By:** Codex

**Actions:**
- Compared the Copilot wrapper to the completed migration plan
- Traced the expansion flow from `completeClaudeTool()` into `expandQuery()`
- Verified current tests only simulate the success path by directly invoking the fake tool handler

**Learnings:**
- The migration removed direct Anthropic usage correctly, but it did not preserve the old "tool call required" guarantee
- The current test suite would not catch a provider change that stops invoking the custom expansion tool

### 2026-04-20 - Fixed

**By:** Codex

**Actions:**
- Added explicit required-tool-call enforcement in `src/core/llm/copilot-claude.ts`
- Included the assistant's plain-text fallback snippet in the error for easier diagnosis
- Added a regression test that simulates a Copilot reply which never invokes `expand_query`

**Learnings:**
- The expansion path can keep its graceful top-level fallback while still failing explicitly at the structured-output boundary
