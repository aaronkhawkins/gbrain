import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import {
  NativeIntakeAdmissionError,
  submitNativeIntake,
} from '../../src/core/ingestion/native-intake.ts';
import {
  NATIVE_INTAKE_API_VERSION,
  computeContentHash,
  type NativeIntakeEnvelope,
} from '../../src/core/ingestion/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 30_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
       ('birdclaw', 'BirdClaw', $1::jsonb),
       ('research', 'Research', $2::jsonb),
       ('canonical', 'Canonical', $3::jsonb)`,
    [
      { native_intake: { allowed_targets: ['research', 'canonical'] } },
      { native_intake: { posture: 'research', promotion_policy_ids: ['reviewed-evidence'] } },
      { native_intake: { posture: 'canonical' } },
    ],
  );
});

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

function envelope(overrides: Partial<NativeIntakeEnvelope> = {}): NativeIntakeEnvelope {
  const content = overrides.content ?? '# durable evidence';
  return {
    api_version: NATIVE_INTAKE_API_VERSION,
    brain_id: 'host',
    source_id: 'birdclaw',
    target_source_id: 'research',
    external_id: 'external-item-1',
    idempotency_key: 'delivery-1',
    posture: 'research',
    promotion_boundary: {
      target_posture: 'canonical',
      authority: 'policy',
      policy_id: 'reviewed-evidence',
    },
    source_kind: 'birdclaw',
    source_uri: 'birdclaw:item/external-item-1',
    received_at: '2026-07-23T12:00:00.000Z',
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

const context = {
  activeBrainId: 'host',
  authenticatedSourceId: 'birdclaw',
};

describe('submitNativeIntake', () => {
  test('admits text to the registered target and queues the full normalized event', async () => {
    const result = await submitNativeIntake(engine, queue, envelope(), context);

    expect(result.disposition).toBe('accepted');
    expect(result.job_status).toBe('waiting');
    expect(result.target_source_id).toBe('research');
    const job = await queue.getJob(result.job_id);
    expect(job?.name).toBe('ingest_capture');
    expect(job?.data.sourceId).toBe('research');
    expect(job?.data.event).toEqual(envelope());
    expect(job?.remove_on_complete).toBe(false);
    expect(job?.remove_on_fail).toBe(false);
  });

  test('acknowledges an exact retry as duplicate and preserves the first writer', async () => {
    const first = await submitNativeIntake(engine, queue, envelope(), context);
    const retry = envelope({
      received_at: '2026-07-23T12:01:00.000Z',
      source_created_at: '2026-07-22T10:00:00.000Z',
      source_uri: 'birdclaw:item/incidental-uri-change',
      metadata: { incidental: true },
    });
    const duplicate = await submitNativeIntake(engine, queue, retry, context);

    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.job_status).toBe('waiting');
    expect(duplicate.job_id).toBe(first.job_id);
    const stored = await queue.getJob(first.job_id);
    expect((stored?.data.event as NativeIntakeEnvelope).received_at)
      .toBe('2026-07-23T12:00:00.000Z');
  });

  test('reports duplicate job status for live and successfully completed prior deliveries', async () => {
    for (const [index, status] of (['waiting', 'delayed', 'active', 'completed'] as const).entries()) {
      const item = envelope({
        external_id: `status-item-${index}`,
        idempotency_key: `status-delivery-${index}`,
      });
      const first = await submitNativeIntake(engine, queue, item, context);
      await engine.executeRaw(
        `UPDATE minion_jobs SET status = $1 WHERE id = $2`,
        [status, first.job_id],
      );

      const duplicate = await submitNativeIntake(engine, queue, item, context);
      expect(duplicate.disposition).toBe('duplicate');
      expect(duplicate.job_status).toBe(status);
    }
  });

  test('does not acknowledge failed, dead, or cancelled prior deliveries as duplicates', async () => {
    for (const [index, status] of (['failed', 'dead', 'cancelled'] as const).entries()) {
      const item = envelope({
        external_id: `terminal-item-${index}`,
        idempotency_key: `terminal-delivery-${index}`,
      });
      const first = await submitNativeIntake(engine, queue, item, context);
      await engine.executeRaw(
        `UPDATE minion_jobs SET status = $1 WHERE id = $2`,
        [status, first.job_id],
      );

      await expect(submitNativeIntake(engine, queue, item, context))
        .rejects.toMatchObject({ code: 'prior_delivery_terminal' });
    }
  });

  test('concurrent retries produce one durable job and one duplicate acknowledgement', async () => {
    const results = await Promise.all([
      submitNativeIntake(engine, queue, envelope(), context),
      submitNativeIntake(engine, queue, envelope(), context),
    ]);

    expect(results.map((result) => result.disposition).sort())
      .toEqual(['accepted', 'duplicate']);
    expect(new Set(results.map((result) => result.job_id)).size).toBe(1);
    expect(await queue.getJobs({ name: 'ingest_capture' })).toHaveLength(1);
  });

  test('surfaces a conflict when the same durable key carries different content', async () => {
    await submitNativeIntake(engine, queue, envelope(), context);
    const changed = envelope({
      content: '# changed evidence',
      content_hash: computeContentHash('# changed evidence'),
    });

    await expect(submitNativeIntake(engine, queue, changed, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('rejects malformed stored job wrappers and claimed hashes as conflicts', async () => {
    const wrongName = envelope({ external_id: 'wrong-name', idempotency_key: 'wrong-name' });
    const wrongNameFirst = await submitNativeIntake(engine, queue, wrongName, context);
    await engine.executeRaw(`UPDATE minion_jobs SET name = 'sync' WHERE id = $1`, [wrongNameFirst.job_id]);
    await expect(submitNativeIntake(engine, queue, wrongName, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });

    const wrongTarget = envelope({ external_id: 'wrong-target', idempotency_key: 'wrong-target' });
    const wrongTargetFirst = await submitNativeIntake(engine, queue, wrongTarget, context);
    await engine.executeRaw(
      `UPDATE minion_jobs SET data = jsonb_set(data, '{sourceId}', '"canonical"'::jsonb) WHERE id = $1`,
      [wrongTargetFirst.job_id],
    );
    await expect(submitNativeIntake(engine, queue, wrongTarget, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });

    const wrongBody = envelope({ external_id: 'wrong-body', idempotency_key: 'wrong-body' });
    const wrongBodyFirst = await submitNativeIntake(engine, queue, wrongBody, context);
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{event,content}', to_jsonb('tampered body'::text))
        WHERE id = $1`,
      [wrongBodyFirst.job_id],
    );
    await expect(submitNativeIntake(engine, queue, wrongBody, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('compares processing-affecting fields while ignoring receipt metadata and source URI', async () => {
    for (const [index, path] of [
      'content_type',
      'source_kind',
      'promotion_boundary',
      'untrusted_payload',
    ].entries()) {
      const item = envelope({
        external_id: `processing-item-${index}`,
        idempotency_key: `processing-delivery-${index}`,
      });
      const first = await submitNativeIntake(engine, queue, item, context);
      const replacement = path === 'promotion_boundary'
        ? { target_posture: 'canonical', authority: 'operator' }
        : path === 'content_type'
          ? 'text/plain'
          : path === 'untrusted_payload'
            ? true
          : 'changed-kind';
      await engine.executeRaw(
        `UPDATE minion_jobs
            SET data = jsonb_set(data, $1::text[], $2::jsonb)
          WHERE id = $3`,
        [['event', path], JSON.stringify(replacement), first.job_id],
      );
      await expect(submitNativeIntake(engine, queue, item, context))
        .rejects.toMatchObject({ code: 'idempotency_conflict' });
    }
  });

  test('conflicts when event metadata changes the effective slug', async () => {
    const first = envelope({
      metadata: {
        slug: 'research/original-destination',
        incidental: 'first receipt',
      },
    });
    await submitNativeIntake(engine, queue, first, context);

    const changedSlug = envelope({
      metadata: {
        slug: 'research/different-destination',
        incidental: 'retry receipt',
      },
    });
    await expect(submitNativeIntake(engine, queue, changedSlug, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('conflicts when a stored job wrapper changes slug or embedding semantics', async () => {
    const wrongSlug = envelope({ external_id: 'wrapper-slug', idempotency_key: 'wrapper-slug' });
    const wrongSlugFirst = await submitNativeIntake(engine, queue, wrongSlug, context);
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{slug}', to_jsonb('research/forged'::text))
        WHERE id = $1`,
      [wrongSlugFirst.job_id],
    );
    await expect(submitNativeIntake(engine, queue, wrongSlug, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });

    const inlineEmbed = envelope({ external_id: 'wrapper-embed', idempotency_key: 'wrapper-embed' });
    const inlineEmbedFirst = await submitNativeIntake(engine, queue, inlineEmbed, context);
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{noEmbed}', 'false'::jsonb)
        WHERE id = $1`,
      [inlineEmbedFirst.job_id],
    );
    await expect(submitNativeIntake(engine, queue, inlineEmbed, context))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('rejects brain routing, producer spoofing, and unauthorized targets', async () => {
    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({ brain_id: 'other' }),
      context,
    )).rejects.toMatchObject({ code: 'brain_mismatch' });
    await expect(submitNativeIntake(
      engine,
      queue,
      envelope(),
      { ...context, authenticatedSourceId: 'other-adapter' },
    )).rejects.toMatchObject({ code: 'producer_mismatch' });

    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = 'birdclaw'`,
      [{ native_intake: { allowed_targets: ['canonical'] } }],
    );
    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'unauthorized_target' });
    expect((await queue.getJobs({ name: 'ingest_capture' }))).toHaveLength(0);
  });

  test('fails closed for missing, archived, or malformed source policy', async () => {
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'research'`);
    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'target_unavailable' });

    await engine.executeRaw(`UPDATE sources SET archived = false, config = '{}'::jsonb WHERE id = 'research'`);
    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'invalid_target_policy' });

    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'birdclaw'`);
    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'producer_unavailable' });

    await engine.executeRaw(`UPDATE sources SET archived = false, config = '{}'::jsonb WHERE id = 'birdclaw'`);
    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'invalid_producer_policy' });
  });

  test('rejects target posture and promotion policy mismatches', async () => {
    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({
        posture: 'inbox',
        promotion_boundary: {
          target_posture: 'canonical',
          authority: 'operator',
        },
      }),
      context,
    )).rejects.toMatchObject({ code: 'posture_mismatch' });

    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({
        promotion_boundary: {
          target_posture: 'canonical',
          authority: 'policy',
          policy_id: 'unregistered-policy',
        },
      }),
      context,
    )).rejects.toMatchObject({ code: 'promotion_policy_unauthorized' });

    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({
        promotion_boundary: {
          target_posture: 'canonical',
          authority: 'operator',
        },
      }),
      context,
    )).rejects.toMatchObject({ code: 'operator_promotion_unsupported' });
  });

  test('rejects malformed configured promotion policy ids as invalid target policy', async () => {
    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = 'research'`,
      [{
        native_intake: {
          posture: 'research',
          promotion_policy_ids: ['reviewed-evidence', 'INVALID POLICY'],
        },
      }],
    );

    await expect(submitNativeIntake(engine, queue, envelope(), context))
      .rejects.toMatchObject({ code: 'invalid_target_policy' });
  });

  test('fails closed when a legacy source row has no archived state', async () => {
    const legacyEngine = new Proxy(engine, {
      get(target, property) {
        if (property === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (sql.includes(', archived,')) {
              throw Object.assign(new Error('column archived does not exist'), { code: '42703' });
            }
            return target.executeRaw(sql, params);
          };
        }
        const value = target[property as keyof PGLiteEngine];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;
    const legacyQueue = new MinionQueue(legacyEngine);

    await expect(submitNativeIntake(legacyEngine, legacyQueue, envelope(), context))
      .rejects.toMatchObject({ code: 'producer_unavailable' });
  });

  test('recomputes text hashes and explicitly rejects binary/path payloads', async () => {
    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({ content_hash: '0'.repeat(64) }),
      context,
    )).rejects.toMatchObject({ code: 'content_hash_mismatch' });

    await expect(submitNativeIntake(
      engine,
      queue,
      envelope({
        content_type: 'audio/*',
        content: '/private/recordings/secret.wav',
        content_hash: 'a'.repeat(64),
      }),
      context,
    )).rejects.toMatchObject({ code: 'unsupported_content_type' });
  });

  test('errors never expose content, external identity, URI, or raw idempotency key', async () => {
    const sensitive = envelope({
      content: 'SECRET BODY',
      content_hash: '0'.repeat(64),
      external_id: 'SECRET-EXTERNAL',
      source_uri: 'SECRET-URI',
      idempotency_key: 'SECRET-RAW-KEY',
    });

    try {
      await submitNativeIntake(engine, queue, sensitive, context);
      throw new Error('expected admission rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeIntakeAdmissionError);
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('SECRET BODY');
      expect(serialized).not.toContain('SECRET-EXTERNAL');
      expect(serialized).not.toContain('SECRET-URI');
      expect(serialized).not.toContain('SECRET-RAW-KEY');
    }
  });
});
