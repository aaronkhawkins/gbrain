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
import {
  runPhaseSynthesizeConcepts,
  type SynthesizeConceptsOpts,
} from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';
import { putGeneratedSearchablePage } from '../../src/core/generated-page-indexer.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function stubChat(text: string, opts: { input_tokens?: number; output_tokens?: number } = {}): (o: ChatOpts) => Promise<ChatResult> {
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
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
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

  test('normalizes, deduplicates, and caps concept references', () => {
    const raw = JSON.stringify([{
      title: 'Conceptful atom', atom_type: 'insight', body: 'body',
      concepts: [' Agent Workflows ', 'agent workflows', 'iOS Development!', '', 'AI',
        'Enterprise Architecture', 'Knowledge Graphs', 'Local Models', 'ignored sixth'],
    }]);
    expect(parseAtomsResponse(raw, 'json', true)[0].concepts).toEqual([
      'agent-workflows',
      'ios-development',
      'enterprise-architecture',
      'knowledge-graphs',
      'local-models',
    ]);
  });

  test('ignores malformed concepts without rejecting a valid atom', () => {
    const atom = parseAtomsResponse(
      `[{"title":"T","atom_type":"insight","body":"b","concepts":"not-an-array"}]`,
      'json',
      true,
    )[0];
    expect(atom).toBeDefined();
    expect(atom.concepts).toBeUndefined();
  });

  test('parses OpenCode-compatible labeled atom records', () => {
    const atoms = parseAtomsResponse(`TITLE: Declarative state simplifies UI updates
TYPE: insight
BODY: SwiftUI derives views from state and refreshes them automatically.
SOURCE_QUOTE: State drives the view.
LESSON: Prefer state-driven rendering.
VIRALITY_SCORE: 72
EMOTIONAL_REGISTER: practical
CONCEPTS: SwiftUI; Declarative UI; State-driven rendering
---
TITLE: A second durable idea
TYPE: framework
BODY: Separate domain state from view composition.`);
    expect(atoms).toHaveLength(2);
    expect(atoms[0]).toMatchObject({
      title: 'Declarative state simplifies UI updates',
      atom_type: 'insight',
      virality_score: 72,
      concepts: ['swiftui', 'declarative-ui', 'state-driven-rendering'],
    });
    expect(atoms[1].atom_type).toBe('framework');
  });
});

