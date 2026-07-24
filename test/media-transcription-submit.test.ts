import { describe, expect, test } from 'bun:test';
import type { MinionJob, MinionJobInput } from '../src/core/minions/types.ts';
import {
  MEDIA_TRANSCRIPTION_JOB_POLICY,
  MediaTranscriptionSubmissionError,
  submitMediaTranscription,
} from '../src/core/media-transcription-submit.ts';
import {
  MEDIA_EVIDENCE_API_VERSION,
  type MediaEvidence,
  type MediaProcessorIdentity,
} from '../src/core/ingestion/media-evidence.ts';
import { isProtectedJobName } from '../src/core/minions/protected-names.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SHA_A = 'a'.repeat(64);
const activeEngine = {
  executeRaw: async () => [{
    id: 'research',
    name: 'Research',
    local_path: null,
    last_commit: null,
    last_sync_at: null,
    config: {},
    created_at: new Date(),
    archived: false,
  }],
} as unknown as BrainEngine;

const media: MediaEvidence = {
  api_version: MEDIA_EVIDENCE_API_VERSION,
  id: 'audio-1',
  url: 'https://media.example/audio.wav?token=sensitive',
  kind: 'audio',
  content_hash: SHA_A,
  owner: {
    brain_id: 'host',
    target_source_id: 'research',
  },
  provenance: {
    source_id: 'birdclaw',
    external_id: 'video-1',
    source_uri: 'https://x.com/example/status/1',
  },
  acquisition: {
    status: 'acquired',
    reason_code: null,
  },
};

const processor: MediaProcessorIdentity = {
  processor_key: 'media.transcription',
  processor_version: '1',
  model_provider: 'nvidia',
  model_name: 'parakeet-tdt-0.6b-v2',
  model_version: 'ae9ad07059c7c739ffaf932226a8fe64ae2620b0',
};

function job(data: Record<string, unknown>, opts: Partial<MinionJobInput>): MinionJob {
  return {
    id: 42,
    name: 'media_transcription',
    queue: opts.queue ?? 'default',
    status: 'waiting',
    priority: opts.priority ?? 0,
    data,
    max_attempts: opts.max_attempts ?? 3,
    attempts_made: 0,
    attempts_started: 0,
    backoff_type: opts.backoff_type ?? 'exponential',
    backoff_delay: opts.backoff_delay ?? 1000,
    backoff_jitter: opts.backoff_jitter ?? 0.2,
    stalled_counter: 0,
    max_stalled: 5,
    lock_token: null,
    lock_until: null,
    delay_until: null,
    parent_job_id: opts.parent_job_id ?? null,
    on_child_fail: opts.on_child_fail ?? 'fail_parent',
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    depth: 0,
    max_children: null,
    timeout_ms: opts.timeout_ms ?? null,
    timeout_at: null,
    remove_on_complete: opts.remove_on_complete ?? false,
    remove_on_fail: opts.remove_on_fail ?? false,
    idempotency_key: opts.idempotency_key ?? null,
    quiet_hours: null,
    stagger_key: null,
    result: null,
    progress: null,
    error_text: null,
    stacktrace: [],
    created_at: new Date(),
    started_at: null,
    finished_at: null,
    updated_at: new Date(),
  };
}

describe('submitMediaTranscription', () => {
  test('uses a protected job name', () => {
    expect(isProtectedJobName('media_transcription')).toBe(true);
  });

  test('submits one protected root job with durable retry and idempotency policy', async () => {
    let captured: {
      name: string;
      data: Record<string, unknown>;
      opts: Partial<MinionJobInput>;
      trusted: { allowProtectedSubmit?: boolean } | undefined;
    } | undefined;
    const queue = {
      addWithDisposition: async (
        name: string,
        data: Record<string, unknown>,
        opts: Partial<MinionJobInput>,
        trusted?: { allowProtectedSubmit?: boolean },
      ) => {
        captured = { name, data, opts, trusted };
        return { job: job(data, opts), disposition: 'inserted' as const };
      },
    };

    const result = await submitMediaTranscription(
      activeEngine,
      media,
      processor,
      { queue },
    );

    expect(result.disposition).toBe('accepted');
    expect(captured?.name).toBe('media_transcription');
    expect(captured?.data).toEqual({
      schema_version: 1,
      source_id: 'research',
      media,
      processor,
    });
    expect(captured?.opts).toEqual({
      ...MEDIA_TRANSCRIPTION_JOB_POLICY,
      idempotency_key: expect.stringMatching(/^media-process:[a-f0-9]{64}$/),
      remove_on_complete: false,
      remove_on_fail: false,
    });
    expect(captured?.opts.parent_job_id).toBeUndefined();
    expect(captured?.trusted).toEqual({ allowProtectedSubmit: true });
  });

  test('same acquired audio and processor replay returns the existing job', async () => {
    const data = {
      schema_version: 1,
      source_id: 'research',
      media,
      processor,
    };
    const queue = {
      addWithDisposition: async (
        _name: string,
        _data: Record<string, unknown>,
        opts: Partial<MinionJobInput>,
      ) => ({
        job: job(data, opts),
        disposition: 'duplicate' as const,
      }),
    };

    const result = await submitMediaTranscription(
      activeEngine,
      structuredClone(media),
      { ...processor },
      { queue },
    );

    expect(result).toEqual({
      disposition: 'duplicate',
      job_id: 42,
      job_status: 'waiting',
    });
  });

  test('rejects non-audio, non-acquired, and already-transcribed media', async () => {
    const queue = {
      addWithDisposition: async () => {
        throw new Error('must not submit');
      },
    };

    for (const candidate of [
      { ...media, kind: 'video' as const },
      {
        ...media,
        content_hash: null,
        acquisition: { status: 'pending' as const, reason_code: null },
      },
      {
        ...media,
        transcript: {
          schema_version: 1,
          source_kind: 'asr' as const,
          media_id: media.id,
          media_content_hash: SHA_A,
          transcript_content_hash: 'b'.repeat(64),
          language: 'en',
          text: 'Already transcribed.',
          ...processor,
        },
      },
    ]) {
      await expect(submitMediaTranscription(
        activeEngine,
        candidate,
        processor,
        { queue: queue as never },
      )).rejects.toBeInstanceOf(MediaTranscriptionSubmissionError);
    }
  });

  test('rejects a duplicate whose durable payload does not match', async () => {
    const queue = {
      addWithDisposition: async (
        _name: string,
        _data: Record<string, unknown>,
        opts: Partial<MinionJobInput>,
      ) => ({
        job: job({
          schema_version: 1,
          source_id: 'other',
          media,
          processor,
        }, opts),
        disposition: 'duplicate' as const,
      }),
    };

    await expect(submitMediaTranscription(
      activeEngine,
      media,
      processor,
      { queue },
    )).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('rejects trusted submission when the owning source is not active', async () => {
    let queueCalled = false;
    const archivedEngine = {
      executeRaw: async () => [{
        id: 'research',
        name: 'Research',
        local_path: null,
        last_commit: null,
        last_sync_at: null,
        config: {},
        created_at: new Date(),
        archived: true,
      }],
    } as unknown as BrainEngine;

    await expect(submitMediaTranscription(
      archivedEngine,
      media,
      processor,
      {
        queue: {
          addWithDisposition: async () => {
            queueCalled = true;
            throw new Error('must not enqueue');
          },
        },
      },
    )).rejects.toThrow(/archived/i);
    expect(queueCalled).toBe(false);
  });
});
