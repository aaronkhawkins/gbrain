import { describe, expect, test } from 'bun:test';
import {
  MEDIA_EVIDENCE_API_VERSION,
  type MediaEvidence,
  type MediaProcessorIdentity,
} from '../src/core/ingestion/media-evidence.ts';
import {
  mediaTranscriptionErrorFromCliCode,
  MediaTranscriptionTransportError,
  type MediaTranscriptionTransport,
  type MediaTranscriptionTransportErrorKind,
} from '../src/core/media-transcription-transport.ts';
import { makeMediaTranscriptionHandler } from '../src/core/minions/handlers/media-transcription.ts';
import { UnrecoverableError, type MinionJobContext } from '../src/core/minions/types.ts';

const SHA_A = 'a'.repeat(64);

const media: MediaEvidence = {
  api_version: MEDIA_EVIDENCE_API_VERSION,
  id: 'audio-1',
  url: 'https://media.example/audio.wav',
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

function context(signal = new AbortController().signal): MinionJobContext {
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
    signal,
    deadlineAtMs: Date.now() + 35 * 60 * 1000,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

const CURRENT_39_CLI_CODES = [
  ['invalid_request', 'permanent'],
  ['input_changed', 'permanent'],
  ['unsupported_processor', 'permanent'],
  ['invalid_result', 'permanent'],
  ['result_too_large', 'permanent'],
  ['invalid_runtime_config', 'permanent'],
  ['invalid_audio', 'permanent'],
  ['runtime_identity_mismatch', 'permanent'],
  ['deadline_exceeded', 'transient'],
  ['runtime_failed', 'transient'],
  ['transcription_failed', 'transient'],
  ['transport_failed', 'transient'],
  ['cancelled', 'cancelled'],
] as const satisfies ReadonlyArray<readonly [string, MediaTranscriptionTransportErrorKind]>;

describe('media transcription transport compatibility', () => {
  test.each(CURRENT_39_CLI_CODES)(
    'maps current #39 CLI code %s to %s',
    (code, kind) => {
      const error = mediaTranscriptionErrorFromCliCode(code);
      expect(error).toMatchObject({
        code,
        kind,
        retryable: kind === 'transient',
      });
    },
  );

  test('maps unknown diagnostics to a sanitized transient fallback', () => {
    const error = mediaTranscriptionErrorFromCliCode('private diagnostic token=secret');
    expect(error).toMatchObject({
      code: 'transport_failed',
      kind: 'transient',
      retryable: true,
    });
    expect(error.message).toBe('media_transcription:transport_failed');
    expect(error.message).not.toContain('token=secret');
  });

  test('treats an unexpected transport cancellation as terminal', async () => {
    const transport: MediaTranscriptionTransport = {
      attempt: async () => {
        throw new MediaTranscriptionTransportError('cancelled', 'cancelled');
      },
    };

    const error = await makeMediaTranscriptionHandler(transport)(context())
      .catch((caught: unknown) => caught) as Error;

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('media_transcription:cancelled');
  });

  test('preserves worker cancellation behavior when the job signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel'));
    const transport: MediaTranscriptionTransport = {
      attempt: async () => {
        throw new MediaTranscriptionTransportError('cancelled', 'cancelled');
      },
    };

    const error = await makeMediaTranscriptionHandler(transport)(context(controller.signal))
      .catch((caught: unknown) => caught) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('media_transcription:cancelled');
  });
});
