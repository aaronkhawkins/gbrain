# Managed Fork Integration Report

This is the content-free integration ledger for the managed fork stabilization.
It records repository objects, generic contract names, counts, dispositions, and
test coordinates. It must not contain deployment selectors, service names,
configuration roots, endpoints, credentials, source names, page bodies, queue
payload samples, backup paths, or secret-derived fingerprints.

## U1 freeze status

- Status: complete; characterization only.
- Integration transaction: not started.
- Live deployment, configuration, queues, sources, and databases: unchanged.
- Selected fork object: `d7fe0b6080d3b603c92f29d51deab08136221683`.
- Selected upstream object: `bb5a66942d7a7b0992f94fc59b4710c8e30b1830`.
- Verified merge base: `5008b287e47bf791132eedfebf66bdef11e9398c`.
- Candidate post-baseline fixes: none. Commits after the selected upstream
  object remain excluded unless a focused acceptance failure proves the need
  and dependency closure is recorded in a new ledger row.

## Immutable inputs

| Input | Selected ref at inspection | Commit | Tree | Inspected/fetched | Version | Schema head |
|---|---|---|---|---|---|---|
| Fork | `fork/master` | `d7fe0b6080d3b603c92f29d51deab08136221683` | `224826764087304e3e8f692902b25d71a693a5db` | remote-tracking reflog `2026-07-22T11:59:00-07:00` | `0.42.59.0` | v122 |
| Upstream | `origin/master` | `bb5a66942d7a7b0992f94fc59b4710c8e30b1830` | `af8db1126c9fba95635f31ad30af95bf2b45002d` | remote-tracking reflog `2026-07-22T18:49:18-07:00` | `0.42.64.0` | v124 |
| Merge base | computed from selected objects | `5008b287e47bf791132eedfebf66bdef11e9398c` | `f8fab769e901f1a1608d92f17e4d043b3f806637` | verified during U1 | `0.42.59.0` | v122 |

`VERSION` and `package.json` agree on both selected heads and use four numeric
segments. The fork range contains 26 commits and the upstream range contains
139 commits beyond the merge base. Object identity, not a moving branch name,
governs U2.

Reproduction:

```sh
git cat-file -t d7fe0b6080d3b603c92f29d51deab08136221683
git cat-file -t bb5a66942d7a7b0992f94fc59b4710c8e30b1830
git merge-base d7fe0b6080d3b603c92f29d51deab08136221683 \
  bb5a66942d7a7b0992f94fc59b4710c8e30b1830
git merge-tree 5008b287e47bf791132eedfebf66bdef11e9398c \
  d7fe0b6080d3b603c92f29d51deab08136221683 \
  bb5a66942d7a7b0992f94fc59b4710c8e30b1830
```

If either remote-tracking ref advances, these commands and the U2 merge still
use the selected object IDs. A newer object is not silently admitted.

## Side-branch disposition

| Branch/object | Ancestry disposition | Behavioral disposition | Decision |
|---|---|---|---|
| `feat/native-bookmark-dream` at `ddb6c753` | Included by ancestry in fork head | Research admission, provenance, synthesis, output, and no-churn behavior characterized | Included; do not merge again |
| `feat/nvidia-nim-embeddings` at `2650a775` | Included by ancestry in fork head | Local provider ID, model, dimensions, and index-width behavior characterized | Included; do not merge again |
| `feat/hybrid-local-openai-routing` at `5da39d64` | Included by ancestry in fork head | Personal task routes and local zero-cost behavior characterized | Included; do not merge again |
| `feat/opencode-server-provider` at `d2364e15` | Not included by ancestry; `git cherry` reports its patch as equivalent | Loopback/authentication, response normalization, tool, and redaction behavior exists at fork head | Superseded; excluded |
| `feat/opencode-all-models` at `232fe30a` | Not included by ancestry; `git cherry` reports its patches as equivalent | Model IDs, structured fallback, and OAuth response behavior exists at fork head | Superseded; excluded |

No historical OpenCode branch supplies a behavior missing from the fork
characterization suite. A later failing characterization is the only condition
that reopens this disposition.

## Textual-conflict coverage

`git merge-tree` reports 18 content-conflicted paths. All are assigned before
U2; the selected invariant is a decision target, not a completed resolution.

| Conflicted path | Unit | Selected invariant | Proving test | Disposition |
|---|---|---|---|---|
| `docs/architecture/KEY_FILES.md` | U2 | Current-state inventory describes the reconciled tree once | documentation/privacy gates | Mechanical regenerate after code resolution |
| `src/commands/schema.ts` | U2 | All bundled packs remain activatable while upstream schema behavior is retained | `test/schema-cli.test.ts`, pack manifest suites | Reconcile both |
| `src/commands/models.ts` | U3 | Task-specific routes and correct subcommand dispatch coexist | `test/models-report.test.ts`, model routing suites | Reconcile both |
| `src/commands/providers.ts` | U3 | Diagnostics use the effective gateway config and preserve distinct provider IDs | provider/model diagnostic suites | Reconcile both |
| `src/core/ai/build-gateway-config.ts` | U3 | File, DB, and environment planes merge once with config precedence intact | `test/ai/build-gateway-config.test.ts`, `test/loadConfig-merge.test.ts` | Reconcile both |
| `src/core/ai/gateway.ts` | U3 | Foreground and queued calls share canonical route resolution; retry remains caller-owned | gateway and queued-route suites | Reconcile both |
| `src/core/ai/recipes/index.ts` | U3 | Hosted and local recipes are both registered under different IDs | NVIDIA/OpenCode/vLLM recipe suites | Reconcile both |
| `src/core/config.ts` | U3 | New upstream keys and fork task-route keys retain validated precedence | config-set/load-merge suites | Reconcile both |
| `src/core/extract-takes-from-pages.ts` | U3 | Configured chat route replaces hard-coded cloud choice without weakening source scope | takes extraction suites | Reconcile both |
| `src/core/contextual-retrieval-service.ts` | U4 | Full embedding identity, not dimensions alone, gates semantic work | contextual retrieval and embedding identity suites | Reconcile both |
| `src/core/search/hybrid.ts` | U4 | Identity mismatch fails closed while upstream lexical/search fixes remain | hybrid/search integration suites | Reconcile both |
| `src/core/postgres-engine.ts` | U5 | `(source_id, slug)` and engine parity govern every changed operation | engine parity and source-scope suites | Reconcile both |
| `src/core/cycle/extract-atoms.ts` | U6 | Unmarked extraction stays generic; marked research gets explicit policy and source provenance | `test/cycle/extract-atoms-synthesize-concepts.serial.test.ts` | Reconcile both |
| `src/core/cycle/patterns.ts` | U6 | Gateway reachability and bounded work coexist with research behavior | patterns provider/deadline suites | Reconcile both |
| `src/core/cycle/synthesize-concepts.ts` | U6 | Generic synthesis remains default; research promotion is marked, bounded, source-aware, and no-churn | `test/cycle/extract-atoms-synthesize-concepts.serial.test.ts` | Reconcile both |
| `src/core/import-file.ts` | U6 | One FS-first canonical sink owns generated output; import stays idempotent and source-aware | import, generated-output, sync recovery suites | Replace dual-write overlap through the U6 sink |
| `test/cycle/extract-atoms-synthesize-concepts.serial.test.ts` | U6 | Both upstream generic and fork research assertions survive | the file itself plus U6 integration suites | Combine fixtures; never select one side wholesale |
| `test/handlers.test.ts` | U7 | Existing durable facts compatibility and upstream lifecycle fixes both remain covered | the file itself, Minion resilience suites | Combine fixtures |

