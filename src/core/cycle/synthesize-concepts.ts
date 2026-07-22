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
import { chat as gatewayChat } from '../ai/gateway.ts';
import { BIRDCLAW_RESEARCH_POLICY, hasResearchPolicy } from './research-provenance.ts';
import { generatedPageChunks, putGeneratedSearchablePage } from '../generated-page-indexer.ts';
import { createHash } from 'node:crypto';

const DEFAULT_BUDGET_USD = 1.5;
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;
const MAX_SUPPORTING_ATOMS = 20;
const MAX_SUPPORTING_SOURCES = 20;

interface ConceptAtom {
  slug: string;
  concept_refs: string[];
  body: string;
  title: string;
  source_id?: string;
  source_slug?: string;
  source_hash?: string;
  research_policy?: string;
  updated_at?: Date;
}

interface EvidenceRef {
  source_id: string;
  slug: string;
  source_hash?: string;
}

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
  _atoms?: ConceptAtom[];
}

interface AtomGroup {
  conceptSlug: string;
  atomTitles: string[];
  atomBodies: string[];
  supportingAtoms: EvidenceRef[];
  supportingSources: EvidenceRef[];
  supportCount: number;
  researchPolicy?: typeof BIRDCLAW_RESEARCH_POLICY;
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  latestInputUpdatedAt?: Date;
}