describe('v0.41 T5: runPhaseExtractAtoms via stubbed chat', () => {
  test('no-op when no transcripts AND no pages provided', async () => {
    // v0.41.2.1: _pages:[] suppresses page-discovery so this matches the
    // pre-v0.41.2.1 "transcript-only no-op" path. Reason changed from
    // 'no_transcripts' to 'no_work' to reflect the dual-source design.
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_work');
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
    const indexed = await engine.executeRaw<{ count: number | string }>(
      `SELECT COUNT(DISTINCT p.id)::int AS count
         FROM pages p JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.type = 'atom'`,
    );
    expect(Number(indexed[0].count)).toBe(2);
  });

  test('persists normalized concepts in atom frontmatter', async () => {
    const chat = stubChat(`[{"title":"Native bookmark concepts","atom_type":"insight","body":"body","concepts":["Agent Workflows","iOS Development"]}]`);
    await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{
        slug: 'media/x/bookmark',
        content: 'source',
        contentHash: 'bookmark-hash',
        researchPolicy: 'birdclaw-research-v1',
      }],
      _model: 'anthropic:claude-haiku-4-5',
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ frontmatter: { concepts?: string[] } }>(
      `SELECT frontmatter FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].frontmatter.concepts).toEqual(['agent-workflows', 'ios-development']);
  });

  test('keeps default JSON extraction for unrelated pages and stamps only eligible research atoms', async () => {
    const calls: ChatOpts[] = [];
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      calls.push(opts);
      return stubChat('[{"title":"Scoped","atom_type":"insight","body":"body","concepts":["iOS Development"]}]')(opts);
    };
    await runPhaseExtractAtoms(engine, {
      _model: 'opencode-server:gpt-5.5',
      _transcripts: [],
      _pages: [
        { slug: 'articles/default', content: 'default body', contentHash: 'default-hash' },
        {
          slug: 'media/x/bookmark',
          content: 'bookmark body',
          contentHash: 'bookmark-hash',
          researchPolicy: 'birdclaw-research-v1',
        },
      ],
      _chat: chat,
    });

    expect(calls[0]?.system).toContain('JSON array');
    expect(calls[0]?.system).not.toContain('TITLE:');
    expect(calls[0]?.system).not.toContain('concepts (1-5');
    expect(calls[1]?.system).toContain('TITLE:');
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE type = 'atom' ORDER BY frontmatter->>'source_hash'`,
    );
    const policies = rows.map((row) => row.frontmatter.research_policy).filter(Boolean);
    expect(policies).toEqual(['birdclaw-research-v1']);
    const ordinary = rows.find((row) => row.frontmatter.source_slug === 'articles/default');
    const research = rows.find((row) => row.frontmatter.source_slug === 'media/x/bookmark');
    expect(ordinary?.frontmatter.concepts).toBeUndefined();
    expect(research?.frontmatter.concepts).toEqual(['ios-development']);
  });

  test('same model title from different sources creates distinct atoms', async () => {
    const chat = stubChat(`[{"title":"Shared title","atom_type":"insight","body":"body","concepts":["Shared Topic"]}]`);
    await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [
        { slug: 'media/x/one', content: 'one', contentHash: 'hash-source-one' },
        { slug: 'media/x/two', content: 'two', contentHash: 'hash-source-two' },
      ],
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ slug: string; frontmatter: { source_slug: string } }>(
      `SELECT slug, frontmatter FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(2);
    expect(rows.map((row) => row.frontmatter.source_slug).sort()).toEqual([
      'media/x/one',
      'media/x/two',
    ]);
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
    const indexed = await engine.executeRaw<{ count: number | string }>(
      `SELECT COUNT(DISTINCT p.id)::int AS count
         FROM pages p JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.type = 'concept'`,
    );
    expect(Number(indexed[0].count)).toBe(3);
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

  test('marked research concepts require two distinct original sources', async () => {
    const oneSource = [1, 2, 3].map((i) => ({
      slug: `atoms/a${i}`,
      title: `A${i}`,
      body: `body ${i}`,
      concept_refs: ['ios-development'],
      source_id: 'birdclaw',
      source_slug: 'bookmarks/post-1',
      research_policy: 'birdclaw-research-v1',
    }));
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: oneSource });
    expect(result.status).toBe('skipped');
  });

  test('writes bounded source-aware evidence for research concepts', async () => {
    const atoms = Array.from({ length: 25 }, (_, i) => ({
      slug: `atoms/a${i}`,
      title: `A${i}`,
      body: `body ${i}`,
      concept_refs: ['ios-development'],
      source_id: i === 0 ? 'other-source' : 'birdclaw',
      source_slug: `bookmarks/post-${i}`,
      source_hash: `hash-${i}`,
      research_policy: 'birdclaw-research-v1',
    })).reverse();
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: stubChat('Native summary.') });
    const rows = await engine.executeRaw<{
      compiled_truth: string;
      frontmatter: {
        support_count: number;
        supporting_atoms: Array<{ source_id: string; slug: string; source_hash?: string }>;
        supporting_sources: Array<{ source_id: string; slug: string; source_hash?: string }>;
        synthesized_at?: string;
      };
    }>(`SELECT compiled_truth, frontmatter FROM pages WHERE slug = 'concepts/ios-development'`);
    expect(rows[0].frontmatter.support_count).toBe(25);
    expect(rows[0].frontmatter.supporting_atoms).toHaveLength(20);
    expect(rows[0].frontmatter.supporting_sources).toHaveLength(20);
    expect(rows[0].frontmatter.supporting_sources[0]).toEqual({
      source_id: 'birdclaw',
      slug: 'bookmarks/post-1',
      source_hash: 'hash-1',
    });
    expect(rows[0].compiled_truth).toContain('## Supporting research');
    expect(rows[0].compiled_truth).toContain('[[birdclaw:bookmarks/post-1]]');
    expect(rows[0].frontmatter.supporting_atoms[0]).toEqual({
      source_id: 'birdclaw',
      slug: 'atoms/a1',
      source_hash: 'hash-1',
    });
    expect(rows[0].frontmatter.synthesized_at).toBeUndefined();
  });

  test('same source slug in different source ids counts as distinct evidence', async () => {
    const atoms = ['source-a', 'source-b'].map((source_id) => ({
      slug: `atoms/${source_id}`,
      title: source_id,
      body: source_id,
      concept_refs: ['shared-topic'],
      source_id,
      source_slug: 'bookmarks/same-slug',
      research_policy: 'birdclaw-research-v1',
    }));
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.details?.concepts_written).toBe(1);
  });

  test('mixed marked and unmarked groups use upstream count behavior without research marker inheritance', async () => {
    const atoms = Array.from({ length: 9 }, (_, i) => ({
      slug: `atoms/legacy-${i}`,
      title: `Legacy ${i}`,
      body: `legacy ${i}`,
      concept_refs: ['established-topic'],
    }));
    atoms.push({
      slug: 'atoms/bookmark',
      title: 'Bookmark',
      body: 'bookmark',
      concept_refs: ['established-topic'],
      source_id: 'birdclaw',
      source_slug: 'media/x/bookmark',
      research_policy: 'birdclaw-research-v1',
    } as (typeof atoms)[number]);
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: stubChat('Established summary.'),
    });
    expect(result.details?.concepts_written).toBe(1);
    expect((result.details?.tier_counts as Record<string, number>).T1).toBe(1);
    const page = await engine.getPage('concepts/established-topic');
    expect(page?.frontmatter.research_policy).toBeUndefined();
    expect(page?.frontmatter.supporting_sources).toBeUndefined();
    expect(page?.compiled_truth).not.toContain('## Supporting research');
  });

  test('unmarked concepts retain upstream count tiering and rendering', async () => {
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/default-${i}`,
      title: `Default ${i}`,
      body: `default ${i}`,
      concept_refs: ['default-topic'],
      source_id: 'default',
      source_slug: `articles/source-${i}`,
    }));
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: stubChat('Default summary.') });
    const page = await engine.getPage('concepts/default-topic');
    expect(page?.frontmatter.tier).toBe('T2');
    expect(page?.frontmatter.composite_score).toBe(5);
    expect(page?.frontmatter.supporting_sources).toBeUndefined();
    expect(page?.compiled_truth).toBe('Default summary.');
  });

  test('unchanged deterministic synthesis does not rewrite the concept page', async () => {
    const atoms = [
      { slug: 'atoms/one', title: 'One', body: 'one', concept_refs: ['stable-topic'] },
      { slug: 'atoms/two', title: 'Two', body: 'two', concept_refs: ['stable-topic'] },
    ];
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    const before = await engine.executeRaw<{ updated_at: string; content_hash: string }>(
      `SELECT updated_at::text, content_hash FROM pages WHERE slug = 'concepts/stable-topic'`,
    );
    const receiptsBefore = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'extract_receipt'`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runPhaseSynthesizeConcepts(engine, { _atoms: [...atoms].reverse() });
    const after = await engine.executeRaw<{ updated_at: string; content_hash: string }>(
      `SELECT updated_at::text, content_hash FROM pages WHERE slug = 'concepts/stable-topic'`,
    );
    expect(after[0]).toEqual(before[0]);
    const receiptsAfter = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'extract_receipt'`,
    );
    expect(receiptsAfter[0].count).toBe(receiptsBefore[0].count);
    const page = await engine.getPage('concepts/stable-topic');
    expect(page?.compiled_truth).not.toContain('## Supporting atoms');
  });

  test('unchanged T1/T2 synthesis skips the LLM before generating a narrative', async () => {
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/llm-${i}`,
      title: `LLM ${i}`,
      body: `body ${i}`,
      concept_refs: ['stable-llm-topic'],
    }));
    let calls = 0;
    const chat = async (...args: Parameters<NonNullable<SynthesizeConceptsOpts['_chat']>>) => {
      calls++;
      return stubChat('Stable generated summary.')(...args);
    };

    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const second = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [...atoms].reverse(),
      _chat: chat,
    });

    expect(calls).toBe(1);
    expect(second.details?.concepts_written).toBe(0);
    expect(second.details?.concepts_unchanged).toBe(1);
  });

  test('a failed T1/T2 synthesis is retried and replaced after the gateway recovers', async () => {
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/retry-${i}`,
      title: `Retry ${i}`,
      body: `retry body ${i}`,
      concept_refs: ['retry-topic'],
    }));
    let calls = 0;
    const first = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: async () => {
        calls++;
        throw new Error('temporary gateway failure');
      },
    });
    expect(first.status).toBe('warn');
    expect((await engine.getPage('concepts/retry-topic'))?.frontmatter.synthesis_status)
      .toBe('fallback_error');

    const second = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: async (opts) => {
        calls++;
        return stubChat('Recovered generated summary.')(opts);
      },
    });

    expect(calls).toBe(2);
    expect(second.details?.concepts_written).toBe(1);
    const recovered = await engine.getPage('concepts/retry-topic');
    expect(recovered?.compiled_truth).toBe('Recovered generated summary.');
    expect(recovered?.frontmatter.synthesis_status).toBe('generated');
  });

  test('legacy synthesized page newer than its atoms skips one-time LLM regeneration', async () => {
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/legacy-llm-${i}`,
      title: `Legacy LLM ${i}`,
      body: `legacy body ${i}`,
      concept_refs: ['legacy-llm-topic'],
      updated_at: new Date('2020-01-01T00:00:00Z'),
    }));
    await putGeneratedSearchablePage(engine, 'concepts/legacy-llm-topic', {
      title: 'legacy llm topic',
      type: 'concept',
      compiled_truth: 'A previously synthesized legacy summary.',
      timeline: '',
      frontmatter: {
        type: 'concept',
        tier: 'T2',
        mention_count: 5,
        composite_score: 5,
        synthesized_by: 'synthesize_concepts-v0.41',
      },
    });
    let calls = 0;
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: async (opts) => {
        calls++;
        return stubChat('Should not run.')(opts);
      },
    });
    expect(calls).toBe(0);
    expect(result.details?.concepts_unchanged).toBe(1);
  });

  test('otherwise unchanged legacy concept is rewritten when searchable chunks are missing', async () => {
    const atoms = [
      { slug: 'atoms/one', title: 'One', body: 'one', concept_refs: ['legacy-topic'] },
      { slug: 'atoms/two', title: 'Two', body: 'two', concept_refs: ['legacy-topic'] },
    ];
    const compiledTruth = 'T3 concept. 2 atoms reference this. Top mentions:\n  - One\n  - Two';
    await engine.putPage('concepts/legacy-topic', {
      title: 'legacy topic',
      type: 'concept',
      compiled_truth: compiledTruth,
      frontmatter: {
        type: 'concept',
        tier: 'T3',
        mention_count: 2,
        composite_score: 2,
        synthesized_by: 'synthesize_concepts-v0.41',
      },
      timeline: '',
    });
    expect(await engine.getChunks('concepts/legacy-topic')).toHaveLength(0);

    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });

    expect(result.details?.concepts_written).toBe(1);
    expect((await engine.getChunks('concepts/legacy-topic')).length).toBeGreaterThan(0);
  });
});
