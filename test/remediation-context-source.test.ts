import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';
import { withEnv } from './helpers/with-env.ts';

describe('loadRecommendationContext source routing', () => {
  test('reports the repository path belonging to the selected source', async () => {
    const paths = new Map([
      ['default', '/brains/personal'],
      ['company', '/brains/company'],
    ]);
    const engine = {
      kind: 'pglite',
      executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
          const id = String(params?.[0]);
          return (paths.has(id) ? [{ id }] : []) as T[];
        }
        if (sql.includes('SELECT local_path FROM sources WHERE id = $1')) {
          const id = String(params?.[0]);
          return [{ local_path: paths.get(id) ?? null }] as T[];
        }
        return [];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;

    await withEnv({ GBRAIN_SOURCE: 'company' }, async () => {
      const context = await loadRecommendationContext(engine);
      expect(context.sourceId).toBe('company');
      expect(context.repoPath).toBe('/brains/company');
    });
  });
});