const SYNTHESIS_INPUT_VERSION = 'synthesize-concepts-input-v1';

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
        title: string;
        compiled_truth: string;
        source_id: string;
        frontmatter: {
          concepts?: string[];
          imported_from?: string;
          source_slug?: string;
          source_hash?: string;
          research_policy?: string;
        };
          updated_at: Date;
      }>(
        `SELECT slug, source_id, title, compiled_truth, frontmatter, updated_at
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
          source_hash: r.frontmatter?.source_hash,
          research_policy: r.frontmatter?.research_policy,
          updated_at: r.updated_at,
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
  const groups = new Map<string, ConceptAtom[]>();
  for (const atom of atoms) {
    for (const conceptSlug of atom.concept_refs) {
      const existing = groups.get(conceptSlug) ?? [];
      existing.push(atom);
      groups.set(conceptSlug, existing);
    }
  }

  // 3. Filter to count ≥2, assign tier
  const atomGroups: AtomGroup[] = [];
  for (const [conceptSlug, data] of groups) {
    const ordered = [...data].sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b)));
    // Mixed groups deliberately use upstream behavior. A research marker is
    // never inherited by unmarked atoms merely because concept refs collide.
    const allMarked = ordered.every((atom) => hasResearchPolicy({
      research_policy: atom.research_policy,
    }));
    const researchPolicy = allMarked
      ? BIRDCLAW_RESEARCH_POLICY
      : undefined;
    const sourceBacked = researchPolicy ? ordered.filter((atom) => atom.source_slug) : [];
    const supportingSources = researchPolicy
      ? dedupeEvidence(sourceBacked.map((atom) => ({
          source_id: atom.source_id ?? 'default',
          slug: atom.source_slug!,
          ...(atom.source_hash && { source_hash: atom.source_hash }),
        })))
      : [];
    // Marked research promotes by distinct original sources. Unmarked and
    // mixed groups retain upstream count-based promotion.
    const supportCount = researchPolicy ? supportingSources.length : ordered.length;
    if (supportCount < TIER_T3_MIN) continue;
    const tier: AtomGroup['tier'] =
      supportCount >= TIER_T1_MIN ? 'T1' : supportCount >= TIER_T2_MIN ? 'T2' : 'T3';
    atomGroups.push({
      conceptSlug,
      atomTitles: ordered.map((atom) => atom.title),
      atomBodies: ordered.map((atom) => atom.body),
      supportingAtoms: researchPolicy
        ? dedupeEvidence(ordered.map((atom) => ({
            source_id: atom.source_id ?? 'default',
            slug: atom.slug,
            ...(atom.source_hash && { source_hash: atom.source_hash }),
          })))
        : [],
      supportingSources,
      supportCount,
      ...(researchPolicy && { researchPolicy }),
      tier,
      ...latestUpdatedAt(ordered),
    });
  }
  atomGroups.sort((a, b) => a.conceptSlug.localeCompare(b.conceptSlug));

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
  let conceptsProcessed = 0;
  let conceptsUnchanged = 0;
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;
  const failures: Array<{ concept: string; error: string }> = [];
  const tierCounts = { T1: 0, T2: 0, T3: 0, T4: 0 };

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
    const conceptSlug = `concepts/${title}`;
    const evidenceSection = renderEvidence(group.supportingSources, group.supportingAtoms);
    const inputHash = synthesisInputHash(group);
    const baseFrontmatter = {
      type: 'concept',
      tier: group.tier,
      mention_count: group.atomTitles.length,
      composite_score: group.supportCount,
      ...(group.researchPolicy && {
        research_policy: group.researchPolicy,
        support_count: group.supportCount,
        supporting_atoms: group.supportingAtoms.slice(0, MAX_SUPPORTING_ATOMS),
        supporting_sources: group.supportingSources.slice(0, MAX_SUPPORTING_SOURCES),
      }),
      synthesized_by: 'synthesize_concepts-v0.41',
    };
    const frontmatter = {
      ...baseFrontmatter,
      synthesis_input_hash: inputHash,
    };
    const existing = opts.dryRun
      ? null
      : await engine.getPage(conceptSlug, { sourceId: 'default' });

    // The old implementation called the LLM before checking whether the page
    // was already current. On a mature brain that meant hundreds of identical
    // summaries per dream cycle. The input hash is derived solely from the
    // evidence the prompt consumes, so it is safe to check before synthesis.
    // Legacy pages have no hash; when their page is newer than every input atom
    // and their metadata/chunks still match, preserve them without a one-time
    // expensive regeneration. The first changed atom moves them onto the hash.
    const previousSynthesisSucceeded = group.tier === 'T3' ||
      existing?.frontmatter.synthesis_status === 'generated';
    const exactInputMatch = existing?.frontmatter.synthesis_input_hash === inputHash &&
      previousSynthesisSucceeded;
    const legacyNarrativeLooksSuccessful = group.tier === 'T3' ||
      !existing?.compiled_truth.startsWith(`${group.tier} concept.`);
    const legacyInputMatch = existing != null &&
      existing.frontmatter.synthesis_input_hash === undefined &&
      group.latestInputUpdatedAt !== undefined &&
      existing.updated_at >= group.latestInputUpdatedAt &&
      legacyNarrativeLooksSuccessful &&
      Object.entries(baseFrontmatter).every(([key, value]) =>
        canonicalJson(existing.frontmatter[key]) === canonicalJson(value),
      );
    if (existing && (exactInputMatch || legacyInputMatch)) {
      const expectedFrontmatter = exactInputMatch ? frontmatter : baseFrontmatter;
      const compiledTruth = existing.compiled_truth;
      if (await conceptPageIsCurrent(engine, conceptSlug, existing, compiledTruth, expectedFrontmatter)) {
        conceptsProcessed++;
        conceptsUnchanged++;
        opts.progress?.tick(1, `${conceptsProcessed} concepts`);
        await maybeYield();
        continue;
      }
    }

    let narrative: string;
    let synthesisStatus: 'generated' | 'deterministic' | 'fallback_budget' | 'fallback_error' =
      group.tier === 'T3' ? 'deterministic' : 'generated';
    if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
        synthesisStatus = 'fallback_budget';
      } else {
        try {
          const result = await chat({
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
          if (!result.text.trim()) synthesisStatus = 'fallback_error';
        } catch (err) {
          failures.push({
            concept: group.conceptSlug,
            error: err instanceof Error ? err.message : String(err),
          });
          narrative = deterministicNarrative(group);
          synthesisStatus = 'fallback_error';
        }
      }
    } else {
      narrative = deterministicNarrative(group);
    }

    if (!opts.dryRun) {
      const compiledTruth = evidenceSection ? `${narrative}\n\n${evidenceSection}` : narrative;
      const outputFrontmatter = { ...frontmatter, synthesis_status: synthesisStatus };
      if (await conceptPageIsCurrent(engine, conceptSlug, existing, compiledTruth, outputFrontmatter)) {
        conceptsProcessed++;
        conceptsUnchanged++;
        opts.progress?.tick(1, `${conceptsProcessed} concepts`);
        await maybeYield();
        continue;
      }
      await putGeneratedSearchablePage(engine, conceptSlug, {
        title: title.replace(/-/g, ' '),
        type: 'concept',
        compiled_truth: compiledTruth,
        frontmatter: outputFrontmatter,
        timeline: '',
      }, { sourceId: 'default' });
    }
    conceptsWritten++;
    conceptsProcessed++;
    // v0.41.19.0 (T4): one tick per concept group with running count.
    opts.progress?.tick(1, `${conceptsProcessed} concepts`);

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
      concepts_unchanged: conceptsUnchanged,
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

function latestUpdatedAt(atoms: ConceptAtom[]): { latestInputUpdatedAt: Date } | Record<string, never> {
  const timestamps = atoms
    .map((atom) => atom.updated_at)
    .filter((value): value is Date => value instanceof Date);
  if (timestamps.length !== atoms.length || timestamps.length === 0) return {};
  return { latestInputUpdatedAt: new Date(Math.max(...timestamps.map((value) => value.getTime()))) };
}

function synthesisInputHash(group: AtomGroup): string {
  const input = {
    version: SYNTHESIS_INPUT_VERSION,
    concept: group.conceptSlug,
    tier: group.tier,
    support_count: group.supportCount,
    titles: group.atomTitles.slice(0, 10),
    bodies: group.atomBodies.slice(0, 5).map((body) => body.slice(0, 500)),
    sources: group.supportingSources.slice(0, MAX_SUPPORTING_SOURCES),
    atoms: group.supportingAtoms.slice(0, MAX_SUPPORTING_ATOMS),
  };
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function evidenceKey(atom: ConceptAtom): string {
  return `${atom.source_id ?? 'default'}::${atom.source_slug ?? atom.slug}::${atom.slug}`;
}

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const ref of refs) unique.set(`${ref.source_id}::${ref.slug}`, ref);
  return [...unique.values()].sort((a, b) =>
    `${a.source_id}::${a.slug}`.localeCompare(`${b.source_id}::${b.slug}`),
  );
}

function renderEvidence(sources: EvidenceRef[], atoms: EvidenceRef[]): string {
  if (sources.length === 0 && atoms.length === 0) return '';
  const sourceLinks = sources.slice(0, MAX_SUPPORTING_SOURCES).map((source) =>
    `- [[${source.source_id}:${source.slug}]]`,
  );
  const atomLinks = atoms.slice(0, MAX_SUPPORTING_ATOMS).map((atom) =>
    `- [[${atom.source_id}:${atom.slug}]]`,
  );
  return [
    ...(sourceLinks.length > 0 ? [`## Supporting research\n\n${sourceLinks.join('\n')}`] : []),
    ...(atomLinks.length > 0 ? [`## Supporting atoms\n\n${atomLinks.join('\n')}`] : []),
  ].join('\n\n');
}

