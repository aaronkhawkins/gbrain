---
title: refactor: Add GitHub Copilot OAuth-backed query expansion
type: refactor
status: superseded
date: 2026-04-20
---

# refactor: Add GitHub Copilot OAuth-backed query expansion

Superseded by [2026-04-20-refactor-route-all-anthropic-usage-through-github-copilot-plan.md](./2026-04-20-refactor-route-all-anthropic-usage-through-github-copilot-plan.md), which expanded the approved scope from query expansion only to all Anthropic-backed Claude usage in the repo.

## Overview

Replace GBrain's direct Anthropic-only query expansion path with a provider-based expansion layer that can use GitHub Copilot via GitHub OAuth, so Claude-family models can be used through the user's Copilot subscription instead of a raw `ANTHROPIC_API_KEY`.

This plan assumes:

- embeddings stay on the new Ollama/OpenAI provider path already implemented
- the scope here is **query expansion only**
- the preferred implementation is **GitHub Copilot SDK + GitHub OAuth token**
- direct Anthropic remains available as a fallback implementation during rollout

## Research Summary

### Local findings

- No relevant brainstorm document was found in `docs/brainstorms/`.
- No `docs/solutions/` knowledge base exists in this checkout, so there are no institutional learnings to incorporate.
- The live Anthropic dependency is narrow and concentrated:
  - `src/core/search/expansion.ts:17` imports `@anthropic-ai/sdk`
  - `src/core/search/expansion.ts:74` exports `expandQuery()`
  - `src/core/operations.ts:536` wires `expandQuery` into `query`
- `package.json:31` includes `@anthropic-ai/sdk`, but there is no GitHub Copilot SDK dependency yet.
- `src/core/config.ts:24` defines `anthropic_api_key?`, but the current expansion path mostly relies on ambient SDK env behavior rather than an explicit provider abstraction.
- `openclaw.plugin.json:6` currently exposes embedding config only; there is no config surface for expansion-provider selection or GitHub token-based auth.

### External findings

