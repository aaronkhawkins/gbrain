# vLLM Provider

Use a private vLLM server for zero-metered-cost background chat workloads. GBrain
talks directly to vLLM's OpenAI-compatible `/v1` API; no proxy or routing layer
is required.

## Start vLLM

Expose the server only on a trusted private network or encrypted overlay such as
Tailscale. If the route is not private, require a vLLM API key and TLS before
using it with brain content.

```bash
vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4 \
  --host 0.0.0.0 \
  --port 8888 \
  --enable-prefix-caching
```

GBrain disables Qwen's hidden thinking tokens for vLLM calls. This keeps bounded
background jobs from spending their whole output budget on reasoning and then
returning empty content.

## Configure GBrain

Set the private base URL in GBrain's config so launchd and interactive shells use
the same endpoint:

```bash
gbrain config set provider_base_urls.vllm http://PRIVATE-HOST:8888/v1
```

`VLLM_BASE_URL` supplies the endpoint when no config value is present; the
GBrain config value wins when both are set. If the server requires
authentication, set `VLLM_API_KEY` in the process environment; do not commit the
token.

Route high-volume work to the local model:

```bash
MODEL='vllm:nvidia/Qwen3.6-35B-A3B-NVFP4'
gbrain config set facts.extraction_model "$MODEL"
gbrain config set models.expansion "$MODEL"
gbrain config set models.dream.extract_atoms "$MODEL"
gbrain config set models.dream.synthesize_concepts "$MODEL"
gbrain config set models.dream.synthesize_verdict "$MODEL"
gbrain config set models.tier.utility "$MODEL"
```

The vLLM recipe reports zero metered API cost. It does not make the work free of
local compute, and it does not replace GBrain's job budgets, concurrency limits,
or durable retry behavior.

## Verify

```bash
curl -fsS http://PRIVATE-HOST:8888/v1/models
gbrain models --json
```

Run a bounded representative extraction before replaying a backlog. An empty
completion with a `length` finish reason is classified as an output-budget
configuration error; other empty non-refusal completions are retryable provider
contract failures.
