import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  MEDIA_EVIDENCE_API_VERSION,
  type MediaEvidence,
  type MediaProcessorIdentity,
} from '../src/core/ingestion/media-evidence.ts';
import {
  MediaTranscriptionTransportError,
  type MediaTranscriptionTransport,
} from '../src/core/media-transcription-transport.ts';
import { makeMediaTranscriptionHandler } from '../src/core/minions/handlers/media-transcription.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

const processor: MediaProcessorIdentity = {
  processor_key: 'media.transcription',
  processor_version: '1',
  model_provider: 'nvidia',
  model_name: 'parakeet-tdt-0.6b-v2',
  model_version: 'ae9ad07059c7c739ffaf932226a8fe64ae2620b0',
};

function media(id: string): MediaEvidence {
  return {
    api_version: MEDIA_EVIDENCE_API_VERSION,
    id,
    url: `https://media.example/${id}.wav`,
    kind: 'audio',
    content_hash: SHA_A,
    owner: {
      brain_id: 'host',
      target_source_id: 'research',
    },
    provenance: {
      source_id: 'birdclaw',
      external_id: id,
      source_uri: `https://x.com/example/status/${id}`,
    },
    acquisition: {
      status: 'acquired',
      reason_code: null,
    },
  };
}

function jobData(item: MediaEvidence): Record<string, unknown> {
  return {
    schema_version: 1,
    source_id: item.owner.target_source_id,
    media: item,
    processor,
  };
}

test('real media transcription worker retries transient failure, completes, and dead-letters permanent failure', async () => {
  const attempts = new Map<string, number>();
  const transport: MediaTranscriptionTransport = {
    attempt: async (input) => {
      const count = (attempts.get(input.media.id) ?? 0) + 1;
      attempts.set(input.media.id, count);
      if (input.media.id === 'retry-audio' && count === 1) {
        throw new MediaTranscriptionTransportError('transport_failed', 'transient');
      }
      if (input.media.id === 'permanent-audio') {
        throw new MediaTranscriptionTransportError('invalid_runtime_config', 'permanent');
      }
      return {
        schema_version: 1,
        outcome: 'complete',
        transcript: {
          source_kind: 'asr',
          media_id: input.media.id,
          media_content_hash: input.media.content_hash!,
          transcript_content_hash: SHA_B,
          language: 'en',
          text: 'Versioned persisted transcript.',
          segments: [{
            start_seconds: 0,
            end_seconds: 2,
            text: 'Versioned persisted transcript.',
          }],
          ...input.processor,
        },
      };
    },
  };

  const retryJob = await queue.add(
    'media_transcription',
    jobData(media('retry-audio')),
    {
      max_attempts: 2,
      backoff_type: 'fixed',
      backoff_delay: 1,
      backoff_jitter: 0,
      timeout_ms: 5_000,
      remove_on_complete: false,
      remove_on_fail: false,
    },
    { allowProtectedSubmit: true },
  );
  const permanentJob = await queue.add(
    'media_transcription',
    jobData(media('permanent-audio')),
    {
      max_attempts: 3,
      backoff_type: 'fixed',
      backoff_delay: 1,
      backoff_jitter: 0,
      timeout_ms: 5_000,
      remove_on_complete: false,
      remove_on_fail: false,
    },
    { allowProtectedSubmit: true },
  );
  const worker = new MinionWorker(engine, {
    pollInterval: 5,
    stalledInterval: 60_000,
    healthCheckInterval: 0,
  });
  worker.register(
    'media_transcription',
    makeMediaTranscriptionHandler(transport, {
      attemptTimeoutMs: 1_000,
      hardDeadlineGuardMs: 10,
    }),
  );

  const running = worker.start();
  try {
    const expiresAt = Date.now() + 3_000;
    while (Date.now() < expiresAt) {
      const retry = await queue.getJob(retryJob.id);
      const permanent = await queue.getJob(permanentJob.id);
      if (retry?.status === 'completed' && permanent?.status === 'dead') break;
      await Bun.sleep(10);
    }
  } finally {
    worker.stop();
    await running;
  }

  const completed = await queue.getJob(retryJob.id);
  const dead = await queue.getJob(permanentJob.id);
  expect(completed).toMatchObject({
    status: 'completed',
    attempts_started: 2,
    attempts_made: 1,
  });
  expect(completed?.result).toMatchObject({
    schema_version: 1,
    outcome: 'complete',
    transcript: {
      media_id: 'retry-audio',
      text: 'Versioned persisted transcript.',
    },
  });
  expect(dead).toMatchObject({
    status: 'dead',
    attempts_made: 1,
    error_text: 'media_transcription:invalid_runtime_config',
  });
  expect(attempts.get('retry-audio')).toBe(2);
  expect(attempts.get('permanent-audio')).toBe(1);
}, 10_000);