The table contains 16 production or documentation paths plus two conflicted
test paths. The authoritative count is the stage-1/2/3 path count from
`git merge-tree --write-tree --messages`, not the number of conflict hunks.

## Two-sided semantic inventory

This inventory is independent of textual conflicts. It was generated from
`5008b287..d7fe0b60` and `5008b287..bb5a6694`:

- Fork side: 119 changed paths and 41 added exported declarations.
- Upstream side: 338 changed paths and 82 added exported declarations.
- Both sides: 40 changed paths, including clean auto-merge surfaces.
- Persisted contracts inspected: migrations, page/source/provenance fields,
  chunks and embedding signatures, queue envelopes, checkpoints, facts,
  generated pages, status/build JSON, and config keys.

### Changed exported declarations

Fork declarations:

`OpenCodeServerLanguageModel`, `BIRDCLAW_BOOKMARK_KIND`,
`BIRDCLAW_INTAKE_ADAPTER`, `BIRDCLAW_RESEARCH_POLICY`,
`BUNDLED_PACK_NAMES`, `EXTRACTABLE_PAGE_TYPES`,
`FACTS_ABSORB_JOB_SCHEMA_VERSION`, `NVIDIA_NEMOTRON_3_EMBED_DIMS`,
`PGVECTOR_HNSW_HALFVEC_MAX_DIMS`, `nvidiaNim`, `opencodeServer`, `vllm`,
`classifyExtractionCandidate`, `embeddingIdentityGate`,
`estimateChatCostUsd`, `extractionAdmissionSql`,
`extractionResponsePolicy`, `factsContentHash`, `generatedPageChunks`,
`getBuildIdentity`, `hasResearchPolicy`, `isNvidiaNemotron3EmbedModel`,
`managedForkUpgradeGuard`, `normalizeResearchProvenance`,
`parseAtomsResponse`, `parseFactsAbsorbJobData`, `parseModelsSubcommand`,
`renderOpenCodePrompt`, `supportsHnswIndex`, `BuildIdentity`,
`EmbeddingIdentityDiagnostics`, `ExtractionAdmission`,
`ExtractionCandidate`, `FactsAbsorbJobData`, `OpenCodeServerOptions`,
`ResearchHealth`, `ResearchProvenanceFacts`, `ResearchSourceHealth`,
`UpgradeGuard`, `EmbeddingIdentityStatus`, and
`ExtractionResponsePolicy`.

Upstream declarations:

`ALLOWED_TYPES`, `BACKFILL_BATCH_SIZE`, `CLI_ONLY`,
`CYCLE_DEADLINE_RESERVE_MS`, `DEFAULT_EXTRACTION_MAX_TOKENS`,
`IMPORT_CHECKPOINT_KIND`, `IMPORT_CHECKPOINT_OWNER`,
`IMPORT_CHECKPOINT_SCHEMA_VERSION`, `KNOBS_HASH_VERSION`,
`MASS_RECONCILE_MIN_PAGES`, `MASS_RECONCILE_RATIO`,
`MIN_PATTERNS_SUBAGENT_BUDGET_MS`, `ORPHAN_EXCLUDE_PREFIXES_KEY`,
`ORPHAN_EXCLUDE_SLUGS_KEY`, `SYNC_SKIP_FILES`, `SYNOPSIS_DOC_MAX_CHARS`,
`deepseekReasoningContentCompatFetch`, `mistral`, `moonshot`, `nvidia`,
`__resetShortLivedCliForTests`, `__setGenerateTextTransportForTests`,
`assertSafeE2eDatabaseUrl`, `bigintToStringReplacer`,
`buildOrFallbackWebsearchQuery`, `capBatchItems`,
`clampSubagentBudgets`, `collectGitVisibleFiles`,
`commitWriteThroughFile`, `configureGatewayIfUninitialized`,
`decideLockAcquisition`, `discoverGitRoot`,
`extractCycleFreshnessSourceIds`, `extractTriggers`, `getFtsLanguage`,
`hasTrackedContent`, `isDurabilityHardened`, `isInsideGitRepo`,
`isNvidiaEmbeddingModel`, `isPidAlive`, `isShortLivedCliProcess`,
`listEverCommittedPaths`, `markShortLivedCliProcess`,
`massReconcileAllowed`, `matchesAnyGlob`, `maxOutputTokensFor`,
`multiSourceDriftAdvice`, `nvidiaEmbeddingDim`,
`nvidiaEmbeddingDimOptions`, `openAIPromptCacheKey`, `parseJudgeJson`,
`parseMaintainArgs`, `planReconcileDeletes`, `probeWatchdogAvailable`,
`proposedPath`, `readLiveParentPid`, `readSummaryBody`, `register`,
`repairToolPairing`, `resetFtsLanguageCache`, `resolveDrainTimeoutMs`,
`resolveImportTargetDir`, `resolveMaxOutputTokens`, `shouldExclude`,
`shouldExcludeFromOrphanReporting`, `shouldSuppressBootstrapPrint`,
`skillConformanceCheck`, `stringifyPgliteInitError`, `stripGapsSection`,
`supportsNvidiaEmbeddingDimension`, `takeHitRowToHit`, `toAISDKTools`,
`unionExtractableTypes`, `AgentClientBindings`, `ChronicleJudgeResult`,
`MaintainOptions`, `MaintainReport`, `MaintenanceAction`,
`OrphanPolicyOverrides`, `ReconcilePlan`, `ReindexSearchVectorOpts`, and
`ReindexSearchVectorResult`.

Purely additive exported declarations with no producer/consumer edge into fork
policy are mechanical unless a focused test shows interaction. Coupled
declarations are governed by the contract ledger below.

### Contract ledger

Every row records producer, consumers, version/compatibility rule, both
directions of compatibility, owner, proof, and retirement condition.

