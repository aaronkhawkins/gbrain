/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  defaultSlugForEvent,
  makeIngestCaptureHandler,
} from '../../src/core/minions/handlers/ingest-capture.ts';
import {
  NATIVE_INTAKE_API_VERSION,
  computeContentHash,
  type IngestionEvent,
  type NativeIntakeEnvelope,
} from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { UnrecoverableError } from '../../src/core/minions/types.ts';

let engine: PGLiteEngine;

// 30s hook timeout — when this file runs deep in a shard process that's
// already created ~20 PGLite engines, the WASM cold-start + 95 migrations
// on a fresh DB legitimately exceeds bun's 5s hook default. CI shard 4
// hit this on v0.41.17.0 (95 migrations × 21 files × 1 bun process).
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# captured thought';
  return {
    source_id: 'webhook-test',
    source_kind: 'webhook',
    source_uri: 'mcp-webhook:client-x:1234',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

function makeJob(data: Record<string, unknown>): MinionJobContext {
  return {
    id: 1,
    name: 'ingest_capture',
    data,
    attempts_made: 1,
    signal: new AbortController().signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

describe('defaultSlugForEvent', () => {
  test('builds inbox/YYYY-MM-DD-<hash6> slug', () => {
    const ev = makeEvent({ content_hash: 'abcdef1234567890'.padEnd(64, '0') });
    const slug = defaultSlugForEvent(ev, new Date('2026-05-20T00:00:00Z'));
    expect(slug).toBe('inbox/2026-05-20-abcdef');
  });

  test('stable for same content (deterministic hash)', () => {
    const ev = makeEvent({ content: 'same thought' });
    const date = new Date('2026-05-20T00:00:00Z');
    expect(defaultSlugForEvent(ev, date)).toBe(defaultSlugForEvent(ev, date));
  });

  test('UTC date math (no tz drift)', () => {
    const ev = makeEvent();
    const slug = defaultSlugForEvent(ev, new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('ingest_capture handler — slug resolution', () => {
  test('uses caller-provided job.data.slug when present', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'with explicit slug' });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/specific/page' }));
    expect(result.slug).toBe('wiki/specific/page');
    expect(result.status).toBe('imported');
  });

  test('uses event.metadata.slug when set', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'metadata slug', metadata: { slug: 'inbox/custom-from-meta' } });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/custom-from-meta');
  });

  test('falls back to inbox/YYYY-MM-DD-<hash6> when no slug provided', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'fallback slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });
});

describe('ingest_capture handler — validation + routing', () => {
  test('throws when event missing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await expect(handler(makeJob({}))).rejects.toThrow(/job.data.event is required/);
  });

  test('throws on invalid event payload (caught at the handler boundary)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = { ...makeEvent(), content_hash: 'short' };
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(/invalid event payload/);
  });

  test('rejects binary content_type with helpful message', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content_type: 'image/*',
      content: '/path/to/screenshot.png',
      content_hash: computeContentHash('/path/to/screenshot.png'),
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content_type 'image\/\*' requires a content-type processor/,
    );
  });

  test('untrusted_payload flag round-trips to the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'untrusted', untrusted_payload: true });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(true);
  });

  test('trusted (default) payload round-trips as false', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'trusted' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(false);
  });

  test('source provenance round-trips into the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'with provenance',
      source_kind: 'inbox-folder',
      source_uri: '/Users/test/.gbrain/inbox/note.md',
    });
    const result = await handler(makeJob({ event: ev }));
    expect(result.source_kind).toBe('inbox-folder');
    expect(result.source_uri).toBe('/Users/test/.gbrain/inbox/note.md');
  });
});

