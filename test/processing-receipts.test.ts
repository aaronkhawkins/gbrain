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
      outcome: 'failed',
      inputCount: 999,
      reasonCode: 'late_replay',
    });
    expect(replayFinish.outcome).toBe('completed');
    expect(replayFinish.input_count).toBe(2);

    const failedIdentity = { ...identity, inputFingerprint: 'b'.repeat(64) };
    await startProcessingReceipt(engine, failedIdentity);
    await finishProcessingReceipt(engine, {
      ...failedIdentity,
      outcome: 'failed',
      reasonCode: 'provider_timeout',
    });
    const retry = await startProcessingReceipt(engine, failedIdentity);
    expect(retry.outcome).toBe('running');
    expect(retry.attempt).toBe(2);
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
    await startProcessingReceipt(engine, identity);
    await expect(finishProcessingReceipt(engine, {
      ...identity,
      outcome: 'failed',
      reasonCode: 'raw error: secret',
    })).rejects.toThrow('invalid reason code');
  }, 30_000);

  test('exports bounded observer evidence and failure state', async () => {
    await registerProcessor(engine, {
      key: identity.processorKey,
      version: identity.processorVersion,
      cadenceSeconds: 3600,
      runbook: 'missed-work',
    });
    await startProcessingReceipt(engine, identity);
    await finishProcessingReceipt(engine, {
      ...identity,
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
});