| ID / contract | Producer | Consumers | Compatibility and old-to-new behavior | New-to-old rollback | Unit / rollback class | Proving test | Retirement condition |
|---|---|---|---|---|---|---|---|
| C01 build identity + release manifest v1 | release builder and compiled CLI | operator verifier, upgrade guards | Four-part app version; manifest binds channel, tag, SHA, upstream object, clean bit, timestamp, and checksum; old source identity remains explicit | Compatible while v1 fields remain; candidate selection must not occur if previous verifier rejects manifest | U8 / code-only | `test/build-identity.test.ts`, `test/build-fork-release.test.ts` | Retire fork fields only when an upstream manifest proves equivalent selection and rollback |
| C02 task route/config snapshot | config loader and gateway factory | Dream, Minions, CLI/MCP diagnostics | Fork task keys and upstream provider/config planes merge with explicit precedence; old config remains readable | Restore prior private config snapshot; new-only keys must be ignored or removed before previous binary | U3 / config-restore | gateway/config/queued-route suites | Retire custom keys when canonical upstream task routes provide equivalent foreground/queued behavior |
| C03 OpenCode chat contract | `OpenCodeServerLanguageModel` and recipe | gateway, Dream, Minions | Provider-native model IDs, structured/text fallback, tool calls, bounded loopback transport, and redacted failures remain valid | Previous fork already reads this contract; no persisted provider response is required for rollback | U3 / backward-compatible | `test/opencode-server-language-model.test.ts` | Retire when supported upstream provider passes the same transport and privacy suite |
| C04 local NVIDIA NIM identity | `nvidia-nim` recipe and embedding helpers | embed, stale detection, vector index, status | ID stays `nvidia-nim`; local endpoint/auth/model/dims are never aliased to hosted `nvidia` | Previous fork reads local config and vectors; preserve recipe and provenance | U4 / backward-compatible | `test/ai/recipe-nvidia-nim.test.ts`, embedding suites | Retire only if upstream supports a distinct local recipe with full identity parity |
| C05 hosted NVIDIA identity | upstream `nvidia` recipe | gateway, providers/models diagnostics, embedding | New additive ID; must coexist with C04 and carry its own base URL, auth, models, dimensions, cost, and privacy contract | Previous fork cannot interpret hosted-only config/jobs; quarantine them before rollback | U4 / quarantine-required | upstream NVIDIA recipe/dim suites plus distinct-ID fixture | Retire no earlier than upstream removal; never alias to C04 |
| C06 embedding identity | config + embed writer | pages/chunks, stale detection, hybrid retrieval, status | Provider, exact model, dimensions, active column, preprocessing signature, and stored provenance must agree; same width alone is incompatible | Previous reader allowed only for a cohort it can prove; otherwise lexical/fail-closed or restore | U4 / quarantine-or-restore | embedding identity, dim, index lifecycle, hybrid suites | Retire fork gate when canonical engine enforces the same complete identity |
| C07 source/page identity | source resolver and canonical operations | import, Dream, facts, takes, search, both engines | `(source_id, slug)` is identity; opaque source context survives all calls; malformed identities and remote overrides outside scalar/federated grants fail closed; old default-source rows remain readable | Candidate-created non-default rows require a source-aware previous reader or roll-forward | U5 / compatibility-gated | `test/source-scope-resolver.test.ts`, source resolver, ingestion roundtrip, extraction, engine parity, and real-Postgres multi-source suites | Never retire composite identity; retire adapters after all callers are source-aware |
| C08 research policy/provenance v1 | bookmark policy and extraction | atom writer, synthesis, status, retrieval trace | Only marked sources receive `birdclaw-research-v1`; unmarked behavior stays generic; old marked frontmatter remains readable | Previous fork reads v1; new provenance fields must remain additive | U6 / backward-compatible | `test/cycle/extract-atoms-synthesize-concepts.serial.test.ts`, research health suites | Retire when generic upstream policy can express the same admission and evidence rules |
| C09 generated knowledge file + projection | U6 FS-first sink | import, chunks, embeddings, retrieval, sync reconciler | Canonical file is commit point; DB projection is idempotent and replayable; existing DB-only/custom chunks remain readable without new dual writes | Before normal writes, reselect code and replay canonical files; after writes, roll forward unless a tested lossless replay exists | U6 / roll-forward after writes | generated output, import, sync recovery, repeat-run suites | Retire custom indexer after exactly-once parity; adapter may remain non-writing only |
| C10 facts-absorb payload v1 | facts enqueue sites | Minion handler and facts writer | Missing v1 fields normalize to explicit defaults; source ID and content hash fence writes; future versions reject | Current v1 remains readable by previous fork; any later payload version must drain/quarantine before rollback | U7 / backward-compatible now | `test/facts-durable-job-compat.test.ts`, `test/facts-durable-minion.test.ts`, `test/handlers.test.ts`, facts backstop suites | Retire legacy omission defaults after all accepted v1 jobs have drained and an envelope migration exists |
| C11 Minion lifecycle/job rows | queue, worker, supervisor | all durable handlers, status/doctor | Preserve accepted jobs, retry reset, source backpressure, refreshed route snapshot, reconnect, and explicit child outcome | Stop candidate workers; drain compatible jobs and quarantine new envelopes before previous worker starts | U7 / quarantine-required | Minion, handler, worker reconnect, E2E resilience suites | Retire fork lifecycle patches when upstream behavior and old/new payload fixtures pass |
| C12 migration chain v122→v123→v124 | upstream migrator for both engines | schema bootstrap, all persisted contracts | Fork/schema base is v122; candidate head is v124; v123/v124 must be reordered or guarded so oversized content cannot strand migration | Binary-only rollback allowed only if previous compiled reader passes migrated clone; otherwise restore tested v122 backup or roll forward | U2 / restore-required until proven | migration chain, v120/CJK, dual-engine failure-injection suites | Never retire migration history; retire temporary guard after all supported upgrade origins are safe |
| C13 import checkpoint v1 | upstream import staging | import retry and sync | Canonical target identity and staged completion remain idempotent; old imports without checkpoint still run | Previous code may ignore additive checkpoints but must not mistake staged work for committed output | U5/U6 / backward-compatible with replay | import checkpoint, sync recovery suites | Retire only through versioned checkpoint migration |
| C14 status/build JSON | status, doctor, models/providers | operator verifier and later observability | Additive content-free sections remain bounded and optional; existing fields retain types; actual process identity is explicit | Previous consumers may ignore additive fields; candidate verifier must reject missing required candidate fields | U8 / backward-compatible reader | status sections, build identity, compiled verifier suites | Retire fork sections when canonical upstream status supplies equivalent machine-readable evidence |
| C15 generated facts/pages/chunks/provenance rows | canonical operations and U6/U7 writers | search, Dream, status, previous/candidate readers | Writes are source-scoped, idempotent, and carry enough provenance to detect duplicates/staleness | Restore only before normal writes or with tested delta replay; otherwise roll forward | U6/U7 / roll-forward after writes | repeat-run Dream, facts idempotency, retrieval trace suites | No retirement until one canonical writer owns each namespace |

## U6 Dream and generated-output disposition