describe('ingest_capture handler — provenance write-through (#1522)', () => {
  async function pageRow(slug: string): Promise<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null } | undefined> {
    const rows = await engine.executeRaw<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null }>(
      `SELECT source_id, source_kind, source_uri, ingested_via FROM pages WHERE slug = $1`,
      [slug],
    );
    return rows[0];
  }

  test('trusted event with a registered source id routes the page write there and persists source_kind/source_uri', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('m365-example', 'm365-example') ON CONFLICT (id) DO NOTHING`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# calendar event',
      source_id: 'm365-example',
      source_kind: 'm365-calendar',
      source_uri: 'm365:event/abc-123',
    });
    const result = await handler(makeJob({ event: ev, slug: 'calendar/evt-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('calendar/evt-1');
    expect(row?.source_id).toBe('m365-example');
    expect(row?.source_kind).toBe('m365-calendar');
    expect(row?.source_uri).toBe('m365:event/abc-123');
    expect(row?.ingested_via).toBe('ingest_capture');
  });

  test('unregistered emitter source_id (webhook-<clientId>) keeps default-source routing but still persists provenance', async () => {
    const handler = makeIngestCaptureHandler(engine);
    // makeEvent's source_id 'webhook-test' is NOT a registered source.
    const ev = makeEvent({ content: '# webhook capture' });
    const result = await handler(makeJob({ event: ev, slug: 'inbox/webhook-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('inbox/webhook-1');
    expect(row?.source_id).toBe('default');
    expect(row?.source_kind).toBe('webhook');
    expect(row?.source_uri).toBe('mcp-webhook:client-x:1234');
    expect(row?.ingested_via).toBe('ingest_capture');
  });

  test('untrusted event cannot choose its write source even when the id is registered (fail-closed)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT (id) DO NOTHING`,
    );
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '# untrusted payload',
      source_id: 'wiki',
      untrusted_payload: true,
    });
    const result = await handler(makeJob({ event: ev, slug: 'inbox/untrusted-1' }));
    expect(result.status).toBe('imported');

    const row = await pageRow('inbox/untrusted-1');
    expect(row?.source_id).toBe('default');
    // Provenance strings (no scoping power) still persist.
    expect(row?.source_kind).toBe('webhook');
  });

  test('native intake uses the server-resolved top-level target instead of producer identity', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('research', 'research') ON CONFLICT (id) DO NOTHING`,
    );
    const content = '# native evidence';
    const ev: NativeIntakeEnvelope = {
      ...makeEvent({
        source_id: 'birdclaw',
        source_kind: 'birdclaw',
        source_uri: 'birdclaw:item/1',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: true,
      }),
      api_version: NATIVE_INTAKE_API_VERSION,
      brain_id: 'host',
      target_source_id: 'research',
      external_id: 'item-1',
      posture: 'research',
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'operator',
      },
      idempotency_key: 'delivery-1',
    };
    const handler = makeIngestCaptureHandler(engine);
    const result = await handler(makeJob({
      sourceId: 'research',
      event: ev,
      slug: 'research/native-1',
    }));

    expect(result.source_id).toBe('research');
    expect((await pageRow('research/native-1'))?.source_id).toBe('research');
  });

  test('native intake rejects a target that disagrees with the admitted top-level sourceId', async () => {
    const content = 'SECRET NATIVE BODY';
    const ev: NativeIntakeEnvelope = {
      ...makeEvent({
        source_id: 'birdclaw',
        content,
        content_hash: computeContentHash(content),
      }),
      api_version: NATIVE_INTAKE_API_VERSION,
      brain_id: 'host',
      target_source_id: 'research',
      external_id: 'SECRET-EXTERNAL',
      posture: 'research',
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'operator',
      },
      idempotency_key: 'SECRET-KEY',
    };
    const handler = makeIngestCaptureHandler(engine);

    try {
      await handler(makeJob({ sourceId: 'canonical', event: ev }));
      throw new Error('expected mismatch rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnrecoverableError);
      const message = String(error);
      expect(message).toContain('native target mismatch');
      expect(message).not.toContain('SECRET NATIVE BODY');
      expect(message).not.toContain('SECRET-EXTERNAL');
      expect(message).not.toContain('SECRET-KEY');
    }
  });

  test('native validation failures are unrecoverable but target unavailability remains retryable', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const invalid = {
      ...makeEvent(),
      api_version: NATIVE_INTAKE_API_VERSION,
      target_source_id: 'research',
    };
    try {
      await handler(makeJob({ sourceId: 'research', event: invalid }));
      throw new Error('expected native validation rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnrecoverableError);
    }

    const content = '# target disappears';
    const valid: NativeIntakeEnvelope = {
      ...makeEvent({ content, content_hash: computeContentHash(content) }),
      api_version: NATIVE_INTAKE_API_VERSION,
      brain_id: 'host',
      target_source_id: 'missing-target',
      external_id: 'missing-target-1',
      posture: 'research',
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'operator',
      },
      idempotency_key: 'missing-target-delivery',
    };
    try {
      await handler(makeJob({ sourceId: 'missing-target', event: valid }));
      throw new Error('expected unavailable target');
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(String(error)).toContain('native target unavailable');
    }
  });
});

describe('ingest_capture handler — integration with importFromContent', () => {
  test('imported event lands as a page in the DB', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\ntitle: Test Page\n---\n\n# E2E import\n\nbody content',
    });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/e2e-test' }));
    expect(result.status).toBe('imported');

    const page = await engine.getPage('wiki/e2e-test');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('E2E import');
  });

  test('repeat ingest of same content returns skipped status (content_hash dedup at importFromContent level)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: '# stable content' });
    const result1 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result1.status).toBe('imported');

    const result2 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result2.status).toBe('skipped');
  });

  test('chunks count is reported on imported events', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const longContent = '---\ntitle: long\n---\n\n' + 'Paragraph.\n\n'.repeat(50);
    const ev = makeEvent({ content: longContent });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/long' }));
    expect(result.chunks).toBeGreaterThan(0);
  });
});