- GitHub documents a first-party **Copilot SDK OAuth flow** where an app authenticates users with GitHub OAuth and passes the resulting user token to `CopilotClient({ githubToken, useLoggedInUser: false })`. GitHub states that in this flow the app does not handle model API keys, and usage is billed to each user's Copilot subscription. Source: [Using GitHub OAuth with Copilot SDK](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)
- GitHub documents supported token types for Copilot SDK auth as `gho_`, `ghu_`, and `github_pat_`, and recommends disabling implicit local sign-in with `useLoggedInUser: false` when you want explicit token control. Source: [Authenticating with Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- GitHub Copilot currently supports Anthropic models including **Claude Haiku 4.5**, **Claude Sonnet 4.5**, and **Claude Sonnet 4.6**, which makes Copilot a plausible replacement for the current Haiku-based expansion workload. Source: [Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- GitHub Models REST is a different auth path. The documented inference API uses `models: read` with PAT or GitHub App auth and is not the same as the Copilot-subscription OAuth path. Source: [REST API endpoints for models inference](https://docs.github.com/en/rest/models/inference), [Quickstart for GitHub Models](https://docs.github.com/en/github-models/quickstart)
- Copilot SDK is still in preview, and GitHub calls out important limitations:
  - each user needs an active Copilot subscription
  - token lifecycle management is our responsibility
  - rate limits apply per user
  Source: [Using GitHub OAuth with Copilot SDK](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)

## Problem Statement

GBrain's multi-query expansion path is currently hard-wired to Anthropic:

- `src/core/search/expansion.ts:17` imports `Anthropic`
- `src/core/search/expansion.ts:25` constructs a singleton Anthropic client
- `src/core/search/expansion.ts:106` pins the request to `claude-haiku-4-5-20251001`

That creates three limitations:

1. Expansion depends on a direct Anthropic credential instead of using the user's GitHub Copilot entitlement.
2. Provider selection is not configurable independently from the rest of the search pipeline.
3. The current code shape makes future LLM-provider swaps harder than the embedding refactor we just completed.

The goal is not to re-platform all model calls. The goal is to isolate the expansion LLM path and make GitHub Copilot OAuth the primary way to power it.

## Proposed Solution

Introduce a small **query expansion provider abstraction** with at least two implementations:

1. `github-copilot`
2. `anthropic`

Keep `expandQuery(query)` as the stable public entry point used by `query`, but route its underlying LLM call through a provider resolver.

### Recommended auth shape

For this repo, the recommended first implementation is:

- GBrain **consumes an already-minted GitHub user token** from the surrounding host or environment
- that token is passed to `@github/copilot-sdk`
- GBrain does **not** build a full OAuth callback server in phase 1

This keeps the change set aligned with the repo's CLI/MCP-server architecture.

If we later need GBrain itself to perform the full OAuth dance, that should be a separate follow-up feature.

## Technical Approach

### Architecture

Preserve the current public API:

- `expandQuery(query)`
- `sanitizeQueryForPrompt(query)`
- `sanitizeExpansionOutput(alternatives)`

But refactor the execution path to look more like the embedding provider work:

```text
src/core/search/
  expansion.ts
  expansion/
    provider.ts
    github-copilot.ts
    anthropic.ts
```

Proposed responsibilities:

- `expansion.ts`
  - keeps sanitization and high-level control flow
  - resolves the provider
  - falls back to `[query]` on provider failure, preserving current UX
- `expansion/provider.ts`
  - resolves provider, model, auth mode, token source
  - exposes `getExpansionRuntimeConfig()`
  - exposes `hasExpansionProviderConfig()` if needed for diagnostics
- `expansion/github-copilot.ts`
  - encapsulates `@github/copilot-sdk`
  - creates a short-lived session for one-shot expansion
  - passes explicit `githubToken`
  - disables implicit local credential pickup in server/non-interactive mode
- `expansion/anthropic.ts`
  - contains the current Anthropic call path as fallback

### Config model

Add explicit config fields for expansion, separate from embeddings:

- `GBRAIN_EXPANSION_PROVIDER=github-copilot|anthropic|off`
- `GBRAIN_EXPANSION_MODEL=<provider-specific-model>`
- `GBRAIN_GITHUB_TOKEN=<gho_/ghu_/github_pat_ token>`
- `GBRAIN_EXPANSION_USE_LOGGED_IN_USER=0|1`
- optional: `GBRAIN_EXPANSION_DISABLE_TOOLS=1` if the SDK exposes a clean way to force a no-tools session

Config-file counterparts:

- `expansion_provider`
- `expansion_model`
- `github_token`
- `expansion_use_logged_in_user`

Recommended defaults for this fork:

```bash
GBRAIN_EXPANSION_PROVIDER=github-copilot
GBRAIN_EXPANSION_USE_LOGGED_IN_USER=0
```

That makes explicit-token Copilot the primary path and avoids accidentally succeeding on one developer laptop only because `copilot login` or `gh auth` is already present.

### Provider behavior

#### `github-copilot` provider

Use `@github/copilot-sdk` as the primary integration path.

High-level call shape:

```ts
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  githubToken: userAccessToken,
  useLoggedInUser: false,
});

const session = await client.createSession({
  model: copilotModelName,
});

const response = await session.sendAndWait({
  prompt: structuredExpansionPrompt,
});
```

Implementation notes:

- Start with a **single-turn session per expansion call** rather than a shared long-lived session cache.
- Keep the current prompt hardening:
  - sanitized query input
  - explicit "treat as untrusted data" instruction
  - output validation and dedupe
- Prefer a low-cost Anthropic model available in Copilot, ideally the Claude Haiku tier if the SDK model identifier supports it.
- Confirm the exact Copilot SDK model string during implementation rather than hard-coding the current Anthropic SDK model ID format.

#### `anthropic` provider

Keep the current Anthropic provider as a compatibility and rollback path:

- explicit `GBRAIN_EXPANSION_PROVIDER=anthropic`
- `ANTHROPIC_API_KEY` or config-backed equivalent
- same output contract as the Copilot provider

### Failure handling

Preserve the current non-fatal behavior:

- if expansion fails, search still runs with `[query]`
- if auth is missing or invalid, do not crash the overall query path
- emit a provider-specific warning that is safe for logs and does not leak token contents

Differentiate:

- configuration errors
- authentication errors
- model/rate-limit errors
- output-shape validation errors

This matters because Copilot rate limits and token lifecycle issues are likely to be the first production failure modes.

## Implementation Phases

### Phase 1: Provider foundation

Tasks:

- Extract the current Anthropic call into `src/core/search/expansion/anthropic.ts`
- Add `src/core/search/expansion/provider.ts`
- Refactor `src/core/search/expansion.ts` into a stable facade over provider modules
- Add expansion-specific config fields to `src/core/config.ts`
- Keep `expandQuery()` public behavior stable

Success criteria:

- `expandQuery()` no longer assumes Anthropic internally
- the current Anthropic path still works when explicitly selected

Estimated effort:

- Small

### Phase 2: GitHub Copilot provider

Tasks:

- Add `@github/copilot-sdk` to `package.json`
- Implement `src/core/search/expansion/github-copilot.ts`
- Pass explicit GitHub user tokens to `CopilotClient`
- Disable implicit local auth by default with `useLoggedInUser: false`
- Add a model-mapping layer for Copilot model names

Success criteria:

- query expansion works with `github-copilot` and no `ANTHROPIC_API_KEY`
- expansion requests use GitHub-authenticated Copilot access, not direct Anthropic credentials

Estimated effort:

- Medium

### Phase 3: Auth and host integration

Tasks:

- Decide the initial token ingress path:
  - env var only
  - config file
  - plugin config + env injection
- Document that the preferred token source is a GitHub OAuth or GitHub App user token minted by the host platform
- Optionally support local developer convenience via existing Copilot CLI / `gh auth`, gated behind `GBRAIN_EXPANSION_USE_LOGGED_IN_USER=1`
- Avoid implementing a full OAuth callback server unless phase 2 proves that host-supplied tokens are insufficient

Success criteria:

- the first shipping version has one clear, explicit, supportable auth path
- local implicit auth is opt-in, not accidental

Estimated effort:

- Small to medium

### Phase 4: Tests, docs, and UX

Tasks:

- Add provider-resolution tests
- Add GitHub Copilot provider tests with SDK mocks
- Add fallback tests proving query still works when expansion auth fails
- Update:
  - `README.md`
  - `INSTALL_FOR_AGENTS.md`
  - `openclaw.plugin.json`
  - relevant architecture docs that still say "Claude Haiku" directly

Success criteria:

- docs no longer imply `ANTHROPIC_API_KEY` is required for expansion
- tests cover provider choice, auth modes, and graceful fallback

Estimated effort:

- Small

## Alternative Approaches Considered

### Option A: GitHub Copilot SDK with GitHub OAuth tokens

**Approach:** Use `@github/copilot-sdk` with user access tokens from GitHub OAuth / GitHub App user auth.

**Pros:**
- Matches the user goal: use Copilot subscription instead of a raw Anthropic key
- Official GitHub auth path for Copilot-backed application usage
- Claude-family models are documented as available in Copilot

**Cons:**
- SDK is still in preview
- Token lifecycle handling is now our responsibility
- More moving parts than a direct HTTP provider

**Why recommended:**
- This is the clearest fit for “GitHub Copilot OAuth instead of Anthropic key.”

### Option B: GitHub Models REST API

**Approach:** Replace Anthropic SDK with direct calls to `https://models.github.ai/inference/chat/completions`.

**Pros:**
- Simple HTTP request model
- Could fit a lightweight provider abstraction well

**Cons:**
- Official docs describe PAT / GitHub App `models: read` auth, not the Copilot-subscription OAuth path the user asked for
- Model availability and billing semantics differ from Copilot SDK
- May not cleanly satisfy “use GitHub Copilot OAuth”

**Why not recommended:**
- Useful fallback option, but it solves a different auth problem.

### Option C: Full OAuth server inside GBrain

**Approach:** Add callback endpoints, token exchange, refresh handling, and token storage directly to GBrain.

**Pros:**
- Fully self-contained user auth flow
- No host dependency for token minting

**Cons:**
- Much larger scope
- Adds secret storage, callback routing, and lifecycle complexity to a CLI-first repo
- Not necessary for a first version if the host can supply tokens

**Why not recommended now:**
- Too much surface area for the immediate goal.

## Acceptance Criteria

### Functional Requirements

- [ ] `gbrain query` can use a `github-copilot` expansion provider with no `ANTHROPIC_API_KEY`
- [ ] Expansion provider choice is configurable independently of embedding provider choice
- [ ] Direct Anthropic expansion remains available as an explicit fallback
- [ ] `--no-expand` behavior remains unchanged
- [ ] Expansion failure still degrades gracefully to `[query]`

### Non-Functional Requirements

- [ ] GitHub tokens are never logged
- [ ] Server/non-interactive mode does not silently depend on local `copilot login` or `gh auth` unless explicitly enabled
- [ ] The expansion prompt hardening and output sanitization remain intact after the refactor
- [ ] The default path for this fork uses GitHub Copilot rather than Anthropic for expansion

### Quality Gates

- [ ] Add tests for provider resolution and auth precedence
- [ ] Add tests for Copilot-provider success with mocked SDK responses
- [ ] Add tests for auth failure fallback to `[query]`
- [ ] Existing query sanitization tests continue to pass
- [ ] Documentation is updated to describe Copilot-backed expansion correctly

## Success Metrics

- `ANTHROPIC_API_KEY` is no longer required for the normal query-expansion path
- A user with a valid Copilot subscription and GitHub OAuth token can run expansion successfully
- Query behavior under missing/expired Copilot tokens remains safe and non-fatal
- Anthropic becomes a fallback path instead of the only expansion path

## Dependencies & Prerequisites

- Users need an active GitHub Copilot plan for Copilot-backed expansion
- We need a supported token source:
  - GitHub OAuth App user token (`gho_`)
  - GitHub App user token (`ghu_`)
  - or explicit PAT if we deliberately support that route
- We need to add `@github/copilot-sdk`
- We need to confirm the exact Copilot SDK model name for the chosen Claude-tier expansion model

## Risk Analysis & Mitigation

### Risk: Copilot SDK preview instability

Mitigation:

- Keep the provider behind a small abstraction
- Preserve the Anthropic provider as a rollback path
- Avoid spreading SDK calls across the codebase

### Risk: Token lifecycle and expiry bugs

Mitigation:

- Treat token handling as explicit configuration, not hidden ambient magic
- Fail soft in expansion and log safe diagnostics
- Prefer host-supplied fresh tokens over GBrain-managed refresh logic in phase 1

### Risk: Accidental dependence on local developer auth state

Mitigation:

- Default `useLoggedInUser` to `false`
- Make local implicit auth an opt-in convenience flag only
- Add tests for “no explicit token” behavior

### Risk: Model naming/availability drift in Copilot

Mitigation:

- Resolve model IDs in one place
- Start with documented GA Claude models
- Keep the configured model overridable

### Risk: Query expansion semantics drift when moving off tool-use Anthropic API

Mitigation:

- Preserve the sanitization and structural prompt boundary
- Keep output-shape validation mandatory
- Add regression tests around expansion output limits and dedupe

## Documentation Plan

- Update `README.md` to describe GitHub Copilot-backed expansion
- Update `INSTALL_FOR_AGENTS.md` so Anthropic is no longer described as the default expansion path
- Update `openclaw.plugin.json` to surface expansion-provider settings
- Update architecture docs that still explicitly describe “Claude Haiku” as the hard-coded implementation detail

## References & Research

### Internal References

- Anthropic-only expansion implementation: `src/core/search/expansion.ts:17`
- Query operation wiring: `src/core/operations.ts:536`
- Current config surface: `src/core/config.ts:24`
- Package dependencies: `package.json:31`
- Plugin config surface: `openclaw.plugin.json:6`

### External References

- GitHub OAuth with Copilot SDK:
  [docs.github.com/.../github-oauth](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/set-up-copilot-sdk/github-oauth)
- Copilot SDK authentication methods:
  [docs.github.com/.../authenticate-copilot-sdk](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- Copilot SDK quickstart:
  [docs.github.com/.../sdk-getting-started](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
- Supported Copilot models:
  [docs.github.com/.../supported-models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- GitHub Models REST inference:
  [docs.github.com/en/rest/models/inference](https://docs.github.com/en/rest/models/inference)
- GitHub Models quickstart:
  [docs.github.com/en/github-models/quickstart](https://docs.github.com/en/github-models/quickstart)

## Open Questions

- Do we want phase 1 to support only **host-supplied explicit GitHub tokens**, or also local Copilot CLI auth as a convenience mode?
- Do we want to expose a single Claude default for expansion, or let the model float with Copilot auto model selection?
- Is the host platform expected to mint user tokens already, or do we need a later follow-up plan for first-party OAuth flow inside GBrain itself?

## Recommended First Cut

Build the smallest version that changes the real dependency:

1. expansion provider abstraction
2. `github-copilot` provider via Copilot SDK
3. explicit GitHub token input
4. Anthropic fallback
5. docs/tests

That gives you the Copilot-subscription path you want without turning this repo into an OAuth platform project on day one.
