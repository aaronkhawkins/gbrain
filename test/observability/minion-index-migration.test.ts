import { describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../../src/core/migrate.ts';

describe('minion observability history index', () => {
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
