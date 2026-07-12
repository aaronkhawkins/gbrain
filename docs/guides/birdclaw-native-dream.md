# BirdClaw Bookmarks in the Native Dream Cycle

BirdClaw remains the deterministic collector. GBrain owns every reasoning step after import: `extract_atoms` identifies durable ideas and concept references, `synthesize_concepts` builds evidence-linked topic pages, and normal dream phases index and connect the generated knowledge.

## Contract

A bookmark is eligible only when its `media` page carries all three markers:

```yaml
intake_adapter: birdclaw-bookmarks-to-brain
content_kind: x-bookmark
concept_synthesis_candidate: true
```

Unmarked media never enters atom extraction. Concept promotion from research requires at least two distinct original bookmark pages. Generated concept pages keep bounded `supporting_atoms` and `supporting_sources` records, including `source_id`, and render a `Supporting research` section.

## Safe pilot

1. Leave the existing combined BirdClaw job running while preparing the pilot. Do not let the custom and native synthesizers own the same concept namespace.
2. Create an isolated brain/database and import a small, representative set of marked bookmarks into a dedicated source.
3. Activate `gbrain-creator` or `gbrain-everything`; other packs intentionally skip these phases.
4. Preflight the configured AI gateway and confirm the model route is `opencode-server:*`. Native phases use the gateway; no direct Anthropic or OpenCode HTTP call belongs in the collector.
5. Run `gbrain dream --phase extract_atoms --drain --window 300` until its backlog reaches zero. Inspect atoms for normalized `concepts`, `source_slug`, and `source_hash`.
6. Run `gbrain dream --phase synthesize_concepts`. Inspect concept pages for distinct-source support, bounded provenance, and readable bookmark links.
7. Run the normal dream again. Graph and fact phases precede atom/concept generation in a cycle, so this second pass is required to project links and facts from newly generated pages. Embedding runs after synthesis in the generating cycle.
8. Run `gbrain doctor`, inspect extraction receipts/rollups, and search for several expected topics. Follow each result back to at least two original bookmarks.
9. Repeat synthesis once. The bounded support set and evidence order must remain stable, with no duplicate links or timestamp-only rewrite.

## Acceptance signals

- Marked bookmark count advances after collection and sync.
- `extract_atoms` receipts advance through the backlog with no unrelated media admitted.
- Native concepts have useful summaries and at least two distinct original sources.
- Search returns a topic and its supporting research links resolve to imported bookmarks.
- Provider diagnostics identify the OpenCode gateway route; provider failures appear as native warnings or deterministic fallback, never as a legacy processor invocation.
- A second dream pass creates the expected graph/fact projections.

## Cutover

After the pilot passes, change the BirdClaw scheduler to collector-only mode. It should collect, import, commit, and run `gbrain sync`, then stop. The ordinary GBrain dream schedule owns extraction and synthesis. Keep the previous combined invocation available for rollback until the native backlog is drained and a quality sample is accepted.

Legacy `pipeline_status`, `needs_enrichment`, and custom analysis timestamps are compatibility metadata only. Native receipts, source hashes, atom pages, and concept provenance become the processing system of record.

## Rollback

Pause native bookmark extraction by removing `concept_synthesis_candidate: true` from new imports or switching to a pack that does not declare the creator phases. Restore the prior combined BirdClaw invocation if necessary. Do not run both synthesizers against the same concept slugs. Existing native pages remain inspectable and can be removed from the isolated pilot brain without affecting collected bookmark files.
