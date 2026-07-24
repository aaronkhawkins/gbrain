/**
 * Tests for the IngestionEvent + IngestionSource contract types.
 *
 * Pinned at the contract level: changing these tests is a public-API change.
 * Treat them like test/public-exports.test.ts — they're a regression guard
 * for skillpack publishers depending on the surface.
 */

import { describe, expect, test } from 'bun:test';
import {
  INGESTION_CONTENT_TYPES,
  INTAKE_POSTURES,
  INGESTION_SOURCE_API_VERSION,
  NATIVE_INTAKE_API_VERSION,
  IngestionEventError,
  computeContentHash,
  deriveNativeIntakeIdempotencyKey,
  validateNativeIntakeEnvelope,
  validateIngestionEvent,
  type IngestionEvent,
  type IntakePromotionBoundary,
  type NativeIntakeEnvelope,
} from '../../src/core/ingestion/index.ts';

const VALID_HASH = 'a'.repeat(64);

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  return {
    source_id: 'test-source-1',
    source_kind: 'file-watcher',
    source_uri: '/tmp/test.md',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content: '# test content',
    content_hash: VALID_HASH,
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<NativeIntakeEnvelope> = {}): NativeIntakeEnvelope {
  return {
    ...makeEvent(),
    api_version: NATIVE_INTAKE_API_VERSION,
    brain_id: 'host',
    target_source_id: 'research',
    external_id: 'bookmark-01j-example',
    source_created_at: '2026-05-20T11:59:00.000Z',
    posture: 'research',
    promotion_boundary: {
      target_posture: 'canonical',
      authority: 'policy',
      policy_id: 'reviewed-research-v1',
    },
    idempotency_key: 'host:test-source-1:bookmark-01j-example:v1',
    ...overrides,
  };
}

describe('IngestionSource contract constants', () => {
  test('INGESTION_SOURCE_API_VERSION is the v1 string', () => {
    expect(INGESTION_SOURCE_API_VERSION).toBe('gbrain-ingestion-source-v1');
  });

  test('NATIVE_INTAKE_API_VERSION is independent from the producer plugin contract', () => {
    expect(NATIVE_INTAKE_API_VERSION).toBe('gbrain-native-intake-v1');
    expect(NATIVE_INTAKE_API_VERSION).not.toBe(INGESTION_SOURCE_API_VERSION);
  });

  test('INGESTION_CONTENT_TYPES covers the documented taxonomy', () => {
    expect(INGESTION_CONTENT_TYPES).toContain('text/markdown');
    expect(INGESTION_CONTENT_TYPES).toContain('text/plain');
    expect(INGESTION_CONTENT_TYPES).toContain('text/html');
    expect(INGESTION_CONTENT_TYPES).toContain('application/pdf');
    expect(INGESTION_CONTENT_TYPES).toContain('application/json');
    expect(INGESTION_CONTENT_TYPES).toContain('image/*');
    expect(INGESTION_CONTENT_TYPES).toContain('audio/*');
    expect(INGESTION_CONTENT_TYPES).toContain('video/*');
    expect(INGESTION_CONTENT_TYPES).toContain('unknown');
  });

  test('INTAKE_POSTURES defines the four source postures', () => {
    expect(INTAKE_POSTURES).toEqual([
      'canonical',
      'inbox',
      'research',
      'session-evidence',
    ]);
  });
});

