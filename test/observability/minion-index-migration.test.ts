import { describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../../src/core/migrate.ts';

describe('minion observability history index', () => {
  test('adds a safe additive name/status/recency index', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.name === 'minion_jobs_name_status_recency_index');
    expect(migration).toBeDefined();
    expect(migration!.transaction).toBe(false);
    const handler = String(migration!.handler);
    expect(handler).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(handler).toContain('ON minion_jobs (name, status, created_at DESC)');
    expect(handler).toContain('CREATE INDEX IF NOT EXISTS');
  });
});
