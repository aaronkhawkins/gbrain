# Hybrid Local/OpenAI Routing Review Handoff

Source: `ce-code-review` run `20260722-072545-ff448d19` against base `1b9adc2d96557f4b19cec9851c0153d525c2d7a9`.

## Residual Review Findings

- P0 — `src/core/ai/recipes/vllm.ts:50` — [vLLM transport policy is unenforced](https://github.com/garrytan/gbrain/issues/3215)
- P1 — `src/core/cycle/extract-atoms.ts:530` — [Unset task routes override configured chat model](https://github.com/garrytan/gbrain/issues/3216)
- P1 — `src/core/ai/chat-pricing.ts:10` — [Unpriced paid routes bypass phase spend caps](https://github.com/garrytan/gbrain/issues/2504)
- P1 — `src/core/ai/gateway.ts:2490` — [Zero-token empty completions still succeed](https://github.com/garrytan/gbrain/issues/3217)
- P1 — `src/core/cycle/extract-atoms.ts:575` — [Provider failures complete durable atom jobs](https://github.com/garrytan/gbrain/issues/3218)
- P1 — `src/commands/models.ts:604` — [Doctor skips configured background model routes](https://github.com/garrytan/gbrain/issues/3219)
- P2 — `src/core/config.ts:665` — [Generic provider URLs have vLLM-only DB merge](https://github.com/garrytan/gbrain/issues/3220)
- P2 — `src/commands/models.ts:521` — [One-token doctor probes falsely fail reasoning models](https://github.com/garrytan/gbrain/issues/3221)

These findings were independently validated after persona review. They are intentionally not part of the mechanical autofix commit because they alter provider policy, compatibility, pricing/error contracts, or durable-job behavior.
