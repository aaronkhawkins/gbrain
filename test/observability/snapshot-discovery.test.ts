import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  buildOperationalSnapshot,
  discoverRegistryInput,
} from '../../src/core/observability/snapshot.ts';

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

  test('Dream enablement is read from the database-backed runtime config', async () => {
    const configValues = new Map<string, string>();
    const engine = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async (key: string) => configValues.get(key) ?? null,
    } as unknown as BrainEngine;

    const defaults = await discoverRegistryInput(engine, {
      engine: 'pglite',
      database_path: '/tmp/test-brain.db',
    });
    expect(defaults.enabledDreamPhases).not.toContain('synthesize');
    expect(defaults.enabledDreamPhases).not.toContain('enrich_thin');

    configValues.set('dream.synthesize.session_corpus_dir', '/tmp/sessions');
    configValues.set('cycle.enrich_thin.enabled', 'true');
    const enabled = await discoverRegistryInput(engine, {
      engine: 'pglite',
      database_path: '/tmp/test-brain.db',
    });
    expect(enabled.enabledDreamPhases).toContain('synthesize');
    expect(enabled.enabledDreamPhases).toContain('enrich_thin');

    configValues.set('dream.synthesize.enabled', 'false');
    const explicitlyDisabled = await discoverRegistryInput(engine, {
      engine: 'pglite',
      database_path: '/tmp/test-brain.db',
    });
    expect(explicitlyDisabled.enabledDreamPhases).not.toContain('synthesize');
  });
});
