# Runbook: Embedding identity or coverage

## Signals

- Work key `retrieval.identity` → `failed` with `embedding_mismatch`
- Work key `embedding.coverage` → degraded/failed backlog
- Reason `embedding_disabled` when embeddings were intentionally deferred

## Checks

1. `gbrain status --section operational --json` for those work keys
2. Confirm configured embedding model/dimensions match stored chunk provenance
3. `gbrain doctor` embedding-related checks for remediation text
4. If `embedding_disabled`: expected until `gbrain config set embedding_model …`

## Repair

- Align model/dimensions; re-embed stale chunks when identity is compatible
- Do not treat full coverage as retrieval proof (semantic canaries are Phase 1C)
- Keep vector search fail-closed on identity mismatch

## Do not

- Export model responses, chunk text, or page bodies into metrics
- Claim retrieval “works” from component health alone
