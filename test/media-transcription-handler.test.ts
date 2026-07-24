import { describe, expect, test } from 'bun:test';
import {
  MEDIA_EVIDENCE_API_VERSION,
  type MediaEvidence,
  type MediaProcessorIdentity,
  type MediaTranscriptEvidence,
} from '../src/core/ingestion/media-evidence.ts';
import {
  MediaTranscriptionTransportError,
  type MediaTranscriptionAttempt,
  type MediaTranscriptionAttemptResult,
  type MediaTranscriptionTransport,
} from '../src/core/media-transcription-transport.ts';
import { makeMediaTranscriptionHandler } from '../src/core/minions/handlers/media-transcription.ts';
import { UnrecoverableError, type MinionJobContext } from '../src/core/minions/types.ts';

const SHA_A = 'a'.repeat(64);

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

const transcript: MediaTranscriptEvidence = {
  source_kind: 'asr',
  media_id: media.id,
  media_content_hash: SHA_A,
  transcript_content_hash: 'b'.repeat(64),
  language: 'en',
  text: 'A bounded transcript.',
  segments: [{
    start_seconds: 0,
    end_seconds: 2,
    text: 'A bounded transcript.',
  }],
  ...processor,
};

function context(overrides: Partial<MinionJobContext> = {}): MinionJobContext {
  return {
    id: 7,
    name: 'media_transcription',
    data: {
      schema_version: 1,
      source_id: 'research',
      media,
      processor,
    },
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 35 * 60 * 1000,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
    ...overrides,
  };
}

function transport(
  attempt: (input: MediaTranscriptionAttempt) => ReturnType<MediaTranscriptionTransport['attempt']>,
): MediaTranscriptionTransport {
  return { attempt };
}

describe('media transcription Minion handler', () => {
  const semanticResults: MediaTranscriptionAttemptResult[] = [
    { schema_version: 1, outcome: 'complete', transcript },
    {
      schema_version: 1,
      outcome: 'partial',
      transcript,
      reason_codes: ['source_truncated'],
      covered_ranges: [{ start_seconds: 0, end_seconds: 2 }],
    },
    { schema_version: 1, outcome: 'ignored', reason_code: 'no_meaningful_speech' },
  ];

  test.each(semanticResults)('returns semantic $outcome results and passes a bounded attempt', async (result) => {
    let captured: MediaTranscriptionAttempt | undefined;
    const handler = makeMediaTranscriptionHandler(transport(async (input) => {
      captured = input;
      return result;
    }));

    expect(await handler(context())).toEqual(result);
    expect(captured?.job_id).toBe(7);
    expect(captured?.attempt).toBe(1);
    expect(captured?.media).toEqual(media);
    expect(captured?.processor).toEqual(processor);
    expect(captured?.deadline_at_ms).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  test('maps retryable transport errors to sanitized ordinary errors', async () => {
    const handler = makeMediaTranscriptionHandler(transport(async () => {
      throw new MediaTranscriptionTransportError('remote_unreachable', 'transient');
    }));

    const error = await handler(context()).catch((caught: unknown) => caught) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('media_transcription:remote_unreachable');
  });

  test('maps permanent transport errors to sanitized UnrecoverableError', async () => {
    const handler = makeMediaTranscriptionHandler(transport(async () => {
      throw new MediaTranscriptionTransportError('model_mismatch', 'permanent');
    }));

    const error = await handler(context()).catch((caught: unknown) => caught) as Error;
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('media_transcription:model_mismatch');
  });

  test('never exposes unknown transport diagnostics', async () => {
    const handler = makeMediaTranscriptionHandler(transport(async () => {
      throw new Error('secret URL https://media.example/audio.wav?token=leak');
    }));

    const error = await handler(context()).catch((caught: unknown) => caught) as Error;
    expect(error.message).toBe('media_transcription:transport_failed');
    expect(error.message).not.toContain('token=leak');
  });

  test('rejects malformed payload and processor-mismatched output permanently', async () => {
    const neverCalled = transport(async () => {
      throw new Error('must not run');
    });
    const malformed = makeMediaTranscriptionHandler(neverCalled);
    await expect(malformed(context({
      data: { schema_version: 1, source_id: 'research', media: { ...media, kind: 'video' }, processor },
    }))).rejects.toBeInstanceOf(UnrecoverableError);

    const mismatch = makeMediaTranscriptionHandler(transport(async () => ({
      schema_version: 1,
      outcome: 'complete',
      transcript: { ...transcript, model_version: 'different' },
    })));
    await expect(mismatch(context())).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'media_transcription:result_identity_mismatch',
    });
  });

  test('rejects invalid result versions and partial coverage permanently', async () => {
    const cases: MediaTranscriptionAttemptResult[] = [
      {
        outcome: 'ignored',
        reason_code: 'no_meaningful_speech',
      } as unknown as MediaTranscriptionAttemptResult,
      {
        schema_version: 2 as 1,
        outcome: 'complete',
        transcript,
      },
      {
        schema_version: 1,
        outcome: 'partial',
        transcript,
        reason_codes: ['source_truncated'],
        covered_ranges: [{ start_seconds: 1, end_seconds: 1 }],
      },
      {
        schema_version: 1,
        outcome: 'partial',
        transcript,
        reason_codes: ['source_truncated'],
        covered_ranges: [
          { start_seconds: 1, end_seconds: 2 },
          { start_seconds: 0, end_seconds: 1 },
        ],
      },
      {
        schema_version: 1,
        outcome: 'partial',
        transcript,
        reason_codes: ['source_truncated'],
        covered_ranges: [{ start_seconds: 3, end_seconds: 4 }],
      },
    ];

    for (const result of cases) {
      const handler = makeMediaTranscriptionHandler(transport(async () => result));
      await expect(handler(context())).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message: 'media_transcription:result_schema_invalid',
      });
    }
  });

  test('aborts the attempt at the adapter deadline before the hard deadline', async () => {
    const handler = makeMediaTranscriptionHandler(
      transport((input) => new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      })),
      { attemptTimeoutMs: 5, hardDeadlineGuardMs: 5 },
    );

    const error = await handler(context({
      deadlineAtMs: Date.now() + 100,
    })).catch((caught: unknown) => caught) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('media_transcription:attempt_timeout');
  });
});
