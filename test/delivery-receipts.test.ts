import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function context(sourceId = 'default', remote = false): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    dryRun: false,
    remote,
    sourceId,
  };
}

async function seedPage(slug: string, sourceId = 'default'): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: 'Fixture content',
    timeline: '',
  }, { sourceId });
}

describe('delivery receipts', () => {
  test('the same delivery key returns one receipt for one existing page', async () => {
    await seedPage('inbox/bookmark-42');
    const record = operationsByName.record_delivery;

    const first = await record.handler(context(), {
      delivery_key: 'birdclaw:bookmark:42',
      slug: 'inbox/bookmark-42',
      content_digest: 'a'.repeat(64),
    }) as { receipt_id: number };
    const replay = await record.handler(context(), {
      delivery_key: 'birdclaw:bookmark:42',
      slug: 'inbox/bookmark-42',
      content_digest: 'a'.repeat(64),
    }) as { receipt_id: number };

    expect(replay.receipt_id).toBe(first.receipt_id);
    expect(await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM delivery_receipts',
    )).toEqual([{ count: 1 }]);
    expect(await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages
        WHERE source_id = 'default' AND slug = 'inbox/bookmark-42'`,
    )).toEqual([{ count: 1 }]);
  }, 30_000);

  test('readiness exposes a bounded failed state and flips after retry', async () => {
    await seedPage('inbox/bookmark-43');
    const record = operationsByName.record_delivery;
    const readiness = operationsByName.get_readiness_status;
    const params = {
      delivery_key: 'birdclaw:bookmark:43',
      slug: 'inbox/bookmark-43',
      content_digest: 'b'.repeat(64),
      assessment_version: '1',
    };

    await record.handler(context(), {
      ...params,
      readiness_status: 'failed',
      reason_code: 'enrichment_failed',
    });
    expect(await readiness.handler(context(), {
      delivery_key: params.delivery_key,
    })).toEqual(expect.objectContaining({
      delivery_key: params.delivery_key,
      status: 'failed',
      knowledge_ready: false,
      assessment_version: '1',
      reason_code: 'enrichment_failed',
    }));

    await record.handler(context(), {
      ...params,
      readiness_status: 'ready',
    });
    expect(await readiness.handler(context(), {
      delivery_key: params.delivery_key,
    })).toEqual(expect.objectContaining({
      status: 'ready',
      knowledge_ready: true,
      assessment_version: '1',
      reason_code: null,
    }));

    await record.handler(context(), {
      ...params,
      readiness_status: 'failed',
      reason_code: 'late_failure',
    });
    expect(await readiness.handler(context(), {
      delivery_key: params.delivery_key,
    })).toEqual(expect.objectContaining({
      status: 'ready',
      knowledge_ready: true,
    }));
  }, 30_000);

  test('supersession is idempotent and preserves one audit marker', async () => {
    await seedPage('inbox/original');
    await seedPage('inbox/replacement');
    const supersede = operationsByName.supersede_page;
    const params = {
      slug: 'inbox/original',
      supersession_key: 'correction:bookmark:44',
      superseded_by_brain: 'host',
      superseded_by_source_id: 'default',
      superseded_by_slug: 'inbox/replacement',
    };

    const first = await supersede.handler(context(), params) as { supersession_id: number };
    const replay = await supersede.handler(context(), params) as { supersession_id: number };

    expect(replay.supersession_id).toBe(first.supersession_id);
    expect(await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM page_supersessions',
    )).toEqual([{ count: 1 }]);
    expect(await engine.executeRaw<{ superseded_by_slug: string }>(
      'SELECT superseded_by_slug FROM page_supersessions',
    )).toEqual([{ superseded_by_slug: 'inbox/replacement' }]);
  }, 30_000);

  test('a second correction key cannot replace an existing supersession marker', async () => {
    await seedPage('inbox/original');
    await seedPage('inbox/replacement');
    await seedPage('inbox/other-replacement');
    const supersede = operationsByName.supersede_page;
    const first = {
      slug: 'inbox/original',
      supersession_key: 'correction:bookmark:44',
      superseded_by_brain: 'host',
      superseded_by_source_id: 'default',
      superseded_by_slug: 'inbox/replacement',
    };
    await supersede.handler(context(), first);

    await expect(supersede.handler(context(), {
      ...first,
      supersession_key: 'correction:bookmark:44:retry',
      superseded_by_slug: 'inbox/other-replacement',
    })).rejects.toMatchObject({
      code: 'storage_error',
      message: 'supersession key is already bound to a different correction',
    });
    expect(await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM page_supersessions',
    )).toEqual([{ count: 1 }]);
  }, 30_000);

  test('readiness cannot cross a remote caller source boundary', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('private', 'private', '{"federated": false}'::jsonb)`,
    );
    await seedPage('inbox/private-item', 'private');
    await operationsByName.record_delivery.handler(context('private'), {
      delivery_key: 'private:item:1',
      slug: 'inbox/private-item',
      content_digest: 'c'.repeat(64),
      readiness_status: 'ready',
      assessment_version: '1',
    });

    await expect(operationsByName.get_readiness_status.handler(
      context('default', true),
      { delivery_key: 'private:item:1' },
    )).rejects.toMatchObject({ code: 'page_not_found' });
  }, 30_000);
});