- Status: implementation complete; no deployment or live source mutation.
- Characterization: upstream generic extraction remained intact, while marked
  bookmark admission had regressed in two fixtures and every generated-output
  family was DB-first or DB-only.
- Selected writer: one source-scoped FS-first sink. Lock order is source sync
  lock then bounded canonical-path lease. Atomic durable placement is the
  knowledge commit point; import rechecks the digest before projection.
- Concurrency: identical content coalesces without touching the canonical file;
  a divergent expected-digest mismatch is an explicit conflict.
- Recovery: content-free durable receipts in the private runtime-state plane
  record pending, file-committed, projected, or projection-failed state with
  bounded error codes. Each scheduled Dream startup scans unresolved receipts
  and repairs file-only projections automatically.
- Caller disposition: atoms, concepts, trusted Dream reflection/original
  writes, Dream summaries, and patterns use the sink. The former generated
  page indexer remains only as a non-writing compatibility adapter.
- Source policy: homogeneous output stays in its originating source. Mixed
  concepts use the existing `default` aggregation source and retain bounded
  atom/source evidence. Pattern reads and writes are source scoped.
- Research policy: only explicitly marked bookmark media is admitted;
  collector digests and unmarked media remain excluded. Research promotion
  requires distinct original evidence, while mixed/unmarked groups keep the
  generic count policy.
- Verification: PGLite crash, recovery, CAS, no-op, projection, source
  isolation, research admission, Dream child outcome/deadline, and concept
  retrieval fixtures are required. Real-Postgres coverage remains an explicit
  `DATABASE_URL`-gated predeployment gate.
| C16 maintenance config/report | upstream maintain command + fork durable maintenance job | CLI, scheduler, Minion queue, operator | Pack-aware actions and orphan exclusions remain config-owned and non-destructive by default | Stop scheduling; previous fork can ignore additive report fields; queued new action types require quarantine | U7 / quarantine-required | maintain parser/report/job suites | Retire fork wrapper when upstream maintenance is durable and pack-aware end to end |

## U7 Minions and durable-job disposition

- Status: implementation complete; no deployment, live queue, configuration,
  source, or database mutation.
- Queue ownership: `facts-absorb` now has one built-in registration. The
  versioned handler is no longer overwritten by the legacy registration and
  enters through the same queued gateway-refresh wrapper as other AI-backed
  jobs.
- Payload compatibility: pre-version rows normalize to v1 defaults; v1 rows
  contain every field consumed by the previous handler, whose JSON reader
  ignores the additive version and content-hash fields. Candidate-to-previous
  rollback therefore needs no v1 drain. Any future schema version remains a
  fail-closed, drain-or-quarantine boundary.
- Durable facts: all durable and short-lived-CLI submissions share one
  content-addressed enqueue helper, timeout policy, retry reset, source
  attribution, content-revision check, and idempotency key. Gateway and parse
  failures remain retryable; a changed source revision produces no stale fact.
- Upstream lifecycle retained: source-scoped backpressure, full operator retry
  reset, delayed-job/claim/lock reconnect behavior, explicit terminal child
  outcomes, bounded handler deadlines, and source-aware maintenance remain the
  selected implementation.
- Maintenance: the safe command remains dry-run by default, runs stale
  extraction plus source-scoped Dream maintenance, and inherits current
  schema-pack and config-owned orphan policy. U7 adds no maintenance payload
  shape that an older worker could misinterpret.
- Verification: isolated focused suites pass for payload compatibility,
  durable provider-interruption retry, exactly-once fact output, route refresh,
  source fairness, retry freshness, reconnect, timeouts, terminal child
  outcomes, subagent gateway/resume behavior, and maintenance parsing. The
  real-Postgres Minion resilience file remains skipped without
  `DATABASE_URL`; it is an explicit U8 predeployment gate, not a claimed pass.

## U8 release and deployment gate

- Status: release tooling and content-free process receipts are implemented;
  the repository stabilization gate and `0.42.64.1` allocation are complete.
  Live selection and both deployment observation gates remain explicitly
  deferred to the embedding data gate rather than being claimed here.
- Discovery: two Postgres deployment descriptors are required. The observed
  live entrypoints report source/upstream identity at the pre-integration fork
  version rather than an immutable managed artifact. No verified
  `current`/`previous` release pair was available.
- Target matrix: both discovered entrypoints execute on the same
  `darwin/arm64`, Mach-O, Bun 1.3.14 tuple. One candidate artifact may serve
  both only when each private descriptor independently verifies that exact
  manifest and checksum.
- Required database gate: no isolated real-Postgres test target was
  discoverable, and the local container runtime was unavailable. All
  `DATABASE_URL`-gated migration, engine-parity, source-isolation, Dream, and
  Minion resilience suites remain mandatory.
- Backup discovery: the canary runtime has four backup files, including two
  modified within seven days, but none is identified as encrypted and no
  restore receipt was found. The protected runtime has no discovered backup
  directory. Existing files therefore do not satisfy the encrypted,
  restore-tested cutover gate.
- Required private inputs: service selectors, brain/config receipt IDs,
  quiescence disposition, vector-job quarantine, encrypted backup custody and
  restore receipt, disposable canary source/queue, process receipt paths,
  observation owner, and rollback/roll-forward decision are unresolved.
- Service inventory: ten local launch definitions reference GBrain. None
  currently wires process receipt IDs/files, several cannot be assigned to a
  deployment from their definition alone, and independently selected
  supervisor/worker entrypoints were not established for both deployments.
  Cutover remains blocked until the private matrix resolves every producer and
  process role without inference.
- Queue baseline: the canary deployment reported 0 active, 0 waiting, 0
  failed, and 107 historical dead rows. The protected deployment reported 0
  active, 14 waiting, 0 failed, and 0 dead rows. Existing dead rows are a
  baseline, not an allowed positive delta; the 14 waiting rows require
  payload-version and handler classification before drain or quarantine. A
  read-only classification found one distinct candidate-supported,
  non-vector-mutating handler; all 14 rows use the legacy payload shape that
  U7 normalizes. They may drain only after backup/restore and single-worker
  canary gates, not under mixed worker generations.
- Source baseline: each deployment reports one repository-backed source and
  both source worktrees are dirty. Their commit plus dirty-state receipts must
  be captured privately before quiescence. Neither existing source is eligible
  for write canaries; a separate disposable repository-backed source and
  checkpoint are still required.
- Semantic compatibility stop: the pre-rehearsal inventory found both
  deployments at schema v122 and neither had a v2 page embedding signature.
  The canary inventory was 10,652 pages
  (8,703 legacy signatures, 1,949 NULL, 0 v2) across two stored chunk models.
  The protected inventory is 117 pages (109 legacy, 8 NULL, 0 v2) across one
  stored chunk model. U4 correctly fails semantic retrieval closed for these
  unverified cohorts, while Phase 0 prohibits production re-embedding. A
  synthetic v2 canary would not prove existing retrieval remains useful.
  The one legacy signature per deployment parses and matches current
  model/dimensions, but all 10,333 canary and all 238 protected embedded
  chunks carry a model label that disagrees with current configuration; eight
  protected embedded pages also lack a page signature. The current evidence
  therefore cannot support a metadata-only acceptance claim.
  Deployment is therefore blocked on a separately approved bounded
  provenance/re-embedding migration or a reviewed immutable-evidence
  acceptance policy; lexical-only degradation is not an acceptable cutover.
