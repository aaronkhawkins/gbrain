/**
 * Observer database boundary.
 *
 * Postgres gets database-enforced transaction read-only semantics. Both
 * engines receive a deliberately tiny facade so observer code cannot reach
 * mutation methods, and raw SQL is limited to SELECT statements.
 */

import type { BrainEngine } from '../engine.ts';

function assertReadOnlyStatement(sql: string): void {
  const statement = sql.trimStart();
  if (!/^SELECT\b/i.test(statement)) {
    throw new Error('observer database facade is read-only');
  }
}

function restrictedFacade(engine: BrainEngine): BrainEngine {
  const facade = {
    kind: engine.kind,
    executeRaw: async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ): Promise<T[]> => {
      assertReadOnlyStatement(sql);
      return engine.executeRaw<T>(sql, params, opts);
    },
    getConfig: (key: string) => engine.getConfig(key),
  };
  return Object.freeze(facade) as unknown as BrainEngine;
}

/**
 * Run observer work with the least authority the collectors need.
 *
 * The Postgres `SET TRANSACTION READ ONLY` is the authoritative write guard;
 * the facade is defense in depth and supplies equivalent application-level
 * protection for PGLite.
 */
export async function withObserverReadOnlyEngine<T>(
  engine: BrainEngine | null,
  fn: (engine: BrainEngine | null) => Promise<T>,
): Promise<T> {
  if (!engine) return fn(null);

  if (engine.kind === 'postgres') {
    return engine.transaction(async (tx) => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      return fn(restrictedFacade(tx));
    });
  }

  return fn(restrictedFacade(engine));
}
