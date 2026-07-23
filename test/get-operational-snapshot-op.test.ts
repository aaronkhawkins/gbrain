import { describe, expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { renderOpenMetrics } from '../src/core/observability/openmetrics.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

describe('get_operational_snapshot operation', () => {
  test('is remote-callable, input-free, admin-scoped, and non-mutating', () => {
    const op = operationsByName.get_operational_snapshot;
    expect(op).toBeDefined();
    expect(operations).toContain(op);
    expect(op.params).toEqual({});
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBe(false);
    expect(op.mutating).toBeFalsy();
  });

  test('returns the bounded operational serializer shape', async () => {
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async () => '999999',
    };
    const ctx: any = {
      engine: stubEngine,
      config: { observability: { brain_id: 'agent_test' } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    };
    const result = await operationsByName.get_operational_snapshot.handler(ctx, {}) as Record<string, unknown>;
    expect(result.schema_version).toBe(1);
    expect(result.brain).toBe('agent_test');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result).not.toHaveProperty('database_url');
  });

  test('remote source grants scope the snapshot and exported source keys are opaque', async () => {
    const allowedSource = 'client-alpha-private';
    const deniedSource = 'neighbor-secret';
    const sourceRows = [allowedSource, deniedSource].map((id) => ({
      id,
      name: id,
      local_path: `/tmp/${id}`,
      last_commit: null,
      last_sync_at: null,
      config: {},
      created_at: new Date('2026-07-23T00:00:00.000Z'),
      archived: false,
      newest_content_at: null,
    }));
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async (sql: string) =>
        /FROM sources/i.test(sql) ? sourceRows : [],
      getConfig: async (key: string) =>
        key === 'version' ? String(LATEST_VERSION) : null,
    };
    const ctx: any = {
      engine: stubEngine,
      config: {
        engine: 'pglite',
        database_path: '/tmp/private-brain.db',
        observability: {
          brain_id: 'scoped_agent_test',
          external_work: [{
            key: `processor.${deniedSource}`,
            evidence: {
              adapter: 'minion_job',
              source_id: deniedSource,
            },
          }],
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      auth: { allowedSources: [allowedSource] },
    };

    const result = await operationsByName.get_operational_snapshot.handler(ctx, {}) as any;
    const sourceItems = result.items.filter((item: any) => item.kind === 'source');
    expect(sourceItems).toHaveLength(1);

    const json = JSON.stringify(result);
    expect(json).not.toContain(allowedSource);
    expect(json).not.toContain(deniedSource);
    const metrics = renderOpenMetrics(result);
    expect(metrics).not.toContain(allowedSource);
    expect(metrics).not.toContain(deniedSource);
  });
});
