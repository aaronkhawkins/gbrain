import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  getChatModel,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

async function waitForTerminal(
  queue: MinionQueue,
  jobId: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && ['completed', 'failed', 'dead', 'cancelled'].includes(job.status)) {
      return job;
    }
    await Bun.sleep(25);
  }
  throw new Error(`facts-absorb job ${jobId} did not become terminal`);
}

describe('durable facts Minion lifecycle', () => {
  test('a retryable provider interruption converges to one source-scoped result', async () => {
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('models.chat', 'openai:gpt-5');
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'stale-key', OPENAI_API_KEY: 'fresh-key' },
    });

    const sourceId = 'source-a';
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [sourceId],
    );
    const slug = 'meetings/durable-retry-example';
    const body = 'A substantive meeting note that should survive a retryable provider interruption. '.repeat(3);
    await engine.putPage(slug, {
      title: 'durable retry example',
      type: 'meeting',
      compiled_truth: body,
      timeline: '',
      frontmatter: {},
    }, { sourceId });

    let transportCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      transportCalls++;
      if (transportCalls === 1) throw new Error('temporary provider interruption');
      return {
        text: JSON.stringify({ facts: [{
          fact: 'The durable extraction completed after retry.',
          kind: 'event',
          entity: null,
          confidence: 1,
          notability: 'high',
        }] }),
        blocks: [],
        stopReason: 'end',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    const queue = new MinionQueue(engine);
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      pollInterval: 10,
      stalledInterval: 50,
    });
    await registerBuiltinHandlers(worker, engine, { quiet: true });

    const submitted = await runFactsBackstop({
      slug,
      type: 'meeting',
      compiled_truth: body,
      frontmatter: {},
    }, {
      engine,
      sourceId,
      sessionId: 'session-a',
      source: 'sync:import',
      mode: 'durable',
      notabilityFilter: 'high-only',
    });
    if (submitted.mode !== 'durable' || submitted.jobId === undefined) {
      throw new Error('durable facts job was not submitted');
    }

    const workerRun = worker.start();
    try {
      const terminal = await waitForTerminal(queue, submitted.jobId, 8_000);
      expect(terminal.status).toBe('completed');
      expect(transportCalls).toBeGreaterThanOrEqual(2);
      expect(getChatModel()).toBe('openai:gpt-5');

      const facts = await engine.listFactsBySession(sourceId, 'session-a');
      expect(facts.filter(
        (fact) => fact.fact === 'The durable extraction completed after retry.',
      )).toHaveLength(1);
      expect(facts[0]?.source_id).toBe(sourceId);
    } finally {
      worker.stop();
      await workerRun;
    }
  }, 15_000);
});