describe('NativeIntakeEnvelope contract', () => {
  test('accepts normalized evidence with routing identity, provenance, timestamps, and promotion boundary', () => {
    expect(validateNativeIntakeEnvelope(makeEnvelope())).toBeNull();
  });

  test('requires the current native intake API version', () => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({
      api_version: 'gbrain-native-intake-v0' as NativeIntakeEnvelope['api_version'],
    }));
    expect(err?.field).toBe('api_version');
  });

  test.each(['brain_id', 'source_id', 'target_source_id'] as const)(
    'rejects invalid native intake identity: %s',
    (field) => {
      const err = validateNativeIntakeEnvelope(makeEnvelope({ [field]: '../other' }));
      expect(err?.field).toBe(field);
    },
  );

  test('rejects an invalid external identity', () => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({ external_id: ' \n ' }));
    expect(err?.field).toBe('external_id');
  });

  test('accepts an omitted upstream creation timestamp', () => {
    expect(validateNativeIntakeEnvelope(makeEnvelope({
      source_created_at: undefined,
    }))).toBeNull();
  });

  test.each([
    '2026-05-20',
    '2026-05-20T11:59:00Z',
    '2026-05-20T04:59:00.000-07:00',
    '2026-02-30T11:59:00.000Z',
  ])('rejects non-canonical source_created_at: %s', (source_created_at) => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({ source_created_at }));
    expect(err?.field).toBe('source_created_at');
  });

  test.each([
    '2026-05-20',
    '2026-05-20T12:00:00Z',
    '2026-05-20T05:00:00.000-07:00',
    '2026-02-30T12:00:00.000Z',
    '0',
  ])('rejects non-canonical native received_at: %s', (received_at) => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({ received_at }));
    expect(err?.field).toBe('received_at');
  });

  test('rejects an unknown posture', () => {
    const err = validateNativeIntakeEnvelope(
      makeEnvelope({ posture: 'archive' as NativeIntakeEnvelope['posture'] }),
    );
    expect(err?.field).toBe('posture');
  });

  test('rejects an unsafe idempotency key', () => {
    const err = validateNativeIntakeEnvelope(
      makeEnvelope({ idempotency_key: 'host:test source:external' }),
    );
    expect(err?.field).toBe('idempotency_key');
  });

  test('requires a promotion boundary for evidence postures', () => {
    const err = validateNativeIntakeEnvelope(
      makeEnvelope({ promotion_boundary: undefined }),
    );
    expect(err?.field).toBe('promotion_boundary');
  });

  test('allows canonical intake only without an evidence promotion boundary', () => {
    expect(validateNativeIntakeEnvelope(makeEnvelope({
      posture: 'canonical',
      promotion_boundary: undefined,
    }))).toBeNull();

    const err = validateNativeIntakeEnvelope(makeEnvelope({ posture: 'canonical' }));
    expect(err?.field).toBe('promotion_boundary');
  });

  test('policy-controlled promotion requires a stable policy id', () => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'policy',
      } as unknown as IntakePromotionBoundary,
    }));
    expect(err?.field).toBe('promotion_boundary.policy_id');
  });

  test('operator promotion accepts no policy id and rejects one when untyped', () => {
    expect(validateNativeIntakeEnvelope(makeEnvelope({
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'operator',
      },
    }))).toBeNull();

    const err = validateNativeIntakeEnvelope(makeEnvelope({
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'operator',
        policy_id: 'not-applicable',
      } as unknown as IntakePromotionBoundary,
    }));
    expect(err?.field).toBe('promotion_boundary.policy_id');
  });

  test('promotion boundary rejects invalid shapes at compile time', () => {
    // @ts-expect-error policy authority requires policy_id
    const missingPolicy: IntakePromotionBoundary = {
      target_posture: 'canonical',
      authority: 'policy',
    };
    // @ts-expect-error operator authority forbids policy_id
    const operatorPolicy: IntakePromotionBoundary = {
      target_posture: 'canonical',
      authority: 'operator',
      policy_id: 'not-applicable',
    };
    expect([missingPolicy.authority, operatorPolicy.authority]).toEqual(['policy', 'operator']);
  });

  test('native validation errors expose only bounded diagnostic identity', () => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({
      target_source_id: '../other',
      source_uri: 'private://sensitive-location',
      external_id: 'sensitive-external-id',
      idempotency_key: 'sensitive-retry-key',
      content: 'confidential page body',
      metadata: { secret: 'confidential metadata' },
    }));
    expect(err?.event.target_source_id).toBe('../other');
    expect(err?.event.brain_id).toBe('host');
    expect(err?.event).toEqual({
      api_version: NATIVE_INTAKE_API_VERSION,
      brain_id: 'host',
      source_id: 'test-source-1',
      target_source_id: '../other',
    });
  });

  test('redacts native identity even when the inherited validator rejects first', () => {
    const err = validateNativeIntakeEnvelope(makeEnvelope({
      content: '',
      source_uri: 'private://sensitive-location',
      external_id: 'sensitive-external-id',
      idempotency_key: 'sensitive-retry-key',
      metadata: { secret: 'confidential metadata' },
    }));
    expect(err?.field).toBe('content');
    expect(err?.event).toEqual({
      api_version: NATIVE_INTAKE_API_VERSION,
      brain_id: 'host',
      source_id: 'test-source-1',
      target_source_id: 'research',
    });
  });
});

