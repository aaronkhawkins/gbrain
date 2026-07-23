import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  LATEST_VERSION,
  MIGRATIONS,
  runMigrations,
} from '../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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

function v123Stage(sql: string): number | null {
  if (sql.includes('CREATE OR REPLACE FUNCTION update_page_search_vector')) return 1;
  if (sql.includes('CREATE OR REPLACE FUNCTION update_chunk_search_vector')) return 2;
  if (sql.includes('UPDATE pages SET id = id')) return 3;
  if (sql.includes('UPDATE content_chunks') && sql.includes('SET search_vector')) return 4;
  return null;
}

function failV123Stage(engine: BrainEngine, failureStage: number): BrainEngine {
  let failed = false;
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (!failed && v123Stage(sql) === failureStage) {
            failed = true;
            throw new Error(`injected stage ${failureStage}`);
          }
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

describe('configurable_fts_language migration', () => {
  test('migration is registered', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig).toBeDefined();
    expect(ftsMig?.version).toBeGreaterThan(115);
  });

  // #2704 (v124, page_search_vector_drop_compiled_truth) landed after this
  // migration — "is the latest migration" was only ever true at the
  // moment v123 was added and would break on every subsequent migration,
  // so it's removed rather than bumped to a hardcoded v124. The
  // registration + shape assertions below don't depend on migration order.

  test('ftsMig uses handler (not static SQL) because language interpolation is dynamic', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig?.sql).toBe('');
    expect(ftsMig?.handler).toBeTypeOf('function');
  });

  test('ftsMig handler is async', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    // Async function check: the constructor name is 'AsyncFunction'
    expect(ftsMig?.handler?.constructor.name).toBe('AsyncFunction');
  });

  test('migration handler issues recreate-function calls (smoke check via mock engine)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'english';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Default 'english' \u2014 no backfill, only 2 CREATE OR REPLACE calls.
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(calls[0]).toContain("to_tsvector('english'");
    expect(calls[0]).not.toContain('NEW.compiled_truth');
    expect(calls[1]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(calls[1]).toContain("to_tsvector('english'");
    // v120/#1647 hardening must survive the CREATE OR REPLACE (which resets
    // proconfig): both recreated bodies pin search_path.
    expect(calls[0]).toContain('SET search_path = pg_catalog, public');
    expect(calls[1]).toContain('SET search_path = pg_catalog, public');
  });

  test('non-english language triggers backfill', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // pt_br \u2014 2 CREATE + 2 backfill UPDATEs = 4 calls
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[0]).not.toContain('NEW.compiled_truth');
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[2]).toMatch(/UPDATE pages/);
    expect(calls[3]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('installs the oversized-safe page trigger before a non-english backfill', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'simple';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    const pageFunction = calls.findIndex(sql =>
      sql.includes('CREATE OR REPLACE FUNCTION update_page_search_vector'));
    const pageBackfill = calls.findIndex(sql => sql.includes('UPDATE pages SET id = id'));
    expect(pageFunction).toBe(0);
    expect(pageBackfill).toBeGreaterThan(pageFunction);
    expect(calls[pageFunction]).not.toContain('NEW.compiled_truth');
  });

  test('runner failures at every v123 stage preserve v122 and resume to v124', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      await engine.putPage('failure-resume-oversized', {
        type: 'note',
        title: 'the failure marker',
        compiled_truth: OVERSIZED_BODY,
      });

      process.env[ENV_KEY] = 'simple';
      resetFtsLanguageCache();

      for (const failureStage of [1, 2, 3, 4]) {
        await installUnsafeV123PageTrigger(engine);
        await engine.setConfig('version', '122');

        await expect(
          runMigrations(failV123Stage(engine, failureStage)),
        ).rejects.toThrow(`injected stage ${failureStage}`);
        expect(await engine.getConfig('version')).toBe('122');

        const resumed = await runMigrations(engine);
        expect(resumed.current).toBe(LATEST_VERSION);
        expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

        // Re-fire the final trigger on the oversized row. Any retry that
        // left the unsafe v123 body installed would overflow here.
        await engine.executeRaw(`
          UPDATE pages SET id = id WHERE slug = 'failure-resume-oversized'
        `);
      }
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('PGLite v122 upgrade backfills an oversized non-English page and reaches v124', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
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
      }>(`
        SELECT
          p.search_vector::text AS page_vector,
          c.search_vector::text AS chunk_vector
        FROM pages p
        JOIN content_chunks c ON c.page_id = p.id
        WHERE p.slug = 'v122-oversized'
      `);
      expect(rows[0]?.page_vector).toContain("'the'");
      expect(rows[0]?.chunk_vector).toContain("'the'");
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('PGLite v123 resumes through v124 and repairs the unsafe function', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      await engine.putPage('v123-oversized', {
        type: 'note',
        title: 'Repair fixture',
        compiled_truth: OVERSIZED_BODY,
      });
      await installUnsafeV123PageTrigger(engine);
      await engine.setConfig('version', '123');

      const result = await runMigrations(engine);
      expect(result.current).toBe(LATEST_VERSION);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      await engine.executeRaw(`
        UPDATE pages SET id = id WHERE slug = 'v123-oversized'
      `);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('invalid language falls back to english (no SQL injection)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Falls back to english: 2 CREATE OR REPLACE only, no DROP TABLE in any SQL.
    expect(calls.length).toBe(2);
    for (const sql of calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toContain("to_tsvector('english'");
    }
  });
});
