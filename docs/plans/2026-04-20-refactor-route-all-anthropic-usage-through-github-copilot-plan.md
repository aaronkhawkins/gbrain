---
title: refactor: Route all Anthropic usage through GitHub Copilot
type: refactor
status: completed
date: 2026-04-20
---

# refactor: Route all Anthropic usage through GitHub Copilot

## Overview

Remove direct Anthropic usage from this repo and route all Claude-model calls through GitHub Copilot instead.

The requirement for this plan is:

- do **not** require an Anthropic account or `ANTHROPIC_API_KEY`
- do **not** keep direct Anthropic as a runtime fallback
- use GitHub Copilot access for Anthropic models you already pay for
- replace **all real Anthropic-backed usages in the repo**, not just the main query path

This plan supersedes the earlier narrow expansion-only plan because that plan incorrectly changed scope without approval.

## Research Summary

### Local findings

There is no relevant brainstorm in `docs/brainstorms/`, and there is no `docs/solutions/` directory in this checkout.

Current direct Anthropic-backed usage is concentrated in a few places, but it is broader than one file:

### Runtime code

- `src/core/search/expansion.ts:17`
  - imports `@anthropic-ai/sdk`
- `src/core/search/expansion.ts:25`
  - constructs an Anthropic client directly
- `src/core/search/expansion.ts:106`
  - hard-codes `claude-haiku-4-5-20251001`

### Dependency/config surface

- `package.json:36`
  - includes `@anthropic-ai/sdk`
- `src/core/config.ts:31`
  - includes `anthropic_api_key?`
- `INSTALL_FOR_AGENTS.md:36`
  - asks for `ANTHROPIC_API_KEY`
- `INSTALL_FOR_AGENTS.md:43`
  - documents Anthropic as the normal query-expansion path

### Tests and benchmark harnesses

- `test/e2e/skills.test.ts:10`
  - assumes `ANTHROPIC_API_KEY`
- `test/e2e/bench-vs-openclaw/harness.ts:22`
  - imports `@anthropic-ai/sdk`
- `test/e2e/bench-vs-openclaw/harness.ts:26`
  - hard-codes `claude-haiku-4-5`
- `test/e2e/bench-vs-openclaw/fanout.bench.ts:24`
  - imports `@anthropic-ai/sdk`
- `test/e2e/bench-vs-openclaw/throughput.bench.ts:26`
  - imports `@anthropic-ai/sdk`
- `docs/benchmarks/2026-04-18-minions-vs-openclaw-production.md:57`
  - documents `anthropic/claude-sonnet-4-20250514`
- `docs/benchmarks/2026-04-18-tweet-ingestion.md:8`
  - documents `anthropic/claude-sonnet-4`

### Docs and benchmark writeups

- `README.md:376`
  - still describes multi-query expansion as “Claude Haiku”
- `docs/architecture/infra-layer.md:71`
  - states expansion is “via Claude Haiku”
- benchmark docs under `docs/benchmarks/`
  - describe direct Anthropic SDK calls and `ANTHROPIC_API_KEY`

Important distinction:

- some repo fixtures and prose mention Anthropic as subject matter, company history, or benchmark context
- those content references are **not** integration points and should not be treated as part of the migration unless they are documenting current runtime setup

### External findings

