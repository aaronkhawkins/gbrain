import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../../src/core/engine.ts';
import {
  buildExpectedWorkRegistry,
} from '../../../src/core/observability/expected-work.ts';
import { collectAllEvidence } from '../../../src/core/observability/collectors/index.ts';
import { collectFactEvidence } from '../../../src/core/observability/collectors/facts.ts';
import { collectLinkEvidence } from '../../../src/core/observability/collectors/links.ts';
import { withObserverReadOnlyEngine } from '../../../src/core/observability/read-only-engine.ts';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const SOURCE_LABEL_KEY = 'test-brain-source-label-key';

describe('observer collector query efficiency', () => {
  test('ingestion and embedding share one source-health computation per snapshot', async () => {
    const calls: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM sources')) {
          return [{
            id: 'alpha',
            name: 'Alpha',
            local_path: null,
            last_commit: null,
            last_sync_at: NOW,
            config: {},
            created_at: NOW,
            archived: false,
            newest_content_at: NOW,
          }];
        }
        if (sql.includes('FROM content_chunks')) {
          return [{ source_id: 'alpha', total: 10, embedded: 10 }];
        }
        if (sql.includes('FROM pages')) {
          return [{ source_id: 'alpha', n: 2 }];
        }
        if (sql.includes('FROM minion_jobs')) return [];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as BrainEngine;
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: true,
    }).filter((entry) =>
      entry.evidence_adapter === 'ingestion_source' ||
      entry.evidence_adapter === 'embedding');

    const result = await collectAllEvidence({ engine, registry, now: NOW });

    expect(result.partial).toBe(false);
    expect(calls.filter((sql) => sql.includes('FROM sources'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM content_chunks'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM pages'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FROM minion_jobs'))).toHaveLength(1);
    const sourceEntry = registry.find((entry) => entry.evidence_adapter === 'ingestion_source')!;
    expect(result.evidence.get(sourceEntry.key)).toMatchObject({
      oldest_pending_age_seconds: 0,
    });
    expect(result.evidence.get('embedding.coverage')).toMatchObject({
      backlog_items: 0,
      force_state: 'healthy',
    });
  });

  test('a remote source grant excludes neighboring source health from shared evidence', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const scoped = (params?.[0] as string[] | undefined) ?? ['alpha', 'beta'];
        if (sql.includes('FROM sources')) {
          return scoped.map((id) => ({
            id,
            name: id,
            local_path: null,
            last_commit: null,
            last_sync_at: NOW,
            config: {},
            created_at: NOW,
            archived: false,
            newest_content_at: NOW,
          }));
        }
        if (sql.includes('FROM content_chunks')) {
          return scoped.map((source_id) => source_id === 'alpha'
            ? { source_id, total: 10, embedded: 10 }
            : { source_id, total: 100, embedded: 0 });
        }
        if (sql.includes('FROM pages')) {
          return scoped.map((source_id) => ({ source_id, n: 1 }));
        }
        if (sql.includes('FROM minion_jobs')) return [];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    } as unknown as BrainEngine;
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: true,
    }).filter((entry) =>
      entry.evidence_adapter === 'ingestion_source' ||
      entry.evidence_adapter === 'embedding');

    const scoped = await collectAllEvidence({
      engine,
      registry,
      now: NOW,
      sourceIds: ['alpha'],
    });

    expect(scoped.evidence.get('embedding.coverage')).toMatchObject({
      backlog_items: 0,
      force_state: 'healthy',
    });
    const sourceBackedCalls = calls.filter(({ sql }) =>
      /FROM (sources|pages|content_chunks|minion_jobs)/.test(sql));
    expect(sourceBackedCalls).toHaveLength(4);
    for (const call of sourceBackedCalls) {
      expect(call.sql).toContain('ANY($1::text[])');
      expect(call.params).toEqual([['alpha']]);
    }

    calls.length = 0;
    const localWholeBrain = await collectAllEvidence({ engine, registry, now: NOW });
    expect(localWholeBrain.evidence.get('embedding.coverage')?.backlog_items).toBe(100);
    expect(calls.every(({ params }) => params === undefined)).toBe(true);
  });

  test('collector timeout aborts the database query before returning and permits the next refresh', async () => {
    let activeQueries = 0;
    let cancelledQueries = 0;
    let receivedSignal = false;
    const engine = {
      kind: 'pglite',
      executeRaw: async (
        _sql: string,
        _params?: unknown[],
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal !== undefined;
        activeQueries++;
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            activeQueries--;
            cancelledQueries++;
            reject(new DOMException('aborted', 'AbortError'));
          };
          opts?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((candidate) => candidate.evidence_adapter === 'facts')!;

    const timedOut = await withObserverReadOnlyEngine(engine, (readOnlyEngine) =>
      collectAllEvidence({
        engine: readOnlyEngine,
        registry: [entry],
        now: NOW,
        timeoutMs: 10,
        adapters: {
          facts: async (entries, adapterEngine, adapterOpts) => {
            expect(adapterOpts.signal).toBeInstanceOf(AbortSignal);
            await adapterEngine!.executeRaw('SELECT pg_sleep(60)');
            return new Map(entries.map((candidate) => [candidate.key, null]));
          },
        },
      }));

    expect(timedOut.partial).toBe(true);
    expect(timedOut.warnings).toContain('collector_timeout');
    expect(receivedSignal).toBe(true);
    expect(cancelledQueries).toBe(1);
    expect(activeQueries).toBe(0);

    const startedAt = performance.now();
    const next = await collectAllEvidence({
      engine: null,
      registry: [entry],
      now: NOW,
      timeoutMs: 100,
      adapters: {
        facts: async (entries) => new Map(entries.map((candidate) => [candidate.key, null])),
      },
    });
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(next.partial).toBe(false);
  });

  test('collectors return real evidence through the frozen read-only facade', async () => {
    let receivedSignal = false;
    const engine = {
      kind: 'pglite',
      executeRaw: async (
        sql: string,
        _params?: unknown[],
        opts?: { signal?: AbortSignal },
      ) => {
        expect(sql).toContain('FROM facts');
        receivedSignal = opts?.signal !== undefined;
        return [{ source_id: 'alpha', count: 7 }];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const entry = buildExpectedWorkRegistry({
      sourceIds: ['alpha'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).find((candidate) => candidate.evidence_adapter === 'facts')!;

    const result = await withObserverReadOnlyEngine(engine, (readOnlyEngine) =>
      collectAllEvidence({
        engine: readOnlyEngine,
        registry: [entry],
        now: NOW,
      }));

    expect(result.partial).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.evidence.get(entry.key)?.backlog_items).toBe(7);
    expect(receivedSignal).toBe(true);
  });

  test('facts aggregate all source counts in one query and fill absent groups with zero', async () => {
    let calls = 0;
    const engine = {
      executeRaw: async () => {
        calls++;
        return [{ source_id: 'alpha', count: 7 }];
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'facts');

    const result = await collectFactEvidence(entries, engine, { now: NOW });

    expect(calls).toBe(1);
    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(7);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)?.backlog_items).toBe(0);
  });

  test('links aggregate all source counts in one query', async () => {
    let calls = 0;
    const engine = {
      executeRaw: async () => {
        calls++;
        return [
          { source_id: 'alpha', count: 3 },
          { source_id: 'beta', count: 1 },
        ];
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'links');

    const result = await collectLinkEvidence(entries, engine, { now: NOW });

    expect(calls).toBe(1);
    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(3);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)?.backlog_items).toBe(1);
  });

  test('fact and link batches intersect registry entries with the remote source grant', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return [{ source_id: 'alpha', count: 1 }];
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });
    const factEntries = entries.filter((entry) => entry.evidence_adapter === 'facts');
    const linkEntries = entries.filter((entry) => entry.evidence_adapter === 'links');

    const facts = await collectFactEvidence(factEntries, engine, {
      now: NOW,
      sourceIds: ['alpha'],
    });
    const links = await collectLinkEvidence(linkEntries, engine, {
      now: NOW,
      sourceIds: ['alpha'],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.params?.[0]).toEqual(['alpha']);
    expect(calls[1]?.params?.[0]).toEqual(['alpha']);
    expect(facts.get(factEntries.find((entry) => entry.selector === 'beta')!.key)).toMatchObject({
      force_state: 'unknown',
    });
    expect(links.get(linkEntries.find((entry) => entry.selector === 'beta')!.key)).toMatchObject({
      force_state: 'unknown',
    });
  });

  test('a failed batch falls back to isolated source evidence', async () => {
    const engine = {
      executeRaw: async () => {
        throw new Error('batch unavailable');
      },
      countUnconsolidatedFacts: async (sourceId: string) => {
        if (sourceId === 'beta') throw new Error('source unavailable');
        return 4;
      },
    } as unknown as BrainEngine;
    const entries = buildExpectedWorkRegistry({
      sourceIds: ['alpha', 'beta'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      enabledDreamPhases: [],
      includeInfrastructure: false,
    }).filter((entry) => entry.evidence_adapter === 'facts');

    const result = await collectFactEvidence(entries, engine, { now: NOW });

    expect(result.get(entries.find((entry) => entry.selector === 'alpha')!.key)?.backlog_items).toBe(4);
    expect(result.get(entries.find((entry) => entry.selector === 'beta')!.key)).toMatchObject({
      backlog_items: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    });
  });
});
