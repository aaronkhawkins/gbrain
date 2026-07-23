import { describe, expect, test } from 'bun:test';
import { withObserverReadOnlyEngine } from '../../src/core/observability/read-only-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

describe('withObserverReadOnlyEngine', () => {
  test('enforces a read-only Postgres transaction and exposes a restricted facade', async () => {
    const statements: string[] = [];
    const tx = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        statements.push(sql);
        return [];
      },
      getConfig: async () => '999999',
      setConfig: async () => {
        throw new Error('mutable method reached');
      },
    } as unknown as BrainEngine;
    const engine = {
      kind: 'postgres',
      transaction: async <T>(fn: (scoped: BrainEngine) => Promise<T>) => fn(tx),
    } as unknown as BrainEngine;

    await withObserverReadOnlyEngine(engine, async (readonlyEngine) => {
      expect(readonlyEngine).not.toBeNull();
      await readonlyEngine!.executeRaw('SELECT 1');
      expect((readonlyEngine as unknown as { setConfig?: unknown }).setConfig).toBeUndefined();
      await expect(readonlyEngine!.executeRaw('INSERT INTO config(key, value) VALUES ($1, $2)')).rejects.toThrow(
        /read-only/,
      );
    });

    expect(statements[0]).toMatch(/SET TRANSACTION READ ONLY/i);
    expect(statements).toContain('SELECT 1');
  });

  test('rejects mutation SQL for PGLite even without database session enforcement', async () => {
    const engine = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async () => null,
    } as unknown as BrainEngine;

    await withObserverReadOnlyEngine(engine, async (readonlyEngine) => {
      await expect(readonlyEngine!.executeRaw('DELETE FROM pages')).rejects.toThrow(/read-only/);
    });
  });
});