describe('deriveNativeIntakeIdempotencyKey', () => {
  test('derives a deterministic globally namespaced Minion key', () => {
    const envelope = makeEnvelope();
    const first = deriveNativeIntakeIdempotencyKey(envelope);
    expect(first).toBe(deriveNativeIntakeIdempotencyKey(envelope));
    expect(first).toBe(
      'native-intake:787011fe6373fed22b71b9536398c1a41a38a074856d2acda8bd67af04870821',
    );
    expect(first).not.toContain(envelope.idempotency_key);
  });

  test.each([
    { api_version: 'gbrain-native-intake-v2' },
    { brain_id: 'other-brain' },
    { target_source_id: 'inbox' },
    { source_id: 'birdclaw-2' },
    { external_id: 'bookmark-02j-example' },
    { idempotency_key: 'bookmark-01j-example:v2' },
  ])('changes when identity scope changes: %o', (override) => {
    expect(deriveNativeIntakeIdempotencyKey(
      makeEnvelope(override as Partial<NativeIntakeEnvelope>),
    )).not.toBe(
      deriveNativeIntakeIdempotencyKey(makeEnvelope()),
    );
  });
});

describe('computeContentHash', () => {
  test('produces a 64-char lowercase hex string', () => {
    const h = computeContentHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deterministic for the same input', () => {
    expect(computeContentHash('foo')).toBe(computeContentHash('foo'));
  });

  test('different inputs produce different hashes', () => {
    expect(computeContentHash('foo')).not.toBe(computeContentHash('bar'));
  });

  test('empty string is allowed and stable', () => {
    const h = computeContentHash('');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash('')).toBe(h);
  });
});

describe('validateIngestionEvent — happy path', () => {
  test('accepts a well-formed event', () => {
    expect(validateIngestionEvent(makeEvent())).toBeNull();
  });

  test('accepts events with optional metadata', () => {
    const ev = makeEvent({ metadata: { format: 'png', width: 1024 } });
    expect(validateIngestionEvent(ev)).toBeNull();
  });

  test('accepts events with untrusted_payload true', () => {
    expect(validateIngestionEvent(makeEvent({ untrusted_payload: true }))).toBeNull();
  });

  test('accepts events with untrusted_payload false', () => {
    expect(validateIngestionEvent(makeEvent({ untrusted_payload: false }))).toBeNull();
  });

  test('accepts every content_type in the taxonomy', () => {
    for (const ct of INGESTION_CONTENT_TYPES) {
      const ev = makeEvent({ content_type: ct });
      expect(validateIngestionEvent(ev)).toBeNull();
    }
  });
});

describe('validateIngestionEvent — rejection cases', () => {
  test('rejects null', () => {
    const err = validateIngestionEvent(null);
    expect(err).toBeInstanceOf(IngestionEventError);
    expect(err?.field).toBe('root');
  });

  test('rejects non-object', () => {
    const err = validateIngestionEvent('not an event');
    expect(err).toBeInstanceOf(IngestionEventError);
  });

  test.each([
    'source_id',
    'source_kind',
    'source_uri',
    'received_at',
    'content',
    'content_hash',
  ] as const)('rejects missing required field: %s', (field) => {
    const ev = makeEvent();
    delete (ev as unknown as Record<string, unknown>)[field];
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe(field);
  });

  test.each([
    'source_id',
    'source_kind',
    'source_uri',
    'received_at',
    'content',
    'content_hash',
  ] as const)('rejects empty string for required field: %s', (field) => {
    const ev = { ...makeEvent(), [field]: '' };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe(field);
  });

  test('rejects unknown content_type', () => {
    const ev = makeEvent({ content_type: 'application/x-malware' as never });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_type');
  });

  test('rejects malformed received_at (not parseable)', () => {
    const ev = makeEvent({ received_at: 'not a date' });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('received_at');
  });

  test('rejects malformed content_hash (too short)', () => {
    const ev = makeEvent({ content_hash: 'abc123' });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_hash');
  });

  test('rejects malformed content_hash (non-hex characters)', () => {
    const ev = makeEvent({ content_hash: 'Z'.repeat(64) });
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('content_hash');
  });

  test('rejects non-boolean untrusted_payload', () => {
    const ev = { ...makeEvent(), untrusted_payload: 'yes' };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('untrusted_payload');
  });

  test('rejects null metadata', () => {
    const ev = { ...makeEvent(), metadata: null };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('metadata');
  });

  test('rejects array metadata', () => {
    const ev = { ...makeEvent(), metadata: [1, 2, 3] };
    const err = validateIngestionEvent(ev);
    expect(err?.field).toBe('metadata');
  });
});

describe('IngestionEventError', () => {
  test('carries field, reason, and event payload', () => {
    const err = new IngestionEventError('content_hash', 'too short', { source_id: 'x' });
    expect(err.field).toBe('content_hash');
    expect(err.reason).toBe('too short');
    expect(err.event).toEqual({ source_id: 'x' });
    expect(err.message).toContain('content_hash');
    expect(err.name).toBe('IngestionEventError');
  });

  test('is an instance of Error', () => {
    const err = new IngestionEventError('source_id', 'missing', {});
    expect(err).toBeInstanceOf(Error);
  });
});
