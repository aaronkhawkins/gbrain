// v0.41 T6 — synthesize_concepts cycle phase (minimal-viable implementation).
//
// v0.41 ships a working concept synthesis path: group atoms by simple
// frontmatter tag/concept references, tier by count (T1 ≥10, T2 ≥5,
// T3 ≥2, T4 ≥1), Sonnet-synthesize T1/T2 narratives. Voice gate
// integration + dedup-by-embedding-similarity ship in v0.42+.
//
// Sequencing:
//   1. Query all atom-typed pages from DB (excluding imported_from
//      marker → atoms already extracted by your OpenClaw don't get
//      re-synthesized as concepts here; their original concept pages
//      come through greenfield import already).
//   2. Group by `concepts:` frontmatter field on each atom (when the
//      Haiku 3-check from extract_atoms decides "this atom is about
//      concept X", it stamps the field).
//   3. For each group with count ≥2: assign tier (T1/T2/T3/T4 by count).
//   4. For T1/T2 groups: Sonnet call to produce a 1-paragraph narrative.
//      For T3/T4: deterministic stub narrative.
//   5. Write concept-typed pages.

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { chat as gatewayChat, isAvailable } from '../ai/gateway.ts';
// #2163: concept pages route through importFromContent (the same
// parse→chunk→embed pipeline put_page uses) instead of a bare engine.putPage,
// so they land in the retrieval surface (content_chunks + embeddings) where
// source-boost's 1.3× 'concepts/' weighting can actually reach them.
import { serializeMarkdown } from '../markdown.ts';
import { createHash } from 'node:crypto';
import {
  readGeneratedOutputDigest,
  resolveGeneratedOutputPath,
  writeGeneratedOutput,
} from '../generated-output-writer.ts';

const DEFAULT_BUDGET_USD = 1.5;
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;

export interface SynthesizeConceptsOpts {
  brainDir?: string;
  dryRun?: boolean;
  yieldDuringPhase?: (() => Promise<void>) | undefined;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — see extract-atoms.ts for
   * the path-collision bug codex caught). Phases only call `tick()` /
   * `heartbeat()`; cycle.ts owns start/finish.
   */
  progress?: ProgressReporter;
  /** Test seam: alternative chat function. */
  _chat?: typeof gatewayChat;
  /** Test seam: skip DB query; cluster these atoms directly. */
  _atoms?: Array<{
    slug: string;
    concept_refs: string[];
    body: string;
    title: string;
    source_id?: string;
    source_slug?: string;
    research_policy?: string;
  }>;
}

interface AtomGroup {
  conceptSlug: string;
  atomTitles: string[];
  atomBodies: string[];
  atomSlugs: string[];
  sourceIds: string[];
  sourceSlugs: string[];
  researchPolicies: string[];
  evidence: Array<{ source_id: string; slug: string }>;
  tier: 'T1' | 'T2' | 'T3' | 'T4';
}

const SYNTH_PROMPT = `You write a 1-paragraph executive summary of a concept
based on multiple atom-shaped insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON,
no preamble. Write in plain English, present-tense voice. Synthesize what
the atoms collectively SAY about the concept; don't enumerate the atoms.`;