- GitHub documents a first-party Copilot SDK OAuth flow where a GitHub OAuth App or GitHub App authenticates the user and passes the resulting token to `CopilotClient({ githubToken, useLoggedInUser: false })`. GitHub says your app does not handle model API keys in this flow. Source: [Using GitHub OAuth with Copilot SDK](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)
- GitHub documents supported token types for Copilot SDK as `gho_`, `ghu_`, and `github_pat_`, and explicitly documents `useLoggedInUser: false` to avoid silently picking up local stored credentials. Source: [Authenticating with Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- GitHub documents that Copilot currently offers Anthropic models including Claude Haiku 4.5, Claude Sonnet 4.5, and Claude Sonnet 4.6. Source: [Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- GitHub’s Copilot SDK quickstart shows the session-based interaction pattern: create a client, create a session, and `sendAndWait`. Source: [Getting started with Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
- GitHub’s public `github/copilot-sdk` README states that all models available via Copilot CLI are supported in the SDK. Source: [github/copilot-sdk](https://github.com/github/copilot-sdk)
- GitHub Models REST is a separate product and auth path. It is useful context, but it is not the clearest match for the specific requirement “use GitHub Copilot OAuth instead of direct Anthropic billing.” Source: [REST API endpoints for models inference](https://docs.github.com/en/rest/models/inference), [Quickstart for GitHub Models](https://docs.github.com/en/github-models/quickstart)

## Problem Statement

Today, GBrain directly depends on Anthropic for Claude-model calls. That means:

1. the repo requires direct Anthropic billing for features that could instead ride on the user's Copilot subscription
2. model access is split across providers in a way that does not match the user's paid stack
3. tests, docs, and benchmarks encode Anthropic-specific assumptions that keep the repo tied to `ANTHROPIC_API_KEY`

The goal is to make GitHub Copilot the only supported path for Claude-model usage in this repo, so every real Anthropic-backed call is routed through Copilot access instead of through Anthropic's direct API.

## Proposed Solution

Introduce a single **Copilot-backed Claude client layer** and migrate all direct Anthropic call sites to it.

This is not just a query-expansion refactor. It is a repo-wide Claude access migration with three outcomes:

1. runtime Claude usage goes through GitHub Copilot
2. test and benchmark harnesses stop using `@anthropic-ai/sdk`
3. docs/config stop telling users they need an Anthropic plan
4. model identity stays one-to-one with the current Anthropic usage per call site

### Scope of replacement

Replace:

- direct `@anthropic-ai/sdk` runtime usage
- direct `@anthropic-ai/sdk` benchmark/test harness usage
- direct `ANTHROPIC_API_KEY` setup assumptions in docs and tests

Do not treat these as in-scope:

- historical benchmark statements that explicitly compare against older Anthropic-backed runs, unless they are presented as current setup instructions
- content fixtures about people or companies that merely mention Anthropic

## Technical Approach

### Architecture

Create one shared Claude access layer backed by GitHub Copilot:

```text
src/core/llm/
  copilot.ts
  copilot-config.ts
  copilot-claude.ts
```

Recommended responsibilities:

- `copilot-config.ts`
  - resolve auth mode, token source, model name, and logged-in-user behavior
- `copilot.ts`
  - construct and cache `CopilotClient`
  - own explicit auth settings
- `copilot-claude.ts`
  - expose simple helper(s) for single-turn Claude-style requests used by GBrain
  - normalize Copilot session I/O into plain string/object outputs that current callers can consume

Then update call sites to use this shared Copilot-backed abstraction instead of importing Anthropic directly.

### Authentication model

Primary supported path:

- GitHub Copilot OAuth-backed access via `@github/copilot-sdk`
- explicit GitHub token input using:
  - GitHub OAuth App user token (`gho_`)
  - GitHub App user token (`ghu_`)
  - optionally `github_pat_` if we intentionally support it

Recommended runtime behavior:

```ts
const client = new CopilotClient({
  githubToken: resolvedGithubToken,
  useLoggedInUser: false,
});
```

This matters because it prevents the server path from “working on my machine” only because local Copilot CLI or `gh auth` state happens to exist.

Secondary local convenience mode:

- optionally allow `useLoggedInUser: true` behind an explicit flag for local interactive use
- this is convenience only, not the primary or default server behavior

### Model strategy

Preserve **exact model intent per call site** instead of picking a “close enough” Claude model.

Current known model targets:

- query expansion runtime:
  - `claude-haiku-4-5-20251001`
- benchmark harness:
  - `claude-haiku-4-5`
- documented production/tweet benchmark paths:
  - `anthropic/claude-sonnet-4-20250514`
  - `anthropic/claude-sonnet-4`

Migration rule:

- if a call site currently uses Haiku 4.5, migrate it to the Copilot-exposed Haiku 4.5 equivalent
- if a call site currently uses Sonnet 4 / Sonnet 4-20250514, migrate it to the matching Copilot-exposed Sonnet variant
- do **not** silently upgrade, downgrade, or substitute Sonnet for Haiku or Haiku for Sonnet
- if Copilot does not expose an exact or clearly equivalent version for a given call site, that call site is blocked pending an explicit decision rather than auto-remapped

If Copilot SDK model naming differs from Anthropic’s direct API model IDs, keep that translation isolated in one mapping table and document each mapping explicitly.

Recommended config surface:

- `GBRAIN_COPILOT_MODEL`
- `GBRAIN_GITHUB_TOKEN`
- `GBRAIN_COPILOT_USE_LOGGED_IN_USER=0|1`

If we want the query-expansion path to stay independently configurable from future non-expansion Claude calls, we can layer:

- `GBRAIN_EXPANSION_MODEL`

But the provider itself should stay singular: GitHub Copilot.

Recommended mapping artifact:

```text
src/core/llm/model-map.ts
```

This file should be the single source of truth for:

- current Anthropic model identifier
- target Copilot model identifier
- rationale for equivalence
- whether the mapping is exact or an approved compatibility alias

### Migration targets

#### 1. Runtime search expansion

Refactor `src/core/search/expansion.ts` so it stops importing `@anthropic-ai/sdk` and instead calls the shared Copilot-backed Claude helper.

Preserve:

- `sanitizeQueryForPrompt()`
- `sanitizeExpansionOutput()`
- current graceful fallback to `[query]` on failure
- the structural prompt boundary and output validation

#### 2. Bench and test harnesses

Refactor benchmark harnesses in `test/e2e/bench-vs-openclaw/` to use the same Copilot-backed helper instead of Anthropic SDK direct calls.

This keeps:

- runtime and benchmarking on the same auth and provider path
- benchmark claims aligned with real product behavior

#### 3. Config and env

Remove Anthropic-specific config expectations:

- remove `anthropic_api_key?` from `src/core/config.ts`
- stop documenting `ANTHROPIC_API_KEY` as required or normal
- update any e2e prerequisite checks that currently block on `ANTHROPIC_API_KEY`

#### 4. Dependency cleanup

Remove `@anthropic-ai/sdk` from `package.json` once all real call sites are migrated.

## Implementation Phases

### Phase 1: Inventory and Copilot Claude abstraction

Tasks:

- inventory every direct `@anthropic-ai/sdk` import and `ANTHROPIC_API_KEY` requirement
- inventory every explicit Claude model string and tie it to its call site
- add `@github/copilot-sdk`
- create shared Copilot-backed Claude helper modules under `src/core/llm/`
- define explicit auth resolution and model configuration
- create a single model-mapping table with one-to-one Copilot equivalents

Success criteria:

- there is one shared code path for Claude-model access
- new Claude calls no longer need to import Anthropic directly
- every migrated call site has an explicit model mapping rather than an inferred substitution

Estimated effort:

- Small to medium

### Phase 2: Migrate runtime code

Tasks:

- replace the Anthropic implementation in `src/core/search/expansion.ts`
- preserve current search behavior and failure semantics
- wire config loading for GitHub token and model selection
- keep the runtime expansion model pinned to the Copilot equivalent of `claude-haiku-4-5-20251001`

Success criteria:

- `gbrain query` uses GitHub Copilot for Claude-backed expansion
- `gbrain query` no longer requires `ANTHROPIC_API_KEY`
- runtime expansion still uses Haiku 4.5 semantics rather than being silently moved to Sonnet

Estimated effort:

- Medium

### Phase 3: Migrate test and benchmark harnesses

Tasks:

- replace Anthropic SDK usage in:
  - `test/e2e/bench-vs-openclaw/harness.ts`
  - `test/e2e/bench-vs-openclaw/fanout.bench.ts`
  - `test/e2e/bench-vs-openclaw/throughput.bench.ts`
- preserve benchmark model identity:
  - Haiku-based harnesses stay Haiku-based
  - Sonnet-based benchmark writeups stay Sonnet-based unless explicitly re-baselined
- update test prerequisites that currently require `ANTHROPIC_API_KEY`
- decide whether any benchmarks should be rewritten, skipped, or re-labeled if Copilot session semantics differ from raw completion semantics

Success criteria:

- no test or benchmark path depends on direct Anthropic credentials
- benchmark docs no longer describe current code as “calls Anthropic SDK directly”
- benchmark comparisons do not accidentally mix different Claude tiers or versions

Estimated effort:

- Medium

### Phase 4: Remove Anthropic dependency surface

Tasks:

- remove `@anthropic-ai/sdk` from `package.json`
- remove `anthropic_api_key` from config types and docs
- update:
  - `README.md`
  - `INSTALL_FOR_AGENTS.md`
  - `docs/architecture/infra-layer.md`
  - benchmark docs that currently describe direct Anthropic usage as present behavior

Success criteria:

- the repo no longer presents Anthropic as a required account or normal integration path
- the codebase has no remaining real direct Anthropic integration

Estimated effort:

- Small

## Alternative Approaches Considered

### Option A: Copilot SDK for all Claude-backed calls

**Approach:** Standardize on `@github/copilot-sdk` for every Claude-model access in the repo.

**Pros:**
- Matches the actual requirement
- Uses the Copilot subscription already being paid for
- Removes direct Anthropic billing and credential management from the repo
- Gives one consistent Claude access path for runtime, tests, and benchmarks

**Cons:**
- SDK is still in preview
- Session-based API may require more adaptation than a raw completion SDK
- Token lifecycle is our responsibility

**Why recommended:**
- This is the cleanest way to satisfy “all Anthropic usage should go through GitHub Copilot.”

### Option B: Keep Anthropic as fallback

**Approach:** Add Copilot, but preserve direct Anthropic as a fallback provider.

**Pros:**
- Easier rollback
- Fewer migration constraints up front

**Cons:**
- Violates the requirement
- Keeps Anthropic billing and credentials in the repo
- Preserves split behavior and complexity

**Why rejected:**
- You explicitly said no direct Anthropic fallback.

### Option C: GitHub Models REST instead of Copilot SDK

**Approach:** Replace Anthropic SDK with GitHub Models REST calls.

**Pros:**
- Simple HTTP shape
- Easy to wrap

**Cons:**
- Official auth model is different from the Copilot OAuth path you asked for
- It does not as directly map to “use my Copilot subscription”

**Why rejected for now:**
- The requirement is Copilot-backed OAuth usage, not just “anything from GitHub.”

## Acceptance Criteria

### Functional Requirements

- [x] `gbrain query` uses GitHub Copilot for Claude-backed expansion
- [x] No runtime feature requires `ANTHROPIC_API_KEY`
- [x] Every real direct Anthropic SDK call site is migrated or removed
- [x] All Claude-backed calls in the repo go through the shared Copilot path
- [x] Failure in Copilot-backed Claude access still degrades gracefully where the current product behavior is non-fatal
- [x] Every migrated call site preserves its current Claude family and version intent one-to-one

### Non-Functional Requirements

- [x] GitHub tokens are never logged
- [x] Server/non-interactive paths do not silently depend on ambient local auth unless explicitly enabled
- [x] Prompt hardening and output sanitization survive the migration unchanged
- [x] Anthropic-specific credentials, config, and dependency surfaces are removed from normal setup
- [x] No call site silently swaps Haiku for Sonnet, Sonnet for Haiku, or one Claude version for another without an explicit recorded decision

### Quality Gates

- [x] Add tests for Copilot auth resolution and model configuration
- [x] Add tests for expansion behavior with mocked Copilot SDK responses
- [x] Update or replace tests that currently assume `ANTHROPIC_API_KEY`
- [x] Remove `@anthropic-ai/sdk` from dependencies
- [x] Update docs so current setup instructions no longer mention direct Anthropic auth as required
- [x] Add assertions or golden coverage for the model-mapping table so future changes cannot silently drift model identity

## Success Metrics

- A user with GitHub Copilot access can run the repo’s Claude-backed features without creating an Anthropic account
- `ANTHROPIC_API_KEY` disappears from normal setup, runtime, and test prerequisites
- The repo has one Claude access path instead of multiple provider-specific ones
- Benchmark and architecture docs reflect the actual implementation after migration

## Dependencies & Prerequisites

- Active GitHub Copilot plan
- `@github/copilot-sdk`
- A supported GitHub auth token source:
  - `gho_`
  - `ghu_`
  - or explicitly supported `github_pat_`
- Confirmed Copilot model identifier for the chosen Claude default

## Risk Analysis & Mitigation

### Risk: Copilot SDK preview instability

Mitigation:

- isolate all Copilot logic in one shared module
- avoid scattering SDK calls across the repo
- keep product-level fallback behavior where the feature itself is already non-fatal, but not by falling back to Anthropic

### Risk: Session-based Copilot API does not map 1:1 to current Anthropic SDK assumptions

Mitigation:

- create a narrow helper that normalizes Copilot session responses into the shapes current callers need
- start with the simplest one-shot call pattern
- migrate benchmarks separately from runtime so behavior differences are explicit

### Risk: Silent model substitution changes quality/cost/latency characteristics

Mitigation:

- maintain a one-to-one model mapping table
- preserve Haiku call sites as Haiku and Sonnet call sites as Sonnet
- block any call site whose exact Copilot equivalent is unclear until an explicit decision is made

### Risk: Token lifecycle complexity

Mitigation:

- make explicit-token auth the primary path
- keep implicit local auth opt-in only
- document host responsibility clearly

### Risk: Some benchmark scenarios become less apples-to-apples after migration

Mitigation:

- re-label benchmarks where provider path changed materially
- separate “historical Anthropic benchmark” writeups from “current implementation” docs

## Documentation Plan

- Update `README.md` to describe Copilot-backed Claude usage
- Update `INSTALL_FOR_AGENTS.md` to remove `ANTHROPIC_API_KEY` from normal setup
- Update architecture docs that still describe direct Anthropic/Haiku implementation details
- Update benchmark docs so they distinguish historical Anthropic runs from current Copilot-backed behavior

## References & Research

### Internal References

- Direct Anthropic runtime path: `src/core/search/expansion.ts:17`
- Query operation wiring: `src/core/operations.ts:536`
- Current config surface: `src/core/config.ts:24`
- Current dependency list: `package.json:31`
- Anthropic benchmark harness: `test/e2e/bench-vs-openclaw/harness.ts:22`
- Anthropic benchmark callers:
  - `test/e2e/bench-vs-openclaw/fanout.bench.ts:24`
  - `test/e2e/bench-vs-openclaw/throughput.bench.ts:26`

### External References

- GitHub OAuth with Copilot SDK:
  [docs.github.com/.../github-oauth](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)
- Copilot SDK authentication:
  [docs.github.com/.../authenticate-copilot-sdk](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- Copilot SDK quickstart:
  [docs.github.com/.../sdk-getting-started](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
- Copilot supported models:
  [docs.github.com/.../supported-models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- Copilot SDK repository:
  [github.com/github/copilot-sdk](https://github.com/github/copilot-sdk)

## Open Questions

- Should the primary runtime auth path be:
  - explicit GitHub token env/config only
  - or explicit token plus opt-in local Copilot CLI auth convenience?
- For each currently pinned Anthropic model string, what is the exact Copilot SDK model identifier we should use for the one-to-one mapping?
- Do we want to preserve historical benchmark docs as historical snapshots, or rewrite them to describe only current implementation?

## Recommended First Cut

Implement the migration in this order:

1. shared Copilot-backed Claude client
2. runtime query expansion migration
3. benchmark/test harness migration
4. Anthropic dependency and docs removal

That sequence satisfies your actual requirement without leaving behind a direct Anthropic escape hatch.