- Authorized embedding migration: the operator subsequently approved the
  separate bounded cohort-rebuild plan and selected the local Nemotron
  2048-dimensional identity for all text embeddings in every managed brain.
  That approval supersedes Phase 0's original no-re-embedding constraint only
  through the restore-tested gates in
  `docs/plans/2026-07-22-003-refactor-rebuild-embedding-cohorts-plan.md`.
  Image and multimodal embeddings remain a separate model cohort.
- Personal clone rehearsal: a restored content-free clone migrated from schema
  v122 to v124. The candidate fast Doctor score was 95 with no blocking checks.
  Compiled previous `0.42.59.0` and candidate `0.42.64.0` readers both opened
  the migrated clone successfully. The authorized clone-only Nemotron rebuild
  completed 10,333 chunks across 8,704 pages; SQL verified 10,333 non-NULL
  embeddings and zero missing rows. Full candidate Doctor exited zero with
  overall 75, brain checks 85, and brain score 83; embedding coverage was
  100%, staleness and missing counts were zero, the provider returned 2,048
  dimensions in 158 ms, and the database reported aligned `halfvec(2048)`
  chunk and fact columns. A hybrid query completed in 1.28 seconds and returned
  results. The remaining warnings concern empty timeline coverage, salience
  weights, a fixture path, and advisory prompt caching; none is blocking.
  Subsequent wire-contract testing found that this rehearsal's indexed NIM
  requests omitted `input_type=passage`; query requests correctly sent
  `input_type=query`. NVIDIA requires passage mode for indexed content and
  documents that the underlying omission default is query mode, so the 10,333
  rebuilt vectors are rejected as the wrong cohort and must be rebuilt after
  the transport fix. The rehearsal also exposed that `embed --all/--stale`
  rebuilds content chunks only: 51 facts and three active takes still require
  a bounded document-embedding backfill, and query-cache rows require explicit
  invalidation before they can be regenerated query-side. Phase 0 deployment
  acceptance therefore requires one resumable text-cohort rebuild path for
  chunks, facts, and takes plus query-cache invalidation, with per-surface
  identity and coverage receipts. The run still proves migration mechanics, provider
  reachability, hybrid query execution, and previous-reader compatibility, but
  it does not satisfy the embedding, live-cutover, company, semantic-quality,
  or observation-window gates.
- Corrected clone rebuild: an explicitly selected clone was subsequently
  rebuilt with passage-mode vectors for all 10,333 chunks, 51 facts, and three
  active takes. Vector coverage is complete, so another wholesale embedding
  run is not warranted. The signature backfill nevertheless left a subset of
  otherwise embedded pages unstamped. Until that backfill defect is fixed and
  the identity gate admits every intended page, the clone remains a failed
  acceptance candidate rather than proof of a complete cohort migration.
- Live schema incident: invoking the compiled candidate's `embed --help`
  unexpectedly connected before rendering help and applied the personal live
  schema migrations from v122 to v124. A pre-migration snapshot exists. No
  vector, configuration, or knowledge-content mutation occurred; compiled
  previous and candidate readers both work at v124, and the immediate live
  fast Doctor score was 95 with no blockers. This is a process defect and
  acceptance event, not a successful cutover. Live selection and writes remain
  blocked, and the CLI connect-before-help behavior requires explicit
  disposition before the final release gate. The candidate now short-circuits
  `embed --help` before engine connection and skips startup-marker side
  effects for every help spelling. A compiled-binary matrix exercised
  `--help`, `-h`, and representative global-flag placements against a
  configured disposable database intentionally behind the current migration
  head. All five invocations left its schema/version sentinel, config file,
  update cache, and upgrade breadcrumb unchanged.
- Live embedding target-selection incident: a later clone-rehearsal command
  inherited a temporary file-plane target that had drifted back to the live
  personal database, so the corrected passage-mode rebuild initially ran
  there rather than on the clone. The operator stopped the old services and
  repaired the resulting partial cohort: 10,333 of 10,333 chunks, 51 of 51
  facts, and three of three active takes now carry the intended document-mode
  embedding; 21 query-cache rows were cleared and a query-side canary
  regenerated one. Content-signature and stale/missing checks are clean, the
  provider and `halfvec(2048)` widths align, Doctor reports no blockers, and a
  hybrid canary returned relevant results. This is evidence of repaired live
  state, not deployment acceptance. The pre-candidate daemons were stopped
  and remain paused until an immutable candidate is selected.
- Mandatory mutation preflight: no further destructive cohort operation may
  rely on a config path, URL override, or opaque release receipt alone. The
  rebuild plan must add a fail-closed target gate that resolves the effective
  URL through the same precedence rules as runtime, connects read-only,
  compares an explicitly expected database identity (database plus
  host/port-derived opaque fingerprint), verifies schema/source/count bounds,
  rejects file-plane/environment disagreement, and consumes a one-time allow
  token naming that exact target. This gate is required before clone,
  personal, or protected rebuild/cutover work resumes.
