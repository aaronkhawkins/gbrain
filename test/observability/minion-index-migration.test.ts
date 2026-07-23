import { describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../../src/core/migrate.ts';

describe('minion observability history index', () => {
  test('v125 drops an invalid Postgres remnant with top-level concurrent DDL', async () => {
    const migration = MIGRATIONS.find(
      (candidate) => candidate.name === 'minion_jobs_name_status_recency_index',
    );
    expect(migration).toBeDefined();
    expect(migration!.transaction).toBe(false);

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const statements: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return [{ valid: false }];
      },
      runMigration: async (_version: number, sql: string) => {
        statements.push(sql);
      },
    };

    await migration!.handler!(engine as never);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('pg_index');
    expect(queries[0]!.params).toEqual(['idx_minion_jobs_name_status_recency']);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_minion_jobs_name_status_recency;',
    );
    expect(statements[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_minion_jobs_name_status_recency',
    );
    expect(statements.join('\n')).not.toContain('DO $$');
  });

  test('v125 preserves a valid Postgres index before idempotent create', async () => {
    const migration = MIGRATIONS.find(
      (candidate) => candidate.name === 'minion_jobs_name_status_recency_index',
    );
    const statements: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async () => [{ valid: true }],
      runMigration: async (_version: number, sql: string) => {
        statements.push(sql);
      },
    };

    await migration!.handler!(engine as never);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_minion_jobs_name_status_recency',
    );
  });

  test('replaces the broad v125 index with query-shaped partial indexes', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.name === 'minion_jobs_observer_partial_indexes');
    expect(migration).toBeDefined();
    expect(migration!.transaction).toBe(false);
    const handler = String(migration!.handler);
    expect(handler).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(handler).toContain('idx_minion_jobs_terminal_recency');
    expect(handler).toContain('(COALESCE(finished_at, started_at, updated_at, created_at)) DESC');
    expect(handler).toContain("WHERE status IN ('completed', 'failed', 'dead', 'cancelled')");
    expect(handler).toContain('idx_minion_jobs_nonterminal');
    expect(handler).toContain("WHERE status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')");
    expect(handler).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_minion_jobs_name_status_recency');
  });
});
