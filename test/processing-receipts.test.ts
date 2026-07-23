import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  finishProcessingReceipt,
  listProcessingRegistrations,
  registerProcessor,
  startProcessingReceipt,
} from '../src/core/processing-receipts.ts';
import { collectProcessingReceiptEvidence } from '../src/core/observability/collectors/processing-receipt.ts';

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

const identity = {
  processorKey: 'fixture.expand',
  processorVersion: '1',
  scopeId: 's_0123456789abcdef',
  inputFingerprint: 'a'.repeat(64),
};

describe('generic processing receipts', () => {
  test('registers, completes, replays idempotently, and retries failures', async () => {
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: identity.processorVersion,
      cadenceSeconds: 3600,
      graceSeconds: 300,
      runbook: 'missed-work',
      repairJobName: 'noop',
    });
    expect(await listProcessingRegistrations(engine)).toHaveLength(1);

    const first = await startProcessingReceipt(engine, identity);
    expect(first.outcome).toBe('running');
    expect(first.attempt).toBe(1);
    const complete = await finishProcessingReceipt(engine, {
      ...identity,
      attemptToken: first.attempt_token,
      outcome: 'completed',
      inputCount: 2,
      outputCount: 1,
      backlogCount: 0,
      lineageKind: 'minion',
      lineageId: 'job:42',
    });
    expect(complete.outcome).toBe('completed');

    const replay = await startProcessingReceipt(engine, identity);
    expect(replay.id).toBe(first.id);
    expect(replay.outcome).toBe('completed');
    expect(replay.attempt).toBe(1);
    expect(String(replay.started_at)).toBe(String(complete.started_at));
    const replayFinish = await finishProcessingReceipt(engine, {
      ...identity,
      attemptToken: replay.attempt_token,
      outcome: 'failed',
      inputCount: 999,
      reasonCode: 'late_replay',
    });
    expect(replayFinish.outcome).toBe('completed');
    expect(replayFinish.input_count).toBe(2);

    const failedIdentity = { ...identity, inputFingerprint: 'b'.repeat(64) };
    const failed = await startProcessingReceipt(engine, failedIdentity);
    await finishProcessingReceipt(engine, {
      ...failedIdentity,
      attemptToken: failed.attempt_token,
      outcome: 'failed',
      reasonCode: 'provider_timeout',
    });
    const retry = await startProcessingReceipt(engine, failedIdentity);
    expect(retry.outcome).toBe('running');
    expect(retry.attempt).toBe(2);
    const archived = await engine.executeRaw<{ outcome: string }>(
      'SELECT outcome FROM processing_receipt_attempts WHERE receipt_id = $1 ORDER BY attempt',
      [retry.id],
    );
    expect(archived).toEqual([{ outcome: 'failed' }]);
    await expect(finishProcessingReceipt(engine, {
      ...failedIdentity,
      attemptToken: failed.attempt_token,
      outcome: 'completed',
    })).rejects.toThrow('attempt is missing or stale');
  }, 30_000);

  test('rejects content-like identities and unbounded result values', async () => {
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: identity.processorVersion,
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    await expect(startProcessingReceipt(engine, {
      ...identity,
      scopeId: 'https://private.example/path',
    })).rejects.toThrow('invalid scope id');
    const started = await startProcessingReceipt(engine, identity);
    await expect(finishProcessingReceipt(engine, {
      ...identity,
      attemptToken: started.attempt_token,
      outcome: 'failed',
      reasonCode: 'raw error: secret',
    })).rejects.toThrow('invalid reason code');
    await expect(startProcessingReceipt(engine, {
      ...identity,
      processorVersion: '2',
      inputFingerprint: 'c'.repeat(64),
    })).rejects.toThrow('registration/version is missing');
  }, 30_000);

  test('exports bounded observer evidence and failure state', async () => {
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: identity.processorVersion,
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    const started = await startProcessingReceipt(engine, identity);
    await finishProcessingReceipt(engine, {
      ...identity,
      attemptToken: started.attempt_token,
      outcome: 'failed',
      reasonCode: 'provider_timeout',
      backlogCount: 3,
    });
    const evidence = await collectProcessingReceiptEvidence([{
      key: 'processor.fixture.expand',
      kind: 'content_processor',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: 3600,
      grace_seconds: 300,
      evidence_adapter: 'processing_receipt',
      selector: identity.processorKey,
    }], engine, { now: new Date() });
    expect(evidence.get('processor.fixture.expand')).toEqual(expect.objectContaining({
      backlog_items: 3,
      recent_failures: 1,
      force_state: 'failed',
      force_reason: 'recent_failures',
    }));
  }, 30_000);

  test('partial completion satisfies cadence while remaining degraded', async () => {
    const partialIdentity = {
      processorKey: 'fixture.partial',
      processorVersion: '1',
      scopeId: 'default',
      inputFingerprint: 'd'.repeat(64),
    };
    await registerProcessor(engine, {
      key: partialIdentity.processorKey,
      version: partialIdentity.processorVersion,
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    const started = await startProcessingReceipt(engine, partialIdentity);
    await finishProcessingReceipt(engine, {
      ...partialIdentity,
      attemptToken: started.attempt_token,
      outcome: 'partial',
      reasonCode: 'recoverable_items',
    });

    const evidence = await collectProcessingReceiptEvidence([{
      key: 'processor.fixture.partial',
      kind: 'content_processor',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: 3600,
      grace_seconds: 300,
      evidence_adapter: 'processing_receipt',
      selector: partialIdentity.processorKey,
    }], engine, { now: new Date() });

    expect(evidence.get('processor.fixture.partial')).toEqual(expect.objectContaining({
      force_state: 'degraded',
      force_reason: 'recent_failures',
    }));
    expect(evidence.get('processor.fixture.partial')?.last_success_at).not.toBeNull();
  }, 30_000);

  test('does not attribute prior-version success to a newly registered version', async () => {
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: '1',
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    const started = await startProcessingReceipt(engine, identity);
    await finishProcessingReceipt(engine, {
      ...identity,
      attemptToken: started.attempt_token,
      outcome: 'completed',
    });
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: '2',
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    const evidence = await collectProcessingReceiptEvidence([{
      key: 'processor.fixture.expand',
      kind: 'content_processor',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: 3600,
      grace_seconds: 300,
      evidence_adapter: 'processing_receipt',
      selector: identity.processorKey,
      version: '2',
    }], engine, { now: new Date() });
    expect(evidence.get('processor.fixture.expand')).toEqual(expect.objectContaining({
      last_attempt_at: null,
      last_success_at: null,
      force_state: 'unknown',
    }));
  }, 30_000);
});