- Repository gate: the focused non-live release/build-identity/verifier/status/
  supervisor/upgrade suite passes 70 of 70 tests, and TypeScript type checking
  and all 31 repository verification checks pass. The first broad disposable
  real-Postgres E2E run was not green: 148 of 161 files and 1,018 tests passed,
  while 13 files and 17 tests failed. Isolation reduced that set to nine real
  fixture/runner failures; eight are now individually green (engine parity,
  extraction discovery, OpenClaw loading, half-vector redirect handling,
  schema drift, OAuth serving, sync-lock recovery, and type unification).
  The mechanical file subsequently passed 78 of 78 tests in 177.85 seconds
  under its explicit 240-second file cap; the skills file passed three of
  three under the same bounded policy. Residual isolated E2E verification
  passed 90 of 90 tests across eight files, while the focused facts/type
  rerun passed five of five. Directly affected Phase 0 files also pass:
  phase ordering five of five, Dream four of four, and facts recall one of one.
  The first authoritative four-shard container gate cleared gitleaks, static
  guards, the compiled-WASM semantic-chunk guard, TypeScript, and snapshot
  construction, but never entered E2E. Three 256-file unit workers were
  OOM-killed with exit 137 because four Bun processes also used Bun's default
  intra-process concurrency; the fourth completed 3,665 tests with 3,655
  passes and ten failures. All 162 selected E2E files therefore remain
  unexecuted by that gate. The harness now caps each already-parallel Bun
  worker at concurrency one. Focused, sequential reproduction showed seven of
  the ten failures were concurrency/environment interference: source health
  passed 28 of 28, replay evaluation five of five, facts-engine 14 of 14,
  synthesis-timeout one of one, and filesystem validation three of three. The
  remaining three schema-operation failures were stale fixtures that created
  an unbound remote caller after the source-scope guard became fail-closed;
  binding those fixtures to their seeded `default` source restored that file
  to 23 of 23. It also renders the runner command without
  Bash 5.2 pattern-replacement semantics, which had rewritten `2>&1` and
  diverted shard errors into a worktree file, and compiles the WASM guard
  entirely on `/tmp` to avoid Docker Desktop cross-filesystem rename failure.
  `GBRAIN_CI_SHARD_JOBS` now validates an explicit range of one through four
  before side effects and defaults to one; the four unit/E2E cohorts therefore
  remain isolated without being concurrent unless the operator opts in.
  Nine focused runner-policy tests, shell syntax, command-rendering semantics,
  host/container WASM execution, and diff checks pass. A subsequent unit-only
  diagnostic was stopped without completing a shard after the tree advanced
  and its direct Docker invocation omitted the worktree Git-directory mount;
  it entered no E2E and is not acceptance evidence. That run nevertheless
  measured 4.39 GiB for one Bun worker, validating the sequential default.
  Final repository acceptance used the explicitly memory-bounded,
  change-focused gate agreed for this managed fork. The formerly failing
  sequential cohort completed with 3,757 passes, three intentional skips, and
  zero failures across 257 files. A focused regression set covering the
  earlier fixture failures completed with 327 passes before the last
  embedding-cohort fixture fix; that file then completed seven of seven.
  The changed real-Postgres and compiled E2E set completed 13 of 13 files with
  163 passes, zero failures, and one intentional platform skip. Repository
  guards, secret scanning, compiled-WASM behavior, PGLite snapshot generation,
  and TypeScript also passed. During acceptance, a real race was found in
  reflex-event telemetry: a dynamic import could let teardown drain before a
  pending write registered. The event sink is now registered synchronously,
  its 22-test regression file passes, and the complete sequential cohort
  confirms the fix. The earlier all-files container run is retained as
  diagnostic evidence, not a false green claim; running every untouched test
  file is no longer the Phase 0 exit criterion.
- Release authority: build and exact-byte cross-prefix install are
  non-selecting. Verify, select, and rollback share
  manifest/checksum/compiled-identity checks. Manifest v2 binds the
  four-part version, target tuple, schema compatibility, and runtime assets. Version and
  changelog allocation remain owned by the repository shipping workflow.
- Runtime evidence: CLI status, scheduler startup, supervisor startup, and
  worker startup expose the same content-free process build receipt. The
  deployment verifier requires an explicit mode-0600 private descriptor and
  rejects a wrong artifact, target, engine, selection, brain/config receipt,
  or missing daemon receipt.

### Candidate/previous compatibility matrix

| Plane | Candidate reads previous | Previous reads candidate | Classification before normal writes |
|---|---|---|---|
| Schema v122 | Candidate migrates only after restore-tested clone coverage | Previous reader must be exercised against the migrated clone | Restore-required until proven |
| Schema v123 | Candidate repairs the oversized-safe trigger path idempotently | Previous reader must be exercised against the repaired clone | Restore-required until proven |
| Schema v124/final head | Candidate native | Personal previous compiled reader passed on the migrated clone; company remains unproven | Personal reader-compatible on clone; company restore-required; roll-forward after accepted writes |
| Config shapes | Additive provider/task keys retain existing readers | Older code may ignore additive keys; private snapshot still required | Backward-compatible reader, restore-required writer |
| Queue envelopes | Legacy facts payload normalizes to v1 | v1 additive fields are ignored by the previous handler | Backward-compatible; future versions quarantine-required |
| Facts/generated pages/chunks/links/timelines/provenance | Candidate reads existing rows and canonical files | Candidate-created source-aware/generated outputs need previous-reader clone proof | Restore-required before writes, roll-forward after writes |
| Embedding metadata | Full v2 identity is accepted; legacy/unknown fails semantic closed | Previous code cannot be trusted to enforce candidate identity | Resumable chunks/facts/takes rebuild plus query-cache invalidation required under the separately approved cohort plan; vector jobs remain quarantined until every surface in each brain passes |
| Status JSON | Additive build/runtime fields preserve existing fields | Previous consumers may ignore additions | Backward-compatible |

The personal prior compiled artifact has now been exercised successfully
against the migrated restored clone. The equivalent protected-deployment clone,
immutable prior release selection/rollback, and both live observation gates
remain unproven and block deployment. No live scheduler, worker, queue, source,
or configuration record was changed. No release selector or managed service
definition was mutated, and no candidate service was deployed. Live database
state did change in the two incidents disclosed above: the accidental personal
schema migration from v122 to v124 and the mistaken-target embedding rebuild,
which was followed by the documented complete live embedding repair.

### Phase 0 exit-gate status

| Exit criterion | Status | Remaining proof |
|---|---|---|
| Behavior ledger resolves every selected overlap | Pass | Final closure commit is recorded after merge |
| Memory-bounded stabilization gate, including changed Postgres and compiled coverage | Pass | 3,757 unit passes plus 163 changed-path E2E passes; no failures |
| Coherent repository version and changelog | Pass | Fork baseline allocated as `0.42.64.1` |
| Personal embedding and semantic deployment acceptance | Data gate | Complete the resumable cohort and semantic-winning canaries under the target guard |
| Protected deployment compatibility and paths | Data gate | Provision and restore a protected clone, then run independent canaries and observation |
| Layered rollback coordinates | Data gate | Preserve the existing personal snapshot and add protected restore/selection receipts before live mutation |
| Content-free integration report can seed Phase 1 | Pass | Phase 1 must display data-gate items as pending, not infer them healthy |

Phase 0 closes at the repository boundary with version `0.42.64.1`. This does
not claim that either live deployment or embedding cohort is accepted. Those
stateful proofs remain owned by the separately authorized embedding data gate,
and Phase 1 may start from this baseline while representing them as pending or
degraded until their receipts are green.

### Clean auto-merge interaction map

The 40 paths changed on both sides are not presumed safe because they merge
cleanly. They are covered as follows:

- Gateway/config/provider/model surfaces: C02-C06, U3-U4.
- Dream/extraction/patterns/generated output: C08-C09, U6.
- Facts/jobs/handlers: C10-C11 and C16, U7.
- Source operations, engine methods, import, shared types: C07, C09, C13,
  U5-U6.
- Search, embedding, contextual retrieval: C06, U4.
- CLI, doctor, sync, schema, tests, and current-state documentation:
  consumer/adaptor surfaces governed by the owning contract row; no path is
  unowned merely because it is a shared or presentation layer.

## Pre-merge characterization receipt

The focused baseline suite covers:

