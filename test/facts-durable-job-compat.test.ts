import { describe, expect, test } from 'bun:test';
import {
  FACTS_ABSORB_JOB_SCHEMA_VERSION,
  factsContentHash,
  parseFactsAbsorbJobData,
  type FactsAbsorbJobData,
} from '../src/core/facts/durable-job.ts';

const LEGACY_FACTS_ABSORB_PAYLOAD = Object.freeze({
  slug: 'meetings/compatibility-example',
  sourceId: 'source-a',
  sessionId: 'session-a',
  source: 'sync:import',
  notabilityFilter: 'high-only',
});

const VERSIONED_FACTS_ABSORB_PAYLOAD: FactsAbsorbJobData = Object.freeze({
  schema_version: FACTS_ABSORB_JOB_SCHEMA_VERSION,
  slug: 'meetings/compatibility-example',
  sourceId: 'source-a',
  sessionId: 'session-a',
  source: 'sync:import',
  notabilityFilter: 'high-only',
  contentHash: factsContentHash('versioned compatibility fixture'),
});

/**
 * Models the fields consumed by the pre-versioned handler. Extra JSON keys are
 * ignored by that implementation, which is what makes a v1 row safe to drain
 * after rolling code back.
 */
function legacyHandlerView(data: Record<string, unknown>) {
  return {
    slug: typeof data.slug === 'string' ? data.slug : '',
    sourceId: typeof data.sourceId === 'string' ? data.sourceId : 'default',
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
    source: typeof data.source === 'string' ? data.source : 'mcp:put_page',
    notabilityFilter: data.notabilityFilter === 'high-only' ? 'high-only' : 'all',
  };
}

describe('facts-absorb durable payload compatibility', () => {
  test('new handler accepts a queued pre-version payload with safe defaults', () => {
    expect(parseFactsAbsorbJobData(LEGACY_FACTS_ABSORB_PAYLOAD)).toEqual({
      schema_version: 1,
      ...LEGACY_FACTS_ABSORB_PAYLOAD,
      contentHash: '',
    });
  });

  test('current v1 payload remains readable by the rollback handler', () => {
    expect(legacyHandlerView(VERSIONED_FACTS_ABSORB_PAYLOAD)).toEqual(
      legacyHandlerView(LEGACY_FACTS_ABSORB_PAYLOAD),
    );
  });

  test('future payload versions fail closed instead of being misinterpreted', () => {
    expect(() => parseFactsAbsorbJobData({
      ...VERSIONED_FACTS_ABSORB_PAYLOAD,
      schema_version: 2,
    })).toThrow('unsupported payload schema_version 2');
  });
});
