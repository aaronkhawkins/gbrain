import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  LATEST_VERSION,
  runMigrations,
} from '../../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../../src/core/fts-language.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  getEngine,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const SKIP = !hasDatabase();
const describeE2E = SKIP ? describe.skip : describe;
const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];
const OVERSIZED_BODY = Array.from(
  { length: 200_000 },
  (_, i) => `migrationtoken${i.toString(36)}`,
).join(' ');

async function installUnsafeV123PageTrigger(
  engine: BrainEngine,
  lang = 'simple',
): Promise<void> {
  await engine.executeRaw(`
    CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
    DECLARE
      timeline_text TEXT;
    BEGIN
      SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
      INTO timeline_text
      FROM timeline_entries
      WHERE page_id = NEW.id;

      NEW.search_vector :=
        setweight(to_tsvector('${lang}', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('${lang}', coalesce(NEW.compiled_truth, '')), 'B') ||
        setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') ||
        setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
}

describeE2E('v123/v124 FTS migration ordering on Postgres', () => {
  beforeAll(async () => {
    await setupDB();
  }, 30_000);

  afterAll(async () => {
    if (originalLang === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalLang;
    resetFtsLanguageCache();
    await teardownDB();
  });

  test('v122 oversized non-English upgrade reaches v124 safely', async () => {
    const engine = getEngine();
    await engine.putPage('v122-oversized', {
      type: 'note',
      title: 'the oversized migration fixture',
      compiled_truth: OVERSIZED_BODY,
    });
    await engine.upsertChunks('v122-oversized', [{
      chunk_index: 0,
      chunk_text: 'the chunk migration marker',
      chunk_source: 'compiled_truth',
    }]);
    const before = await engine.executeRaw<{
      page_vector: string;
      chunk_vector: string;
    }>(`
      SELECT
        p.search_vector::text AS page_vector,
        c.search_vector::text AS chunk_vector
      FROM pages p
      JOIN content_chunks c ON c.page_id = p.id
      WHERE p.slug = 'v122-oversized'
    `);
    expect(before[0]?.page_vector).not.toContain("'the'");
    expect(before[0]?.chunk_vector).not.toContain("'the'");
    await installUnsafeV123PageTrigger(engine);
    await engine.setConfig('version', '122');

    process.env[ENV_KEY] = 'simple';
    resetFtsLanguageCache();

    const result = await runMigrations(engine);
    expect(result.current).toBe(LATEST_VERSION);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const rows = await engine.executeRaw<{
      page_vector: string;
      chunk_vector: string;
      function_def: string;
      trigger_count: number;
    }>(`
      SELECT
        p.search_vector::text AS page_vector,
        c.search_vector::text AS chunk_vector,
        pg_get_functiondef('update_page_search_vector()'::regprocedure) AS function_def,
        (
          SELECT COUNT(*)::int
          FROM pg_trigger
          WHERE tgrelid = 'pages'::regclass
            AND tgname = 'trg_pages_search_vector'
            AND NOT tgisinternal
        ) AS trigger_count
      FROM pages p
      JOIN content_chunks c ON c.page_id = p.id
      WHERE p.slug = 'v122-oversized'
    `);
    expect(rows[0]?.page_vector).toContain("'the'");
    expect(rows[0]?.chunk_vector).toContain("'the'");
    expect(rows[0]?.function_def).not.toContain('compiled_truth');
    expect(rows[0]?.trigger_count).toBe(1);
  }, 60_000);

  test('v123 resumes through v124 and repairs an unsafe installed function', async () => {
    const engine = getEngine();
    await installUnsafeV123PageTrigger(engine);
    await engine.setConfig('version', '123');

    const result = await runMigrations(engine);
    expect(result.current).toBe(LATEST_VERSION);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const rows = await engine.executeRaw<{
      function_def: string;
      trigger_count: number;
    }>(`
      SELECT
        pg_get_functiondef(
          'update_page_search_vector()'::regprocedure
        ) AS function_def,
        (
          SELECT COUNT(*)::int
          FROM pg_trigger
          WHERE tgrelid = 'pages'::regclass
            AND tgname = 'trg_pages_search_vector'
            AND NOT tgisinternal
        ) AS trigger_count
    `);
    expect(rows[0]?.function_def).not.toContain('compiled_truth');
    expect(rows[0]?.trigger_count).toBe(1);
  }, 30_000);
});

if (SKIP) {
  console.log('[fts-language-migration-postgres.e2e] DATABASE_URL not set — skipping.');
}