- Four-part fork version and content-free build identity.
- Dirty/tag-mismatched release refusal and manifest v1 object binding.
- Local `nvidia-nim` identity; hosted `nvidia` is recorded as upstream-only
  before U4.
- Hybrid local task routing and zero-cost local budget behavior.
- OpenCode transport, model IDs, response normalization, tools, bounds, and
  redaction.
- Default/unmarked extraction and synthesis behavior.
- Marked research admission, source-aware evidence, mixed-group policy,
  deterministic output, and unchanged-output suppression.
- Legacy facts payload normalization, source/content fencing, retryable
  failure propagation, and version rejection.

No source implementation changed in U1.

## Layered rollback coordinates

These coordinates disclose no private selector or content:

| Plane | Pre-integration coordinate | Candidate transition rule | Rollback/repair rule |
|---|---|---|---|
| Code | fork object `d7fe0b6080d3b603c92f29d51deab08136221683`; version `0.42.59.0` | U2 merges only selected upstream object | Before selection, abandon candidate branch; after selection, use verified immutable `previous` artifact |
| Config | prior private snapshot receipt ID and effective-config fingerprint, to be captured per deployment | No company route mutation in this phase | Restore private snapshot before previous process start; public report records status only |
| Queue | v1 facts payload plus existing Minion rows; content-free counts captured at cutover | Quiesce producers, drain compatible work, quarantine new/vector-mutating work | Never run old and new workers together; previous worker starts only after envelope disposition |
| Source repositories | private per-source commit receipts; no U1 source mutation | Generated output commits FS-first through one sink | Repoint/replay only with source-specific tested procedure; never discard candidate canonical files |
| Database | schema v122 and private engine-correct backup receipt to be created and restore-tested before deployment | U2 test clones may reach v124; live migration waits for U8 gates | Before normal writes, restore only from verified consistent set when classified; after normal writes, roll forward unless lossless delta replay is proven |
| Embeddings | existing cohort identity/provenance receipt; no U1 vector mutation | No production re-embedding in Phase 0 | Quarantine vector-mutating jobs; semantic path fails closed on disagreement |

Private receipt IDs, selectors, fingerprints, backup custody, and source commits
remain outside this public file.

## U2 entry conditions and blockers

U2 may begin only from the selected objects with this characterization suite
green. Known blockers/stop conditions:

1. Resolve the v123/v124 ordering defect with dual-engine, oversized-content,
   failure-injection, and resume coverage before treating v124 as acceptable.
2. Do not collapse hosted `nvidia` into local `nvidia-nim`.
3. Preserve every conflict assignment and clean auto-merge contract row.
4. Do not deploy, select a release, run a live migration, re-embed, drain live
   queues, or mutate source repositories during U2.
5. If a later upstream commit is proposed, first reproduce a Phase 0
   acceptance gap and add its object, dependencies, contract row, and proving
   test here.

## U2 baseline merge receipt

- Status: resolved and locally verified in merge commit `a949daff`.
- First parent: `37749f135d0e33392b6c7acf83e01d01898314b1`.
- Second parent: `bb5a66942d7a7b0992f94fc59b4710c8e30b1830`.
- Later upstream objects included: none.
- Conflict count: 18 paths, matching the U1 stage-1/2/3 inventory.
- Resolution rule: all 18 conflict paths selected the pinned upstream side.
  `src/commands/schema.ts` retains upstream's shared
  `BUNDLED_PACK_NAMES`-driven activation, and
  `docs/architecture/KEY_FILES.md` was updated to current merged behavior.
- Mechanical buildability closure: the models command exposes its existing
  report and subcommand parser as test seams; characterization-only fork tests
  use type refinements compatible with the upstream-first types. These changes
  do not restore the U3-U7 routing, provider, embedding, source, Dream, or
  Minion policies.
- Schema resolution: the upstream v123 handler now installs the final
  oversized-safe page trigger before any non-English page backfill. Migration
  v124 remains the idempotent repair for databases already stamped v123.
  Fresh schema mirrors and the reindex consumer already carry the same safe
  function body.
- Resumability proof: failure injection after each of v123's four handler
  operations leaves the version marker unchanged and a complete retry
  reinstalls both functions and both backfills. A real PGLite v122 fixture with
  oversized non-English content reaches v124 and retains a search vector.
- Postgres fixture: added for v122 oversized upgrade and v123 repair, but not
  executed locally because no test database configuration was present and the
  Docker daemon was unavailable. No external or live database was used.
- Version audit: `VERSION`, `package.json`, and the top `CHANGELOG.md` entry
  agree on `0.42.64.0`; this is the pinned upstream baseline metadata, not a U8
  release allocation.

The merge commit is the exact resolution patch. After finalization, reproduce
its parent-relative forms with:

```sh
git show --cc --stat <u2-merge-commit>
git diff 37749f135d0e33392b6c7acf83e01d01898314b1 <u2-merge-commit>
git diff bb5a66942d7a7b0992f94fc59b4710c8e30b1830 <u2-merge-commit>
```

## U3 gateway and provider receipt

- Status: resolved and locally verified in focused commit `5fda6b3e`.
- Provider registry: upstream hosted providers remain registered, while the
  fork's `opencode-server`, `nvidia-nim`, and `vllm` identities are restored as
  distinct recipes. No provider ID is aliased or silently migrated.
- Routing authority: model selection remains in the shared resolver and AI
  gateway. The task report exposes the two native cognition routes with the
  same task/global/tier/environment/default precedence used by execution.
  Dream phases and workflow adapters gained no provider-specific branches.
- Configuration: file, database, and environment base-URL planes retain
  upstream per-provider merge behavior. Local provider environment overrides
  reach the shared gateway builder, and long-lived queued jobs retain
  upstream's pre-handler gateway refresh.
- OpenCode: the existing bounded loopback adapter is registered for chat and
  expansion, preserves provider-native finish reasons and tool calls, and
  keeps diagnostics content-free. Connection credentials remain private
  file/environment inputs and are deliberately not accepted by the
  DB-backed `config set` allowlist.
- vLLM: arbitrary operator-selected model IDs remain supported through the
  OpenAI-compatible transport. Background calls disable provider-side
  thinking, authenticated readiness remains optional, and empty nonzero-token
  output is classified as retryable or output-budget exhaustion from the
  provider-neutral finish reason.
- Upstream behavior retained: provider-scoped/model-scoped request options,
  prompt-cache breakpoints, OpenAI cache routing keys, tool-call pairing,
  model-list diagnostics, default AI deadlines, and retry ownership remain
  intact.
- Pure transformer boundary: page synopsis generation still accepts its model
  from the caller/gateway; contextual retrieval now derives the default from
  the effective gateway route instead of embedding a cloud-provider choice.
- Privacy: repository fixtures use synthetic values only. No live endpoint,
  credential, prompt, response, private selector, or secret-derived
  fingerprint was read or recorded.
