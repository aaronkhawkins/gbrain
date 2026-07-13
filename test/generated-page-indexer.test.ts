import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  generatedPageChunks,
  putGeneratedSearchablePage,
} from '../src/core/generated-page-indexer.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());
beforeEach(async () => resetPgliteState(engine));

describe('generated page indexing', () => {
  test('writes a generated page and canonical searchable chunks atomically', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('research', 'research', '{}'::jsonb)`,
    );
    await putGeneratedSearchablePage(engine, 'atoms/2026-07-13/swift-concurrency', {
      type: 'atom',
      title: 'Swift concurrency',
      compiled_truth: 'Actors isolate mutable state in Swift concurrency.',
      timeline: '',
      frontmatter: { extracted_by: 'test' },
    }, { sourceId: 'research' });

    const page = await engine.getPage('atoms/2026-07-13/swift-concurrency', { sourceId: 'research' });
    const chunks = await engine.getChunks('atoms/2026-07-13/swift-concurrency', { sourceId: 'research' });
    const found = await engine.searchKeyword('mutable state', { sourceId: 'research' });

    expect(page).not.toBeNull();
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).toContain('Actors isolate');
    expect(chunks[0].embedding).toBeNull();
    expect(found.map((row) => row.slug)).toContain('atoms/2026-07-13/swift-concurrency');
    const versions = await engine.executeRaw<{ chunker_version: number }>(
      `SELECT chunker_version FROM pages WHERE source_id = 'research' AND slug = 'atoms/2026-07-13/swift-concurrency'`,
    );
    expect(Number(versions[0].chunker_version)).toBe(MARKDOWN_CHUNKER_VERSION);
  });

  test('rerun is chunk-idempotent and semantic rewrite replaces old chunks as stale', async () => {
    const slug = 'concepts/ios-development';
    const original = {
      type: 'concept' as const,
      title: 'iOS development',
      compiled_truth: 'SwiftUI builds declarative interfaces.',
      timeline: '',
      frontmatter: { synthesized_by: 'test' },
    };
    await putGeneratedSearchablePage(engine, slug, original);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = array_fill(0.01::real, ARRAY[1536])::vector,
              embedded_at = now(),
              model = 'text-embedding-3-large'
        WHERE page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = 'concepts/ios-development')`,
    );
    expect(await embeddedChunkCount(slug)).toBe(1);

    await putGeneratedSearchablePage(engine, slug, original);
    let chunks = await engine.getChunks(slug);
    expect(chunks).toHaveLength(1);
    expect(await embeddedChunkCount(slug)).toBe(1);

    await putGeneratedSearchablePage(engine, slug, {
      ...original,
      compiled_truth: 'Observation powers SwiftUI state propagation.',
    });
    chunks = await engine.getChunks(slug);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).toContain('Observation powers');
    expect(await embeddedChunkCount(slug)).toBe(0);
    expect(await engine.searchKeyword('declarative interfaces')).toHaveLength(0);
  });

  test('chunk builder is deterministic across compiled truth and timeline', () => {
    const page = { compiled_truth: 'First durable claim.', timeline: '2026-07-13: supporting event.' };
    expect(generatedPageChunks(page)).toEqual(generatedPageChunks(page));
    expect(generatedPageChunks(page).map((chunk) => chunk.chunk_source)).toEqual([
      'compiled_truth',
      'timeline',
    ]);
  });
});

async function embeddedChunkCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
      WHERE p.source_id = 'default' AND p.slug = $1 AND cc.embedding IS NOT NULL`,
    [slug],
  );
  return Number(rows[0]?.count ?? 0);
}
