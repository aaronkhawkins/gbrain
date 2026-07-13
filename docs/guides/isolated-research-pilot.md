# Isolated Research-Wiki Pilot

This pilot answers one question before any cleanup or backlog release: does the
native scheduled path turn a fixed bookmark cohort into a useful,
evidence-linked wiki? It replays already-collected records only. It does not
log in to X, call BirdClaw's collector, read the default GBrain home, or inherit
a PostgreSQL URL.

## Prepare the private inputs

Use an owner-only directory on encrypted local storage. Real cohort material,
relevance judgments, exports, and reports must never be committed. Retained
archives must be encrypted with a recoverable key stored outside the artifact
root and deleted on the operator's declared retention date.

```sh
umask 077
mkdir -m 700 /path/to/private-pilot
chmod 600 /path/to/private-pilot/scorecard.json
chmod 600 /path/to/private-pilot/evaluation.json
chmod 600 /path/to/private-pilot/cohort.jsonl
```

The immutable collector replay is JSONL with only an opaque id and the
already-collected text. Do not add account names, profile fields, credentials,
or unrelated metadata:

```json
{"id":"opaque-record-001","text":"Already-collected bookmark text."}
```

The script hashes every normalized record, creates one marked media page per
hash, rejects duplicate ids and unlisted files, and writes an exact private
cohort manifest. It initializes a local Git repository with no remote and
commits that immutable replay so `gbrain sync` uses its normal watermark path.
Public output contains counts and hash prefixes only.

The human scorecard is declared before inspecting generated results:

```json
{
  "useful_atoms":{"count":40,"total":50},
  "source_links":{"correct":20,"total":20},
  "evidence_coverage":{"count":45,"total":50},
  "false_concept_merges":{"count":1,"total":20},
  "duplicate_concepts":{"count":1,"total":20},
  "representative_questions":{"count":4,"total":5}
}
```

The evaluation file contains immutable queries, relevant result ids, lexical
rankings, and one or more candidate rankings. Each provider entry must include
`unsupported_results`, `result_count`, `latency_ms`, `cost_usd`,
`chunker_signature`, and `preprocessing_signature`. The harness computes
Recall@10 and nDCG@10 and rejects any provider that is worse than lexical on
either metric. This contract can compare an isolated OpenAI brain now and a
separate DGX brain later without mixing their vectors.

## Run the synthetic or private replay

Use a reviewed compiled fork binary. The work root must be disposable and must
not be the live GBrain home.

```sh
scripts/run-isolated-research-pilot.sh \
  --cohort /path/to/private-pilot/cohort.jsonl \
  --work-root /path/to/private-pilot/run \
  --scorecard-input /path/to/private-pilot/scorecard.json \
  --evaluation-input /path/to/private-pilot/evaluation.json \
  --gbrain-bin /path/to/isolated-release/current/gbrain \
  --chat-model opencode-server:gpt-5.5
```

The default chat model is `opencode-server:gpt-5.5`. The isolated child
processes inherit only the existing loopback OpenCode connection settings;
hosted provider keys and production database URLs are removed. Override the
model only for a deliberate isolated comparison.

The harness creates a dedicated PGLite brain and one source, then runs this
same command sequence twice:

Committed synthetic test data may use `--synthetic`; never use that relaxation
for a real cohort.

```sh
gbrain sync --source research-pilot
gbrain dream --source research-pilot --phase extract_atoms --drain --window 300
gbrain dream --source research-pilot --phase synthesize_concepts
gbrain dream --source research-pilot
gbrain export --dir PRIVATE_EXPORT_DIRECTORY
```

The second content export must have the same file/content digest as the first.
That catches duplicate pages, evidence churn, and timestamp-only rewrites. A
rerun also revalidates exact cohort membership. All child commands receive the
isolated `GBRAIN_HOME`; ambient production database URLs and hosted embedding
keys are removed.

## Decision gate

Every threshold is mandatory:

- Useful atoms: at least 80%.
- Sampled source-link correctness: 100%.
- Evidence coverage: at least 90%.
- False concept merges: at most 10%.
- Duplicate concepts: at most 10%.
- Representative questions answered with correct evidence: at least four of five.
- Every embedding candidate: Recall@10 and nDCG@10 no worse than lexical.

Any miss writes `block_cleanup_and_backlog` and exits non-zero. Tune or
redesign the research processing; do not clean the live database or release
the production backlog.

## Optional OpenAI evaluation

The pilot runner does not initiate hosted embedding evaluation. A later
OpenAI run needs fresh per-run operator opt-in and a mode-0600 egress manifest
recording the endpoint, retention posture, minimized text fields,
chunker/preprocessing signatures, latency, and cost. Exclude credentials,
usernames, URLs, and unrelated metadata from requests and logs. Seed a new
disposable evaluation brain from the same cohort manifest; never point it at
the production vector store. Provider selection and production backfill remain
deferred until the same judgments can be evaluated on the DGX.