- Verification: 200 focused gateway, provider, config, foreground/queued,
  tool-loop, OpenCode, vLLM, model-report, contextual-retrieval, and takes
  routing/progression tests passed. TypeScript typecheck and all 31 repository
  verification checks passed. No live provider or brain was contacted.

Remaining U3 risk is operational rather than code-path ambiguity: real
provider reachability and credential rotation/revocation are deployment gates
for U8. U3 did not modify live configuration, queues, sources, databases, or
release selection.

## U4 NVIDIA and embedding identity receipt

- Status: resolved and locally verified; no deployment or data mutation.
- Provider separation: hosted authenticated `nvidia` and local optional-auth
  `nvidia-nim` remain distinct recipes, endpoints, model catalogs, costs, and
  provider identities. Neither aliases nor migrates the other.
- Dimensions and preprocessing: hosted model-specific natural/Matryoshka
  validation remains fail-closed; local Nemotron remains fixed at 2048
  dimensions. Both use `input_type=query` for query vectors and
  `input_type=passage` for stored vectors.
- Wire-path correction: the local `nvidia-nim` recipe now uses the same
  NVIDIA compatibility transport as hosted `nvidia` without merging their
  provider identities. A real transport-shape test proves the local NIM wire
  body carries `query` for retrieval and `passage` for indexed documents.
- Persisted identity: new embeddings carry a v2 page signature binding exact
  provider/model, dimensions, active column, and document preprocessing.
  Chunk rows retain the fully qualified provider/model.
- Retrieval gate: runtime and DB selection, physical column type/width, chunk
  model, and page signature must agree before semantic ranking or semantic
  cache lookup. Equal-width model/provider/preprocessing conflicts and
  missing, NULL, or legacy v1 provenance fail semantic retrieval closed while
  lexical retrieval remains available.
- Legacy disposition: NULL/v1 cohorts are explicitly unverified. They are not
  auto-invalidated or relabeled during Phase 0; a later bounded re-embedding
  plan is required to admit them to semantic retrieval.
- Wide-vector index: `halfvec(2048)` remains HNSW-eligible with
  `halfvec_cosine_ops`; vector and halfvec limits remain distinct.
- Data safety: implementation and tests used only synthetic in-memory rows.
  No live brain/config/queue was read or changed, and no production vector was
  cleared, resized, relabeled, or re-embedded.
- Verification: 127 focused NVIDIA, dimension, embed/stale, identity,
  provenance, HNSW, and PGLite tests passed; TypeScript and all 31 repository
  verification checks passed. The 30 real-Postgres engine-parity cases skipped
  because no `DATABASE_URL` test fixture was configured and remain a U8 gate.

## U5 source routing and engine receipt

- Status: resolved and locally verified; no source, queue, configuration,
  database, or deployment mutation.
- Composite identity: upstream's source-aware page, chunk, link, timeline,
  extraction, sync, and engine paths retain `(source_id, slug)` as page
  identity. A PGLite ingestion fixture now imports the same slug into two
  registered sources and proves independent page bodies and chunks.
- Capture provenance: `ingest_capture` resolves a trusted emitter ID only
  when it names a registered brain source, passes that source through the
  canonical importer, and reports the effective source in its durable result.
  Untrusted or unregistered emitter IDs retain default-source routing rather
  than acquiring write authority.
- Remote trust: the canonical per-call resolver now confines a remote scalar
  binding to its bound source when no federated allow-list exists. Federated
  grants still take precedence, and trusted local callers retain explicit
  cross-source selection. Malformed explicit, scalar-context, and federated
  source IDs fail closed before an engine query.
- Engine behavior: Postgres optional RLS scope binding validates every source
  ID before creating its transaction-local scope and continues to bind the
  validated CSV as a parameter. PGLite keeps equivalent application-layer
  source filters but does not claim server-RLS enforcement. The reconciled
  Postgres build-then-swap reconnect, module-pool recovery, PGLite file-backed
  reconnect, and raw-object/`executeRawJsonb` batch behavior remain intact.
- Verification: 138 source, trust, ingestion, extraction, JSONB, reconnect,
  and engine-focused tests passed locally. The 64 `DATABASE_URL`-gated
  real-Postgres multi-source and engine-parity cases were unavailable and
  remain mandatory U8 gates.

### Content-free source inventory for U8

Run these queries only against the explicit private deployment descriptor.
Record aggregate counts and deltas, never source IDs, slugs, job payloads, or
page content in this public report.

```sql
-- Per-source projection counts. Keep the result in the private receipt.
SELECT p.source_id,
       count(DISTINCT p.id) AS pages,
       count(DISTINCT cc.id) AS chunks,
       count(DISTINCT te.id) AS timeline_entries,
       count(DISTINCT f.id) AS facts
FROM pages p
LEFT JOIN content_chunks cc ON cc.page_id = p.id
LEFT JOIN timeline_entries te ON te.page_id = p.id
LEFT JOIN facts f ON f.source_id = p.source_id
GROUP BY p.source_id;

-- Composite identity and orphan checks: every returned count must be zero.
SELECT count(*) FROM (
  SELECT source_id, slug FROM pages
  GROUP BY source_id, slug HAVING count(*) > 1
) duplicate_page_identities;
SELECT count(*) FROM content_chunks cc
LEFT JOIN pages p ON p.id = cc.page_id WHERE p.id IS NULL;
SELECT count(*) FROM links l
LEFT JOIN pages fp ON fp.id = l.from_page_id
LEFT JOIN pages tp ON tp.id = l.to_page_id
WHERE fp.id IS NULL OR tp.id IS NULL;
SELECT count(*) FROM timeline_entries te
LEFT JOIN pages p ON p.id = te.page_id WHERE p.id IS NULL;

-- Source lineage checks. Investigate every non-zero result before cutover.
SELECT count(*) FROM pages WHERE source_id IS NULL OR source_id = '';
SELECT count(*) FROM facts WHERE source_id IS NULL OR source_id = '';
SELECT count(*) FROM minion_jobs
WHERE data ? 'source_id'
  AND (data->>'source_id' IS NULL OR data->>'source_id' = '');
SELECT count(*) FROM minion_jobs child
JOIN minion_jobs parent ON parent.id = child.parent_job_id
WHERE child.data ? 'source_id'
  AND parent.data ? 'source_id'
  AND child.data->>'source_id' <> parent.data->>'source_id';

-- Link topology by source without exposing identities in the public receipt.
SELECT count(*) FILTER (WHERE fp.source_id = tp.source_id) AS same_source,
       count(*) FILTER (WHERE fp.source_id <> tp.source_id) AS cross_source
FROM links l
JOIN pages fp ON fp.id = l.from_page_id
JOIN pages tp ON tp.id = l.to_page_id;
```

The private pre/post receipt must also group jobs by effective source and
status, pages by `page_kind`, and generated outputs by originating source.
Any unexplained delta in a protected neighboring source is a stop condition.
