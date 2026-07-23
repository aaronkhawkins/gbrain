// v0.41 T5+T6 — extract_atoms + synthesize_concepts minimal-viable bodies.
//
// Tests the LLM-driven extraction + synthesis paths with a stubbed
// chat function so no real Haiku/Sonnet calls fire in CI. Pins:
//   - extract_atoms parses Haiku JSON output, writes atom-typed pages
//   - parseAtomsResponse tolerates markdown fences + trailing prose
//   - extract_atoms skips invalid atom_type values
//   - extract_atoms budget cap halts mid-run
//   - synthesize_concepts groups atoms by concept frontmatter ref
//   - tier assignment by count (T1 ≥10, T2 ≥5, T3 ≥2)
//   - T1/T2 use LLM narrative; T3 falls back deterministic
//   - dry-run mode counts but doesn't write

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, parseAtomsResponse } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let brainDir: string;
let stateDir: string;
const priorGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-output-'));
  stateDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-state-'));
  process.env.GBRAIN_HOME = stateDir;
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [brainDir, 'default']);
});

function stubChat(
  text: string,
  opts: { input_tokens?: number; output_tokens?: number; model?: string } = {},
): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: opts.input_tokens ?? 500,
      output_tokens: opts.output_tokens ?? 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: opts.model ?? 'anthropic:claude-haiku-4-5',
    providerId: (opts.model ?? 'anthropic:claude-haiku-4-5').split(':')[0],
  });
}

