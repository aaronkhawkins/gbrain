import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('MinionQueue.addWithDisposition', () => {
  test('reports inserted for the inserted row and duplicate for an existing idempotency key', async () => {
    const accepted = await queue.addWithDisposition(
      'sync',
      { sourceId: 'research', event: { external_id: 'item-1' } },
      { idempotency_key: 'native-intake:key-1' },
    );
    const duplicate = await queue.addWithDisposition(
      'sync',
      { sourceId: 'research', event: { external_id: 'item-1' } },
      { idempotency_key: 'native-intake:key-1' },
    );

    expect(accepted.disposition).toBe('inserted');
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.job.id).toBe(accepted.job.id);
    expect((await queue.getJobs({ name: 'sync' })).length).toBe(1);
  });

  test('keeps add backward-compatible by returning the job directly', async () => {
    const job = await queue.add(
      'sync',
      { sourceId: 'research' },
      { idempotency_key: 'native-intake:key-2' },
    );

    expect(job.name).toBe('sync');
    expect(job.data.sourceId).toBe('research');
  });

  test('distinguishes maxWaiting coalescing from idempotency duplicates', async () => {
    const first = await queue.addWithDisposition(
      'sync',
      { sourceId: 'research' },
      { maxWaiting: 1 },
    );
    const coalesced = await queue.addWithDisposition(
      'sync',
      { sourceId: 'research' },
      { maxWaiting: 1 },
    );

    expect(first.disposition).toBe('inserted');
    expect(coalesced.disposition).toBe('coalesced');
    expect(coalesced.job.id).toBe(first.job.id);
  });

  test('rechecks idempotency after the maxWaiting advisory lock before classifying coalescing', async () => {
    const existing = await queue.add(
      'sync',
      { sourceId: 'research' },
      { idempotency_key: 'native-intake:after-lock' },
    );
    let idempotencyReads = 0;
    const wrappedEngine = new Proxy(engine, {
      get(target, property) {
        if (property === 'transaction') {
          return async (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(async (tx) => {
            const wrappedTx = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === 'executeRaw') {
                  return async (sql: string, params?: unknown[]) => {
                    if (sql.includes('FROM minion_jobs WHERE idempotency_key = $1')) {
                      idempotencyReads += 1;
                      if (idempotencyReads === 1) return [];
                    }
                    return txTarget.executeRaw(sql, params);
                  };
                }
                const value = txTarget[txProperty as keyof BrainEngine];
                return typeof value === 'function' ? value.bind(txTarget) : value;
              },
            });
            return fn(wrappedTx as BrainEngine);
          });
        }
        const value = target[property as keyof PGLiteEngine];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;
    const wrappedQueue = new MinionQueue(wrappedEngine);

    const result = await wrappedQueue.addWithDisposition(
      'sync',
      { sourceId: 'research' },
      { idempotency_key: 'native-intake:after-lock', maxWaiting: 1 },
    );

    expect(result.disposition).toBe('duplicate');
    expect(result.job.id).toBe(existing.id);
    expect(idempotencyReads).toBeGreaterThanOrEqual(2);
  });

  test('rechecks idempotency after the parent lock before child cap validation', async () => {
    const parent = await queue.add('parent', {}, { max_children: 1 });
    const existing = await queue.add(
      'sync',
      {},
      {
        idempotency_key: 'native-intake:after-parent-lock',
        parent_job_id: parent.id,
      },
    );
    let idempotencyReads = 0;
    const wrappedEngine = new Proxy(engine, {
      get(target, property) {
        if (property === 'transaction') {
          return async (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(async (tx) => {
            const wrappedTx = new Proxy(tx, {
              get(txTarget, txProperty) {
                if (txProperty === 'executeRaw') {
                  return async (sql: string, params?: unknown[]) => {
                    if (sql.includes('FROM minion_jobs WHERE idempotency_key = $1')) {
                      idempotencyReads += 1;
                      if (idempotencyReads === 1) return [];
                    }
                    return txTarget.executeRaw(sql, params);
                  };
                }
                const value = txTarget[txProperty as keyof BrainEngine];
                return typeof value === 'function' ? value.bind(txTarget) : value;
              },
            });
            return fn(wrappedTx as BrainEngine);
          });
        }
        const value = target[property as keyof PGLiteEngine];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;
    const wrappedQueue = new MinionQueue(wrappedEngine);

    const result = await wrappedQueue.addWithDisposition(
      'sync',
      {},
      {
        idempotency_key: 'native-intake:after-parent-lock',
        parent_job_id: parent.id,
      },
    );

    expect(result.disposition).toBe('duplicate');
    expect(result.job.id).toBe(existing.id);
    expect(idempotencyReads).toBeGreaterThanOrEqual(2);
  });

  test('generic pruning preserves native-intake idempotency rows', async () => {
    const ordinary = await queue.add('sync', {});
    const native = await queue.add(
      'ingest_capture',
      {},
      { idempotency_key: 'native-intake:retained' },
      { allowProtectedSubmit: true },
    );
    await queue.cancelJob(ordinary.id);
    await queue.cancelJob(native.id);

    expect(await queue.prune({ olderThan: new Date(Date.now() + 86_400_000) })).toBe(1);
    expect(await queue.getJob(ordinary.id)).toBeNull();
    expect(await queue.getJob(native.id)).not.toBeNull();
  });
});
