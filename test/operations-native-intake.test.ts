import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  operationsByName,
  type AuthInfo,
  type OperationContext,
} from '../src/core/operations.ts';
import {
  NATIVE_INTAKE_API_VERSION,
  computeContentHash,
  type NativeIntakeEnvelope,
} from '../src/core/ingestion/types.ts';
import { HOST_BRAIN_ID } from '../src/core/brain-registry.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // resetPgliteState truncates `config`; MinionQueue.ensureSchema requires
  // the initialized version marker before accepting protected internal work.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
       ('birdclaw', 'BirdClaw', $1::jsonb),
       ('research', 'Research', $2::jsonb)`,
    [
      { native_intake: { allowed_targets: ['research'] } },
      {
        native_intake: {
          posture: 'research',
          promotion_policy_ids: ['reviewed-evidence'],
        },
      },
    ],
  );
});

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

function envelope(overrides: Partial<NativeIntakeEnvelope> = {}): NativeIntakeEnvelope {
  const content = overrides.content ?? '# adapter evidence';
  return {
    api_version: NATIVE_INTAKE_API_VERSION,
    brain_id: HOST_BRAIN_ID,
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

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  const auth: AuthInfo = {
    token: 'fixture-token',
    clientId: 'birdclaw-adapter',
    clientName: 'BirdClaw adapter',
    scopes: ['write'],
    sourceId: 'birdclaw',
  };
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'birdclaw',
    brainId: HOST_BRAIN_ID,
    auth,
    ...overrides,
  };
}

async function submit(
  item: NativeIntakeEnvelope,
  ctx: OperationContext = context(),
): Promise<unknown> {
  return operationsByName.submit_native_intake.handler(ctx, { envelope: item });
}

describe('submit_native_intake operation adapter seam', () => {
  test('is an authenticated remote write operation', () => {
    const operation = operationsByName.submit_native_intake;
    expect(operation).toBeDefined();
    expect(operation.scope).toBe('write');
    expect(operation.localOnly).not.toBe(true);
    expect(operation.params).toEqual({
      envelope: expect.objectContaining({ type: 'object', required: true }),
    });
  });

  test('returns only bounded accepted and duplicate state', async () => {
    const accepted = await submit(envelope());
    const duplicate = await submit(envelope({
      received_at: '2026-07-23T12:01:00.000Z',
      source_uri: 'birdclaw:item/retried-location',
    }));

    expect(accepted).toEqual({ disposition: 'accepted', job_status: 'waiting' });
    expect(duplicate).toEqual({ disposition: 'duplicate', job_status: 'waiting' });
    expect(JSON.stringify({ accepted, duplicate })).not.toContain('external-item-1');
    expect(JSON.stringify({ accepted, duplicate })).not.toContain('delivery-1');
    expect(JSON.stringify({ accepted, duplicate })).not.toContain('birdclaw:item');
  });

  test('reports content-free conflict, authorization, brain, and terminal errors', async () => {
    await submit(envelope());

    const changedContent = '# changed private evidence';
    await expect(submit(envelope({
      content: changedContent,
      content_hash: computeContentHash(changedContent),
      idempotency_key: 'delivery-1',
      source_uri: 'SECRET-URI',
    }))).rejects.toMatchObject({ code: 'idempotency_conflict' });

    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = 'birdclaw'`,
      [{ native_intake: { allowed_targets: ['default'] } }],
    );
    await expect(submit(envelope({
      external_id: 'unauthorized-item',
      idempotency_key: 'unauthorized-delivery',
    }))).rejects.toMatchObject({ code: 'unauthorized_target' });

    await expect(submit(envelope({
      brain_id: 'other',
      external_id: 'wrong-brain-item',
      idempotency_key: 'wrong-brain-delivery',
    }))).rejects.toMatchObject({ code: 'brain_mismatch' });

    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = 'birdclaw'`,
      [{ native_intake: { allowed_targets: ['research'] } }],
    );
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead' WHERE id = (SELECT max(id) FROM minion_jobs)`,
    );
    await expect(submit(envelope())).rejects.toMatchObject({ code: 'prior_delivery_terminal' });

    try {
      await submit(envelope({
        content: changedContent,
        content_hash: computeContentHash(changedContent),
      }));
      throw new Error('expected native intake conflict');
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(changedContent);
      expect(serialized).not.toContain('external-item-1');
      expect(serialized).not.toContain('delivery-1');
      expect(serialized).not.toContain('birdclaw:item');
    }
  });

  test('binds producer to authenticated source and rejects unauthenticated callers', async () => {
    await expect(submit(
      envelope({ source_id: 'other-producer' }),
      context(),
    )).rejects.toMatchObject({ code: 'producer_mismatch' });

    await expect(submit(
      envelope(),
      context({ auth: undefined }),
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('rejects local and unspecified transport contexts even with valid auth', async () => {
    await expect(submit(
      envelope(),
      context({ remote: false }),
    )).rejects.toMatchObject({ code: 'permission_denied' });

    await expect(submit(
      envelope(),
      context({ remote: undefined }),
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('requires a selected runtime identity', async () => {
    await expect(submit(
      envelope(),
      context({ brainId: undefined }),
    )).rejects.toMatchObject({ code: 'native_intake_unavailable' });
  });

  test('accepts a matching non-host runtime and rejects an envelope for another brain', async () => {
    const accepted = await submit(
      envelope({ brain_id: 'team-brain' }),
      context({ brainId: 'team-brain' }),
    );
    expect(accepted).toEqual({ disposition: 'accepted', job_status: 'waiting' });

    await expect(submit(
      envelope({
        brain_id: HOST_BRAIN_ID,
        external_id: 'other-brain-item',
        idempotency_key: 'other-brain-delivery',
      }),
      context({ brainId: 'team-brain' }),
    )).rejects.toMatchObject({ code: 'brain_mismatch' });
  });

  test('redacts unexpected backend failures', async () => {
    const backendMessage = 'db failed for SECRET-URI external-item-1 delivery-1';
    const failingEngine = new Proxy(engine, {
      get(target, property, receiver) {
        if (property === 'executeRaw') {
          return async () => {
            throw new Error(backendMessage);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      await submit(envelope(), context({ engine: failingEngine }));
      throw new Error('expected backend failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'native_intake_unavailable',
        message: 'Native intake submission unavailable.',
      });
      expect(JSON.stringify(error)).not.toContain(backendMessage);
      expect(JSON.stringify(error)).not.toContain('SECRET-URI');
      expect(JSON.stringify(error)).not.toContain('external-item-1');
      expect(JSON.stringify(error)).not.toContain('delivery-1');
    }
  });

  test('dispatch serializes success, threads authenticated identity, and skips hot-memory metadata', async () => {
    let metaHookCalls = 0;
    const result = await dispatchToolCall(
      engine,
      'submit_native_intake',
      { envelope: envelope({ brain_id: 'team-brain' }) },
      {
        remote: true,
        sourceId: 'birdclaw',
        brainId: 'team-brain',
        auth: context().auth,
        metaHook: async () => {
          metaHookCalls += 1;
          return { brain_hot_memory: { facts: [{ fact: 'must not be attached' }] } };
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      disposition: 'accepted',
      job_status: 'waiting',
    });
    expect(metaHookCalls).toBe(0);
    expect(result._meta).toBeUndefined();
  });
});