function conceptPageMatches(
  existing: Awaited<ReturnType<BrainEngine['getPage']>>,
  compiledTruth: string,
  expectedFrontmatter: Record<string, unknown>,
): boolean {
  if (!existing || existing.compiled_truth !== compiledTruth) return false;
  const actual = existing.frontmatter as Record<string, unknown>;
  return Object.entries(expectedFrontmatter).every(([key, value]) =>
    canonicalJson(actual[key]) === canonicalJson(value),
  );
}

async function conceptPageIsCurrent(
  engine: BrainEngine,
  slug: string,
  existing: Awaited<ReturnType<BrainEngine['getPage']>>,
  compiledTruth: string,
  expectedFrontmatter: Record<string, unknown>,
): Promise<boolean> {
  if (!conceptPageMatches(existing, compiledTruth, expectedFrontmatter)) return false;

  const expected = generatedPageChunks({ compiled_truth: compiledTruth, timeline: '' });
  const actual = await engine.getChunks(slug, { sourceId: 'default' });
  return actual.length === expected.length && actual.every((chunk, index) => {
    const wanted = expected[index];
    return wanted !== undefined &&
      chunk.chunk_index === wanted.chunk_index &&
      chunk.chunk_source === wanted.chunk_source &&
      chunk.chunk_text === wanted.chunk_text;
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