export async function runPhaseSynthesizeConcepts(
  engine: BrainEngine,
  opts: SynthesizeConceptsOpts = {},
): Promise<PhaseResult> {
  const chat = opts._chat ?? gatewayChat;

  // 1. Get atom pages (test seam OR DB query)
  let atoms = opts._atoms ?? [];
  if (atoms.length === 0 && opts._atoms === undefined) {
    try {
      const rows = await engine.executeRaw<{
        slug: string;
        source_id: string;
        title: string;
        compiled_truth: string;
        frontmatter: {
          concepts?: string[];
          imported_from?: string;
          source_slug?: string;
          research_policy?: string;
        };
      }>(
        `SELECT slug, source_id, title, compiled_truth, frontmatter
           FROM pages
          WHERE type = 'atom'
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`,
      );
      atoms = rows
        .filter((r) => Array.isArray(r.frontmatter?.concepts) && r.frontmatter.concepts.length > 0)
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          body: r.compiled_truth,
          concept_refs: r.frontmatter!.concepts!,
          source_id: r.source_id,
          source_slug: r.frontmatter?.source_slug,
          research_policy: r.frontmatter?.research_policy,
        }));
    } catch {
      // No atoms table or query failed — phase no-ops cleanly.
    }
  }

  if (atoms.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: 'synthesize_concepts: no atoms with concept refs',
      details: { reason: 'no_atoms' },
    };
  }

  // 2. Group atoms by concept slug
  const groups = new Map<string, {
    titles: string[];
    bodies: string[];
    atomSlugs: string[];
    sourceIds: string[];
    sourceSlugs: string[];
    researchPolicies: string[];
    evidence: Array<{ source_id: string; slug: string }>;
  }>();
  for (const atom of atoms) {
    for (const conceptSlug of atom.concept_refs) {
      const existing = groups.get(conceptSlug) ?? {
        titles: [],
        bodies: [],
        atomSlugs: [],
        sourceIds: [],
        sourceSlugs: [],
        researchPolicies: [],
        evidence: [],
      };
      existing.titles.push(atom.title);
      existing.bodies.push(atom.body);
      existing.atomSlugs.push(atom.slug);
      existing.sourceIds.push(atom.source_id ?? 'default');
      if (atom.source_slug) existing.sourceSlugs.push(atom.source_slug);
      if (atom.source_slug) {
        existing.evidence.push({
          source_id: atom.source_id ?? 'default',
          slug: atom.source_slug,
        });
      }
      if (atom.research_policy) existing.researchPolicies.push(atom.research_policy);
      groups.set(conceptSlug, existing);
    }
  }

  // 3. Filter to count ≥2, assign tier
  const atomGroups: AtomGroup[] = [];
  for (const [conceptSlug, data] of groups) {
    const count = data.titles.length;
    if (count < TIER_T3_MIN) continue;
    const allResearch = data.researchPolicies.length === count;
    if (allResearch) {
      const distinctOriginals = new Set(data.evidence.map((item) => `${item.source_id}\0${item.slug}`));
      if (distinctOriginals.size < 2) continue;
    }
    const tier: AtomGroup['tier'] =
      count >= TIER_T1_MIN ? 'T1' : count >= TIER_T2_MIN ? 'T2' : 'T3';
    atomGroups.push({
      conceptSlug,
      atomTitles: data.titles,
      atomBodies: data.bodies,
      atomSlugs: data.atomSlugs,
      sourceIds: data.sourceIds,
      sourceSlugs: data.sourceSlugs,
      researchPolicies: data.researchPolicies,
      evidence: data.evidence,
      tier,
    });
  }

  if (atomGroups.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: `synthesize_concepts: no concept groups with ≥${TIER_T3_MIN} atoms`,
      details: { reason: 'no_groups_above_threshold', atoms_seen: atoms.length },
    };
  }

  // 4. Per group: synthesize narrative (LLM for T1/T2, deterministic for T3+)
  let conceptsWritten = 0;
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;
  const failures: Array<{ concept: string; error: string }> = [];
  const tierCounts = { T1: 0, T2: 0, T3: 0, T4: 0 };
  let synthesisModel: string | undefined;

  async function getSynthesisModel(): Promise<string> {
    if (synthesisModel !== undefined) return synthesisModel;
    const { resolveModel } = await import('../model-config.ts');
    synthesisModel = await resolveModel(engine, {
      configKey: 'models.dream.synthesize_concepts',
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    return synthesisModel;
  }

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s — cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock + the existing external hook.
  // Pre-v0.41.19 the bare `if (opts.yieldDuringPhase) await ...()` at
  // every iteration fired hundreds of times per phase; the 30s throttle
  // matches the actual lock-refresh budget.
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesize_concepts] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  for (const group of atomGroups) {
    tierCounts[group.tier]++;
    const title = group.conceptSlug.split('/').pop() ?? group.conceptSlug;
    const distinctSources = [...new Set(group.sourceIds)].sort();
    const outputSourceId = distinctSources.length === 1 ? distinctSources[0] : 'default';
    const supportingAtoms = [...new Set(group.atomSlugs)].sort().slice(0, 20);
    const supportingEvidence = [...new Map(
      group.evidence.map((item) => [`${item.source_id}\0${item.slug}`, item]),
    ).values()]
      .sort((a, b) => a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug))
      .slice(0, 20);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        concept: group.conceptSlug,
        atoms: supportingAtoms,
        evidence: supportingEvidence,
        bodies: group.atomBodies,
      }))
      .digest('hex');
    const outputSlug = `concepts/${title}`;
    const outputPath = opts.dryRun
      ? null
      : await resolveGeneratedOutputPath(engine, outputSlug, {
          sourceId: outputSourceId,
          brainDir: opts.brainDir,
        });
    const expectedOutputDigest = outputPath ? readGeneratedOutputDigest(outputPath) : null;
    if (!opts.dryRun) {
      const existing = await engine.getPage(outputSlug, { sourceId: outputSourceId });
      if ((existing?.frontmatter as Record<string, unknown> | undefined)?.synthesis_fingerprint === fingerprint) {
        conceptsWritten++;
        opts.progress?.tick(1, `${conceptsWritten} concepts`);
        continue;
      }
    }
    let narrative: string;
    if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
      } else {
        try {
          const result = await chat({
            model: await getSynthesisModel(),
            system: SYNTH_PROMPT,
            messages: [
              {
                role: 'user',
                content:
                  `Concept slug: ${group.conceptSlug}\n` +
                  `${group.atomTitles.length} atoms reference this concept.\n\n` +
                  `Sample atom titles:\n${group.atomTitles.slice(0, 10).map((t) => `  - ${t}`).join('\n')}\n\n` +
                  `Sample atom bodies:\n${group.atomBodies
                    .slice(0, 5)
                    .map((b, i) => `${i + 1}. ${b.slice(0, 500)}`)
                    .join('\n\n')}`,
              },
            ],
            maxTokens: 500,
          });
          // Post-await yield (T3): the LLM call is the main TTL hazard
          // codex flagged. Throttle inside maybeYield bounds the actual
          // refresh rate.
          await maybeYield();
          // Sonnet at ~$3/M input + $15/M output
          estimatedSpendUsd +=
            (result.usage.input_tokens * 3.0 + result.usage.output_tokens * 15.0) / 1_000_000;
          narrative = result.text.trim() || deterministicNarrative(group);
        } catch (err) {
          failures.push({
            concept: group.conceptSlug,
            error: err instanceof Error ? err.message : String(err),
          });
          narrative = deterministicNarrative(group);
        }
      }
    } else {
      narrative = deterministicNarrative(group);
    }

    if (!opts.dryRun) {
      // #2163: serialize to markdown and import via the canonical pipeline so
      // the page is chunked (+ embedded when a provider is configured) —
      // mirrors put_page's isAvailable('embedding') → noEmbed gate.
      const md = serializeMarkdown(
        {
          tier: group.tier,
          mention_count: group.atomTitles.length,
          composite_score: group.atomTitles.length,
          synthesized_by: 'synthesize_concepts-v0.41',
          synthesis_fingerprint: fingerprint,
          supporting_atoms: supportingAtoms,
          supporting_sources: supportingEvidence,
          ...(group.researchPolicies.length === group.atomSlugs.length
            ? { research_policy: group.researchPolicies[0] }
            : {}),
          gbrain_generated: true,
        },
        supportingEvidence.length > 0
          ? `${narrative}\n\n## Supporting research\n\n${supportingEvidence
              .map(({ source_id, slug }) => `- [[${source_id}:${slug}]]`)
              .join('\n')}`
          : narrative,
        '',
        { type: 'concept', title: title.replace(/-/g, ' '), tags: [] },
      );
      const write = await writeGeneratedOutput(engine, outputSlug, md, {
        sourceId: outputSourceId,
        brainDir: opts.brainDir,
        expectedDigest: expectedOutputDigest,
        noEmbed: !isAvailable('embedding'),
      });
      if (write.status === 'conflict' || write.status === 'file_only') {
        failures.push({ concept: group.conceptSlug, error: write.error ?? write.status });
      }
    }
    conceptsWritten++;
    // v0.41.19.0 (T4): one tick per concept group with running count.
    opts.progress?.tick(1, `${conceptsWritten} concepts`);

    // v0.41.19.0 (T3): replaced bare per-iteration fire with throttled
    // helper. Same hook, same cycle-lock refresh effect, just at the
    // right cadence (30s instead of every-group).
    await maybeYield();
  }

  // v0.42 Wave B3: receipt + rollup for synthesize_concepts. Brain-global
  // phase — uses 'default' source_id because concepts span sources. Receipt
  // only fires when concepts were actually written; rollup always fires so
  // doctor sees the phase ran.
  if (!opts.dryRun && conceptsWritten > 0) {
    const runId = `concepts-${Date.now().toString(36)}`;
    try {
      await writeReceipt(engine, {
        kind: 'concepts',
        source_id: 'default',
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: conceptsWritten,
        cost_usd: estimatedSpendUsd,
        summary:
          `Synthesized ${conceptsWritten} concepts ` +
          `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3}) ` +
          `from ${atomGroups.length} groups across ${atoms.length} atoms.`,
      });
    } catch (err) {
      console.error(`[synthesize_concepts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'concepts',
      source_id: 'default',
      cost_delta: estimatedSpendUsd,
      round_completed_delta: failures.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'synthesize_concepts',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `synthesize_concepts: ${conceptsWritten} concepts ` +
      `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3})` +
      (failures.length > 0 ? ` (${failures.length} LLM-failed → template fallback)` : ''),
    details: {
      concepts_written: conceptsWritten,
      tier_counts: tierCounts,
      groups_found: atomGroups.length,
      atoms_seen: atoms.length,
      failures,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * Deterministic fallback narrative for T3/T4 concepts and budget-exhausted
 * T1/T2 groups. No LLM call. v0.41 minimal shape — v0.42 enriches with
 * dominant themes, time spread, breadth.
 */
function deterministicNarrative(group: AtomGroup): string {
  const tier = group.tier;
  const count = group.atomTitles.length;
  return (
    `${tier} concept. ${count} atom${count === 1 ? '' : 's'} reference this. ` +
    `Top mentions:\n${group.atomTitles
      .slice(0, 5)
      .map((t) => `  - ${t}`)
      .join('\n')}`
  );
}
