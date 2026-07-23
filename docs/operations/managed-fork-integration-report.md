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
| `src/core/cycle/extract-atoms.ts` | U6 | Unmarked extraction stays generic; marked research gets explicit policy and source provenance | `test/cycle/extract-atoms-synthesize-concepts.test.ts` | Reconcile both |
| `src/core/cycle/patterns.ts` | U6 | Gateway reachability and bounded work coexist with research behavior | patterns provider/deadline suites | Reconcile both |
| `src/core/cycle/synthesize-concepts.ts` | U6 | Generic synthesis remains default; research promotion is marked, bounded, source-aware, and no-churn | `test/cycle/extract-atoms-synthesize-concepts.test.ts` | Reconcile both |
| `src/core/import-file.ts` | U6 | One FS-first canonical sink owns generated output; import stays idempotent and source-aware | import, generated-output, sync recovery suites | Replace dual-write overlap through the U6 sink |
| `test/cycle/extract-atoms-synthesize-concepts.test.ts` | U6 | Both upstream generic and fork research assertions survive | the file itself plus U6 integration suites | Combine fixtures; never select one side wholesale |
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
| C07 source/page identity | source resolver and canonical operations | import, Dream, facts, takes, search, both engines | `(source_id, slug)` is identity; opaque source context survives all calls; old default-source rows remain readable | Candidate-created non-default rows require a source-aware previous reader or roll-forward | U5 / compatibility-gated | source resolver, operations, engine parity, E2E source suites | Never retire composite identity; retire adapters after all callers are source-aware |
| C08 research policy/provenance v1 | bookmark policy and extraction | atom writer, synthesis, status, retrieval trace | Only marked sources receive `birdclaw-research-v1`; unmarked behavior stays generic; old marked frontmatter remains readable | Previous fork reads v1; new provenance fields must remain additive | U6 / backward-compatible | `test/cycle/extract-atoms-synthesize-concepts.test.ts`, research health suites | Retire when generic upstream policy can express the same admission and evidence rules |
| C09 generated knowledge file + projection | U6 FS-first sink | import, chunks, embeddings, retrieval, sync reconciler | Canonical file is commit point; DB projection is idempotent and replayable; existing DB-only/custom chunks remain readable without new dual writes | Before normal writes, reselect code and replay canonical files; after writes, roll forward unless a tested lossless replay exists | U6 / roll-forward after writes | generated output, import, sync recovery, repeat-run suites | Retire custom indexer after exactly-once parity; adapter may remain non-writing only |
| C10 facts-absorb payload v1 | facts enqueue sites | Minion handler and facts writer | Missing v1 fields normalize to explicit defaults; source ID and content hash fence writes; future versions reject | Current v1 remains readable by previous fork; any later payload version must drain/quarantine before rollback | U7 / backward-compatible now | `test/handlers.test.ts`, facts backstop suites | Retire legacy omission defaults after all accepted v1 jobs have drained and an envelope migration exists |
| C11 Minion lifecycle/job rows | queue, worker, supervisor | all durable handlers, status/doctor | Preserve accepted jobs, retry reset, source backpressure, refreshed route snapshot, reconnect, and explicit child outcome | Stop candidate workers; drain compatible jobs and quarantine new envelopes before previous worker starts | U7 / quarantine-required | Minion, handler, worker reconnect, E2E resilience suites | Retire fork lifecycle patches when upstream behavior and old/new payload fixtures pass |
| C12 migration chain v122→v123→v124 | upstream migrator for both engines | schema bootstrap, all persisted contracts | Fork/schema base is v122; candidate head is v124; v123/v124 must be reordered or guarded so oversized content cannot strand migration | Binary-only rollback allowed only if previous compiled reader passes migrated clone; otherwise restore tested v122 backup or roll forward | U2 / restore-required until proven | migration chain, v120/CJK, dual-engine failure-injection suites | Never retire migration history; retire temporary guard after all supported upgrade origins are safe |
| C13 import checkpoint v1 | upstream import staging | import retry and sync | Canonical target identity and staged completion remain idempotent; old imports without checkpoint still run | Previous code may ignore additive checkpoints but must not mistake staged work for committed output | U5/U6 / backward-compatible with replay | import checkpoint, sync recovery suites | Retire only through versioned checkpoint migration |
| C14 status/build JSON | status, doctor, models/providers | operator verifier and later observability | Additive content-free sections remain bounded and optional; existing fields retain types; actual process identity is explicit | Previous consumers may ignore additive fields; candidate verifier must reject missing required candidate fields | U8 / backward-compatible reader | status sections, build identity, compiled verifier suites | Retire fork sections when canonical upstream status supplies equivalent machine-readable evidence |
| C15 generated facts/pages/chunks/provenance rows | canonical operations and U6/U7 writers | search, Dream, status, previous/candidate readers | Writes are source-scoped, idempotent, and carry enough provenance to detect duplicates/staleness | Restore only before normal writes or with tested delta replay; otherwise roll forward | U6/U7 / roll-forward after writes | repeat-run Dream, facts idempotency, retrieval trace suites | No retirement until one canonical writer owns each namespace |
| C16 maintenance config/report | upstream maintain command + fork durable maintenance job | CLI, scheduler, Minion queue, operator | Pack-aware actions and orphan exclusions remain config-owned and non-destructive by default | Stop scheduling; previous fork can ignore additive report fields; queued new action types require quarantine | U7 / quarantine-required | maintain parser/report/job suites | Retire fork wrapper when upstream maintenance is durable and pack-aware end to end |

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

- Status: resolved and locally verified; merge commit pending finalization.
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