describe('v0.41 T5: parseAtomsResponse', () => {
  test('parses well-formed JSON array', () => {
    const raw = `[{"title":"Test","atom_type":"insight","body":"body text"}]`;
    const atoms = parseAtomsResponse(raw);
    expect(atoms.length).toBe(1);
    expect(atoms[0].title).toBe('Test');
    expect(atoms[0].atom_type).toBe('insight');
  });

  test('strips markdown code fences', () => {
    const raw = '```json\n[{"title":"T","atom_type":"quote","body":"b"}]\n```';
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('tolerates trailing prose after JSON', () => {
    const raw = `[{"title":"T","atom_type":"framework","body":"b"}]\n\nThanks!`;
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('rejects atoms with invalid atom_type', () => {
    const raw = `[{"title":"T","atom_type":"made_up_type","body":"b"}]`;
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('rejects atoms missing required fields', () => {
    const raw = `[{"title":"T","atom_type":"insight"}]`; // no body
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('returns [] on garbage input', () => {
    expect(parseAtomsResponse('not json')).toEqual([]);
    expect(parseAtomsResponse('')).toEqual([]);
  });

  test('accepts all 11 declared atom_type values', () => {
    const types = ['insight', 'anecdote', 'quote', 'framework', 'statistic',
                   'story_angle', 'strategy_angle', 'strategy', 'endorsement',
                   'critique', 'collection'];
    for (const t of types) {
      const raw = `[{"title":"x","atom_type":"${t}","body":"b"}]`;
      const atoms = parseAtomsResponse(raw);
      expect(atoms.length).toBe(1);
      expect(atoms[0].atom_type as string).toBe(t);
    }
  });

  test('clamps virality_score to [0, 100]', () => {
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":150}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":-5}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":75}]`)[0].virality_score).toBe(75);
  });
});

describe('v0.41 T5: runPhaseExtractAtoms via stubbed chat', () => {
  test('no-op when no transcripts AND no pages provided', async () => {
    // v0.41.2.1: _pages:[] suppresses page-discovery so this matches the
    // pre-v0.41.2.1 "transcript-only no-op" path. Reason changed from
    // 'no_transcripts' to 'no_work' to reflect the dual-source design.
    const noConfigEngine = {
      getConfig: () => {
        throw new Error('no-work path must not resolve a model');
      },
    };
    const result = await runPhaseExtractAtoms(noConfigEngine as never, {
      _transcripts: [],
      _pages: [],
    });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_work');
  });

  test('passes models.dream.extract_atoms to the injected chat seam', async () => {
    await engine.setConfig('models.dream.extract_atoms', 'sentinel:extract-atoms');
    let capturedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      capturedModel = opts.model;
      return stubChat(`[{"title":"routed","atom_type":"insight","body":"b"}]`)(opts);
    };

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/routed.txt', content: 'c', contentHash: 'route-hash' }],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });

    expect(capturedModel).toBe('sentinel:extract-atoms');
  });

  test('falls back to the utility tier model for atom extraction', async () => {
    await engine.setConfig('models.tier.utility', 'sentinel:utility-tier');
    let capturedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      capturedModel = opts.model;
      return stubChat(`[{"title":"tiered","atom_type":"insight","body":"b"}]`)(opts);
    };

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/tiered.txt', content: 'c', contentHash: 'tier-hash' }],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });

    expect(capturedModel).toBe('sentinel:utility-tier');
  });

  test('extracts atoms from transcript via stub chat', async () => {
    const chat = stubChat(`[
      {"title":"Renders vs physical proof","atom_type":"insight","body":"Enterprise buyers want tangible prototypes."},
      {"title":"Founder lesson","atom_type":"anecdote","body":"Story about a founder."}
    ]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting.txt', content: 'content', contentHash: 'abc123def' }],
      _pages: [], // suppress page discovery — transcript-only test
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2);
    expect(result.details?.transcripts_processed).toBe(1);

    // Verify pages were written
    const rows = await engine.executeRaw<{ slug: string; type: string }>(
      `SELECT slug, type FROM pages WHERE type = 'atom'`,
    );
    expect(rows.length).toBe(2);
  });

  test('dry-run counts but does NOT write', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/x.txt', content: 'c', contentHash: 'h' }],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('failures tracked per-transcript without halting', async () => {
    let callCount = 0;
    const chat = async (_o: ChatOpts) => {
      callCount++;
      if (callCount === 1) throw new Error('rate limit');
      return {
        text: `[{"title":"t","atom_type":"insight","body":"b"}]`,
        blocks: [],
        stopReason: 'end' as const,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/a.txt', content: 'a', contentHash: 'ha' },
        { filePath: '/b.txt', content: 'b', contentHash: 'hb' },
      ],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });
    expect(result.status).toBe('warn');
    expect(result.details?.atoms_extracted).toBe(1);
    expect((result.details?.failures as unknown[]).length).toBe(1);
  });

  // v0.41.2.1 regression case (D9 #14 wording): with _pages:[] and same
  // _transcripts, all PRE-EXISTING PhaseResult.details fields match
  // pre-fix values byte-for-byte. The new fields (pages_processed,
  // pages_total, pages_skipped_budget, duplicates_skipped) exist but
  // are zeros. Closes the "transcript path silently regresses" risk.
  test('legacy transcript-only fields unchanged when _pages:[] (regression guard)', async () => {
    const chat = stubChat(`[{"title":"r","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/regression.txt', content: 'c', contentHash: 'rH' }],
      _pages: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    // Pre-existing fields — must keep their pre-fix values verbatim
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.transcripts_processed).toBe(1);
    expect(result.details?.transcripts_total).toBe(1);
    expect(result.details?.transcripts_skipped_budget).toBe(0);
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.budget_usd).toBe(0.3);
    expect(result.details?.source_id).toBe('default');
    expect(result.details?.dry_run).toBe(false);
    // New additive fields — zero when no page work
    expect(result.details?.pages_processed).toBe(0);
    expect(result.details?.pages_total).toBe(0);
    expect(result.details?.pages_skipped_budget).toBe(0);
    expect(result.details?.duplicates_skipped).toBe(0);
  });

  test('local routed model does not consume the phase budget', async () => {
    const localModel = 'vllm:nvidia/Qwen3.6-35B-A3B-NVFP4';
    await engine.setConfig('models.dream.extract_atoms', localModel);
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return stubChat(
        `[{"title":"local-${calls}","atom_type":"insight","body":"b"}]`,
        { input_tokens: 1_000_000, output_tokens: 1_000_000, model: localModel },
      )(opts);
    };

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/local-a.txt', content: 'a', contentHash: 'local-a' },
        { filePath: '/local-b.txt', content: 'b', contentHash: 'local-b' },
      ],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });

    expect(calls).toBe(2);
    expect(result.details?.estimated_spend_usd).toBe(0);
    expect(result.details?.transcripts_skipped_budget).toBe(0);
  });

  test('paid routed model still enforces the phase budget', async () => {
    const paidModel = 'anthropic:claude-haiku-4-5';
    await engine.setConfig('models.dream.extract_atoms', paidModel);
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return stubChat(
        `[{"title":"paid-${calls}","atom_type":"insight","body":"b"}]`,
        { input_tokens: 1_000_000, output_tokens: 1_000_000, model: paidModel },
      )(opts);
    };

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/paid-a.txt', content: 'a', contentHash: 'paid-a' },
        { filePath: '/paid-b.txt', content: 'b', contentHash: 'paid-b' },
      ],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });

    expect(calls).toBe(1);
    expect(result.details?.estimated_spend_usd).toBe(6);
    expect(result.details?.transcripts_skipped_budget).toBe(1);
  });
});

