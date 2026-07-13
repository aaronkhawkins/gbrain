import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { collectResearchHealth } from '../src/core/research-health.ts';

describe('research health', () => {
  test('is source-scoped, aggregate-only and maps stable redacted fields', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const engine = {
      executeRaw: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return [{
          source_id: 'research-a',
          eligible_bookmarks: '12',
          backlog: '3',
          native_atoms: '20',
          native_concepts: '4',
          legacy_pages: '2',
          newest_bookmark_at: '2026-07-12T10:00:00.000Z',
          newest_native_at: '2026-07-12T11:00:00.000Z',
          recent_failures_24h: '1',
        }];
      },
    } as unknown as BrainEngine;

    const result = await collectResearchHealth(engine, ['research-a']);
    expect(capturedSql).toContain('p.source_id = ANY($1::text[])');
    expect(capturedSql).toContain("j.name = 'extract-atoms-drain'");
    expect(capturedSql).toContain("j.data->>'sourceId'");
    expect(capturedSql).toContain("j.data->>'source_id'");
    expect(capturedParams).toEqual([['research-a']]);
    expect(result.totals).toEqual({
      eligible_bookmarks: 12,
      backlog: 3,
      native_atoms: 20,
      native_concepts: 4,
      legacy_pages: 2,
      recent_failures_24h: 1,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ['compiled_truth', 'database_url', 'password', 'token', 'https://']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  test('empty source grant remains an explicit empty SQL scope', async () => {
    let params: unknown[] = [];
    const engine = {
      executeRaw: async (_sql: string, p: unknown[]) => {
        params = p;
        return [];
      },
    } as unknown as BrainEngine;
    const result = await collectResearchHealth(engine, []);
    expect(params).toEqual([[]]);
    expect(result.sources).toEqual([]);
    expect(result.totals.backlog).toBe(0);
  });
});
