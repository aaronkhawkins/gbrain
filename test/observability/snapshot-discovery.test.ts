import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  buildOperationalSnapshot,
  deriveSourceLabelKey,
  discoverRegistryInput,
} from '../../src/core/observability/snapshot.ts';
import {
  buildExpectedWorkRegistry,
  nativeIntakeWorkKey,
} from '../../src/core/observability/expected-work.ts';

describe('operational registry discovery failures', () => {
  test('configured brain identity keeps source labels stable across database URL rotation', () => {
    const first = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://old-user:old-secret@old-pool.example.com:5432/postgres?sslmode=require',
      observability: { brain_id: 'customer-brain' },
    });
    const rotated = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://new-user:new-secret@new-pool.example.net:6432/postgres?sslmode=verify-full',
      observability: { brain_id: 'customer-brain' },
    });
    const otherBrain = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://new-user:new-secret@new-pool.example.net:6432/postgres?sslmode=verify-full',
      observability: { brain_id: 'other-brain' },
    });

    expect(first).toBe(rotated);
    expect(first).not.toBe(otherBrain);
    expect(first).not.toContain('old-secret');
  });

  test('database locator fallback excludes rotating credentials and URL options', () => {
    const first = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://old-user:old-secret@db.example.com:5432/customer?sslmode=require',
    });
    const rotated = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://new-user:new-secret@db.example.com:5432/customer?sslmode=verify-full',
    });
    const otherDatabase = deriveSourceLabelKey({
      engine: 'postgres',
      database_url: 'postgres://new-user:new-secret@db.example.com:5432/other?sslmode=verify-full',
    });

    expect(first).toBe(rotated);
    expect(first).not.toBe(otherDatabase);
  });

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

    configValues.set('dream.synthesize.enabled', 'true');
    const enabledWithoutCorpus = await discoverRegistryInput(engine, {
      engine: 'pglite',
      database_path: '/tmp/test-brain.db',
    });
    expect(enabledWithoutCorpus.enabledDreamPhases).not.toContain('synthesize');

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

  test('native-intake targets come directly from enabled registered source policy', async () => {
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        if (sql.includes('FROM sources')) {
          return [
            {
              id: 'producer',
              name: 'Producer',
              local_path: null,
              last_commit: null,
              last_sync_at: null,
              config: { native_intake: { allowed_targets: ['research'] } },
              created_at: new Date(),
              archived: false,
            },
            {
              id: 'research',
              name: 'Research',
              local_path: null,
              last_commit: null,
              last_sync_at: null,
              config: {
                native_intake: {
                  posture: 'research',
                  promotion_policy_ids: ['reviewed-evidence'],
                },
              },
              created_at: new Date(),
              archived: false,
            },
            {
              id: 'malformed',
              name: 'Malformed',
              local_path: null,
              last_commit: null,
              last_sync_at: null,
              config: { native_intake: { posture: 'not-a-posture' } },
              created_at: new Date(),
              archived: false,
            },
          ];
        }
        return [];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const config = {
      engine: 'pglite' as const,
      database_path: '/tmp/native-intake-observer.db',
    };

    const input = await discoverRegistryInput(engine, config);
    const registry = buildExpectedWorkRegistry(input);
    const sourceLabelKey = deriveSourceLabelKey(config)!;

    expect(input.nativeIntakeTargetIds).toEqual(['research']);
    expect(registry).toContainEqual(expect.objectContaining({
      key: nativeIntakeWorkKey('research', sourceLabelKey),
      selector: 'ingest_capture',
      scope: { type: 'source', source_id: 'research' },
    }));
    expect(registry.some((entry) => entry.scope?.type === 'source' &&
      entry.scope.source_id === 'producer' &&
      entry.selector === 'ingest_capture')).toBe(false);
    expect(registry.some((entry) => entry.scope?.type === 'source' &&
      entry.scope.source_id === 'malformed' &&
      entry.selector === 'ingest_capture')).toBe(false);
  });
});