describe('v0.41 T6: runPhaseSynthesizeConcepts via stubbed chat', () => {
  test('no-op when no atoms have concept refs', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_atoms');
  });

  test('groups atoms by concept and assigns tier by count', async () => {
    const atoms: Array<{ slug: string; title: string; body: string; concept_refs: string[] }> = [];
    for (let i = 0; i < 12; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/atom-${i}`,
        title: `Atom ${i}`,
        body: `Body of atom ${i}.`,
        concept_refs: ['ai-agents'],
      });
    }
    for (let i = 0; i < 6; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/founder-${i}`,
        title: `Founder ${i}`,
        body: `Founder body ${i}.`,
        concept_refs: ['founder-psychology'],
      });
    }
    for (let i = 0; i < 3; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/hw-${i}`,
        title: `HW ${i}`,
        body: `HW body ${i}.`,
        concept_refs: ['hardware-renaissance'],
      });
    }

    const chat = stubChat('AI agents are software factories.');
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    expect(result.status).toBe('ok');
    expect(result.details?.concepts_written).toBe(3);
    const tiers = result.details?.tier_counts as Record<string, number>;
    expect(tiers.T1).toBe(1); // ai-agents (12)
    expect(tiers.T2).toBe(1); // founder-psychology (6)
    expect(tiers.T3).toBe(1); // hardware-renaissance (3)
  });

  test('atoms with no concept refs are filtered out', async () => {
    const atoms = [
      { slug: 's1', title: 't1', body: 'b1', concept_refs: [] },
      { slug: 's2', title: 't2', body: 'b2', concept_refs: [] },
    ];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
  });

  test('concept count below T3 threshold (2) is filtered out', async () => {
    const atoms = [{ slug: 's', title: 't', body: 'b', concept_refs: ['only-one-mention'] }];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_groups_above_threshold');
  });

  test('T3 concepts use deterministic narrative (no LLM call)', async () => {
    const atoms = [
      { slug: 'a1', title: 'A1', body: 'b1', concept_refs: ['theme'] },
      { slug: 'a2', title: 'A2', body: 'b2', concept_refs: ['theme'] },
    ];
    let chatCalled = false;
    const chat = async (_o: ChatOpts) => {
      chatCalled = true;
      return stubChat('should not be called')(_o);
    };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat });
    expect(chatCalled).toBe(false);
  });

  test('T3-only synthesis does not resolve model configuration', async () => {
    const atoms = [
      { slug: 'a1', title: 'A1', body: 'b1', concept_refs: ['theme'] },
      { slug: 'a2', title: 'A2', body: 'b2', concept_refs: ['theme'] },
    ];
    const noConfigEngine = {
      getConfig: () => {
        throw new Error('T3-only path must not resolve a model');
      },
    };

    const result = await runPhaseSynthesizeConcepts(noConfigEngine as never, {
      _atoms: atoms,
      dryRun: true,
    });

    expect(result.status).toBe('ok');
    expect(result.details?.tier_counts).toMatchObject({ T3: 1 });
  });

  test('passes models.dream.synthesize_concepts to the injected chat seam', async () => {
    await engine.setConfig('models.dream.synthesize_concepts', 'sentinel:synthesize-concepts');
    const atoms = Array.from({ length: 10 }, (_, i) => ({
      slug: `configured-${i}`,
      title: `Configured ${i}`,
      body: `body ${i}`,
      concept_refs: ['configured-theme'],
    }));
    let capturedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      capturedModel = opts.model;
      return stubChat('Configured synthesis.')(opts);
    };

    await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });

    expect(capturedModel).toBe('sentinel:synthesize-concepts');
  });

  test('falls back to the reasoning tier model for concept synthesis', async () => {
    await engine.setConfig('models.tier.reasoning', 'sentinel:reasoning-tier');
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `tiered-${i}`,
      title: `Tiered ${i}`,
      body: `body ${i}`,
      concept_refs: ['tiered-theme'],
    }));
    let capturedModel: string | undefined;
    const chat = async (opts: ChatOpts) => {
      capturedModel = opts.model;
      return stubChat('Tiered synthesis.')(opts);
    };

    await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });

    expect(capturedModel).toBe('sentinel:reasoning-tier');
  });

  test('local routed model synthesizes every eligible group without consuming budget', async () => {
    const localModel = 'vllm:nvidia/Qwen3.6-35B-A3B-NVFP4';
    await engine.setConfig('models.dream.synthesize_concepts', localModel);
    const atoms = ['local-theme-a', 'local-theme-b'].flatMap((concept) =>
      Array.from({ length: 5 }, (_, i) => ({
        slug: `${concept}-${i}`,
        title: `${concept} ${i}`,
        body: `body ${i}`,
        concept_refs: [concept],
      })),
    );
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return stubChat('Local synthesis.', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model: localModel,
      })(opts);
    };

    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });

    expect(calls).toBe(2);
    expect(result.details?.estimated_spend_usd).toBe(0);
  });

  test('paid routed model still stops LLM synthesis after the phase budget', async () => {
    const paidModel = 'anthropic:claude-sonnet-4-6';
    await engine.setConfig('models.dream.synthesize_concepts', paidModel);
    const atoms = ['paid-theme-a', 'paid-theme-b'].flatMap((concept) =>
      Array.from({ length: 5 }, (_, i) => ({
        slug: `${concept}-${i}`,
        title: `${concept} ${i}`,
        body: `body ${i}`,
        concept_refs: [concept],
      })),
    );
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return stubChat('Paid synthesis.', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model: paidModel,
      })(opts);
    };

    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });

    expect(calls).toBe(1);
    expect(result.details?.concepts_written).toBe(2);
    expect(result.details?.estimated_spend_usd).toBe(18);
  });

  test('dry-run counts but does NOT write', async () => {
    const atoms = Array.from({ length: 6 }, (_, i) => ({
      slug: `s${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('synthesized narrative');
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.concepts_written).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'concept' AND slug LIKE 'concepts/%'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('T1 concept gets LLM-synthesized narrative', async () => {
    const atoms = Array.from({ length: 12 }, (_, i) => ({
      slug: `a${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('Custom synthesized narrative from LLM.');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const rows = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE slug = 'concepts/theme'`,
    );
    expect(rows[0].compiled_truth).toContain('Custom synthesized narrative');
  });

  // #2163: concept pages must enter the retrieval surface. The write routes
  // through importFromContent (the same parse→chunk pipeline put_page uses),
  // so content_chunks rows exist and source-boost's 1.3× 'concepts/' weight
  // has something to boost. (Embeddings are skipped in this env — no
  // provider — but chunks + search_vector land regardless.)
  test('concept pages are chunked (#2163)', async () => {
    const atoms = Array.from({ length: 12 }, (_, i) => ({
      slug: `c${i}`,
      title: `Chunk atom ${i}`,
      body: `Chunky body ${i}.`,
      concept_refs: ['chunked-concept'],
    }));
    const chat = stubChat('A concept narrative long enough to produce at least one chunk.');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.slug = 'concepts/chunked-concept'`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
    // Page metadata survives the importFromContent round-trip.
    const page = await engine.executeRaw<{ type: string; fm: Record<string, unknown> }>(
      `SELECT type, frontmatter AS fm FROM pages WHERE slug = 'concepts/chunked-concept'`,
    );
    expect(page[0].type).toBe('concept');
    expect((page[0].fm as Record<string, unknown>).tier).toBe('T1');
  });

  test('unchanged T1 evidence skips the LLM and file rewrite on repeat', async () => {
    const atoms = Array.from({ length: 10 }, (_, i) => ({
      slug: `repeat-${i}`,
      title: `Repeat ${i}`,
      body: `Stable body ${i}.`,
      concept_refs: ['stable-theme'],
    }));
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return stubChat('Stable synthesized narrative.')(opts);
    };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const path = join(brainDir, 'concepts/stable-theme.md');
    const before = (await import('node:fs')).statSync(path).mtimeMs;
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    expect(calls).toBe(1);
    expect((await import('node:fs')).statSync(path).mtimeMs).toBe(before);
  });

  test('marked research needs two distinct original pages before promotion', async () => {
    const oneOriginal = [
      {
        slug: 'atoms/a',
        title: 'A',
        body: 'A',
        concept_refs: ['research-theme'],
        source_id: 'default',
        source_slug: 'media/x/one',
        research_policy: 'birdclaw-research-v1',
      },
      {
        slug: 'atoms/b',
        title: 'B',
        body: 'B',
        concept_refs: ['research-theme'],
        source_id: 'default',
        source_slug: 'media/x/one',
        research_policy: 'birdclaw-research-v1',
      },
    ];
    const skipped = await runPhaseSynthesizeConcepts(engine, { _atoms: oneOriginal });
    expect(skipped.status).toBe('skipped');

    const promoted = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        oneOriginal[0],
        { ...oneOriginal[1], source_slug: 'media/x/two' },
      ],
    });
    expect(promoted.status).toBe('ok');
    const page = await engine.getPage('concepts/research-theme');
    expect((page?.frontmatter as Record<string, unknown>).research_policy).toBe('birdclaw-research-v1');
  });
});
