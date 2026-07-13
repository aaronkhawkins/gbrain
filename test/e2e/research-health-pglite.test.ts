import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { collectResearchHealth } from '../../src/core/research-health.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => resetPgliteState(engine));
afterAll(async () => engine.disconnect());

async function seedSource(sourceId: string, suffix: string, processed: boolean) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
  const bookmark = await engine.putPage(`bookmarks/${suffix}`, {
    type: 'media',
    title: `Synthetic bookmark ${suffix}`,
    compiled_truth: `Synthetic private research fixture ${suffix}. `.repeat(20),
    frontmatter: {
      intake_adapter: 'birdclaw-bookmarks-to-brain',
      content_kind: 'x-bookmark',
      concept_synthesis_candidate: true,
    },
  }, { sourceId });
  if (processed) {
    if (!bookmark.content_hash) throw new Error('synthetic bookmark did not receive a content hash');
    await engine.putPage(`atoms/${suffix}`, {
      type: 'atom',
      title: `Synthetic atom ${suffix}`,
      compiled_truth: 'A synthetic insight.',
      frontmatter: {
        research_policy: 'birdclaw-research-v1',
        source_hash: bookmark.content_hash.slice(0, 16),
        extracted_by: 'extract_atoms-v0.41.2.1',
      },
    }, { sourceId });
  }
}

describe('research health source isolation (PGLite)', () => {
  test('a source grant cannot observe another source counts', async () => {
    await seedSource('research-a', 'a', true);
    await seedSource('research-b', 'b', false);

    const onlyA = await collectResearchHealth(engine, ['research-a']);
    expect(onlyA.sources.map((row) => row.source_id)).toEqual(['research-a']);
    expect(onlyA.totals.eligible_bookmarks).toBe(1);
    expect(onlyA.totals.backlog).toBe(0);
    expect(onlyA.totals.native_atoms).toBe(1);

    const onlyB = await collectResearchHealth(engine, ['research-b']);
    expect(onlyB.sources.map((row) => row.source_id)).toEqual(['research-b']);
    expect(onlyB.totals.eligible_bookmarks).toBe(1);
    expect(onlyB.totals.backlog).toBe(1);
    expect(onlyB.totals.native_atoms).toBe(0);
  });
});
