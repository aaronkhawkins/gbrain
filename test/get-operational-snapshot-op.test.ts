import { describe, expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';

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
    };
    const result = await operationsByName.get_operational_snapshot.handler(ctx, {}) as Record<string, unknown>;
    expect(result.schema_version).toBe(1);
    expect(result.brain).toBe('agent_test');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result).not.toHaveProperty('database_url');
  });
});
