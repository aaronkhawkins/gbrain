import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildOperationalSnapshot } from '../../src/core/observability/snapshot.ts';

describe('operational registry discovery failures', () => {
  test('a source discovery failure is partial and preserves an unknown source axis', async () => {
    const engine = {
      kind: 'postgres',
      executeRaw: async () => {
        throw new Error('sources unavailable');
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;

    const snapshot = await buildOperationalSnapshot({
      engine,
      brainId: 'test-brain',
      skipCollectors: true,
    });

    expect(snapshot.partial).toBe(true);
    expect(snapshot.items).toContainEqual(expect.objectContaining({
      key: 'discovery.sources',
      state: 'unknown',
      reason: 'evidence_unavailable',
    }));
  });
});
