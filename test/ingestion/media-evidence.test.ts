import { describe, expect, test } from 'bun:test';
import {
  MEDIA_EVIDENCE_API_VERSION,
  deriveMediaProcessorIdempotencyKey,
  isTerminalMediaAcquisition,
  validateMediaEvidence,
  type MediaEvidence,
  type MediaProcessorIdentity,
} from '../../src/core/ingestion/media-evidence.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SENSITIVE_URL = 'https://media.example/private/video.mp4?token=secret';
const SENSITIVE_EXTERNAL_ID = 'private-upstream-id-42';

function pending(overrides: Partial<MediaEvidence> = {}): MediaEvidence {
  return {
    api_version: MEDIA_EVIDENCE_API_VERSION,
    id: 'media-1',
    url: SENSITIVE_URL,
    kind: 'video',
    content_hash: null,
    owner: {
      brain_id: 'host',
      target_source_id: 'research',
    },
    provenance: {
      source_id: 'birdclaw',
      external_id: SENSITIVE_EXTERNAL_ID,
      source_uri: 'https://x.com/example/status/42',
    },
    acquisition: {
      status: 'pending',
      reason_code: null,
    },
    ...overrides,
  };
}

const processor: MediaProcessorIdentity = {
  processor_key: 'media.transcription',
  processor_version: '1',
  model_provider: 'nvidia',
  model_name: 'parakeet-tdt-0.6b-v2',
  model_version: '2026-07-23',
};

describe('normalized media evidence contract', () => {
  test('accepts pending evidence and recognizes every completed acquisition outcome', () => {
    expect(validateMediaEvidence(pending())).toBeNull();

    for (const status of ['no-audio', 'unavailable', 'unsupported'] as const) {
      const item = pending({
        acquisition: { status, reason_code: `${status.replace('-', '_')}_terminal` },
      });
      expect(validateMediaEvidence(item)).toBeNull();
      expect(isTerminalMediaAcquisition(item.acquisition)).toBe(true);
    }
    expect(isTerminalMediaAcquisition(pending().acquisition)).toBe(false);
    expect(isTerminalMediaAcquisition({
      status: 'acquired',
      reason_code: null,
    })).toBe(true);
  });

  test('accepts acquired evidence with transcript source and model provenance', () => {
    const item = pending({
      content_hash: SHA_A,
      acquisition: { status: 'acquired', reason_code: null },
      derived_from: {
        media_id: 'source-video-1',
        content_hash: SHA_B,
      },
      transcript: {
        source_kind: 'asr',
        media_id: 'media-1',
        media_content_hash: SHA_A,
        processor_key: processor.processor_key,
        processor_version: processor.processor_version,
        model_provider: processor.model_provider,
        model_name: processor.model_name,
        model_version: processor.model_version,
        transcript_content_hash: SHA_B,
        language: 'en',
        text: 'A bounded transcript.',
        segments: [{
          start_seconds: 0,
          end_seconds: 2.5,
          text: 'A bounded transcript.',
        }],
      },
    });

    expect(validateMediaEvidence(item)).toBeNull();
    expect(validateMediaEvidence({
      ...item,
      derived_from: { ...item.derived_from!, media_id: '' },
    })?.field).toBe('derived_from.media_id');
    expect(validateMediaEvidence({
      ...item,
      derived_from: {
        ...item.derived_from!,
        content_hash: SHA_B.toUpperCase(),
      },
    })?.field).toBe('derived_from.content_hash');
  });

  test('enforces hash and terminal acquisition invariants', () => {
    const withoutHash = pending() as unknown as Record<string, unknown>;
    delete withoutHash.content_hash;
    expect(validateMediaEvidence(withoutHash)?.field).toBe('content_hash');
    expect(validateMediaEvidence(pending({
      acquisition: { status: 'acquired', reason_code: null },
    }))?.field).toBe('content_hash');
    expect(validateMediaEvidence(pending({
      content_hash: SHA_A.toUpperCase(),
      acquisition: { status: 'acquired', reason_code: null },
    }))?.field).toBe('content_hash');
    expect(validateMediaEvidence(pending({
      content_hash: SHA_A,
    }))?.field).toBe('content_hash');
    expect(validateMediaEvidence(pending({
      acquisition: { status: 'unavailable', reason_code: null },
    }))?.field).toBe('acquisition.reason_code');
    expect(validateMediaEvidence(pending({
      acquisition: { status: 'unsupported', reason_code: 'Contains private URL https://secret' },
    }))?.field).toBe('acquisition.reason_code');
    expect(validateMediaEvidence(pending({
      kind: 'audio',
      acquisition: { status: 'no-audio', reason_code: 'no_audio_stream' },
    }))?.field).toBe('acquisition.status');
  });

  test('requires a bounded absolute HTTP(S) media URL without credentials', () => {
    expect(validateMediaEvidence(pending({
      url: 'ftp://media.example/video.mp4',
    }))?.field).toBe('url');
    expect(validateMediaEvidence(pending({
      url: 'https://user:password@media.example/video.mp4',
    }))?.field).toBe('url');
    expect(validateMediaEvidence(pending({
      url: '/relative/video.mp4',
    }))?.field).toBe('url');
  });

  test('requires transcript identity, source hash, processor, model, and bounded segments', () => {
    const valid = pending({
      content_hash: SHA_A,
      acquisition: { status: 'acquired', reason_code: null },
      transcript: {
        source_kind: 'platform-caption',
        media_id: 'media-1',
        media_content_hash: SHA_A,
        processor_key: processor.processor_key,
        processor_version: processor.processor_version,
        model_provider: processor.model_provider,
        model_name: processor.model_name,
        model_version: processor.model_version,
        transcript_content_hash: SHA_B,
        language: 'en',
        text: 'Transcript',
        segments: [],
      },
    });
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, media_id: 'other' },
    })?.field).toBe('transcript.media_id');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, media_content_hash: SHA_B },
    })?.field).toBe('transcript.media_content_hash');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, processor_key: '' },
    })?.field).toBe('transcript.processor_key');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, processor_version: 'v'.repeat(33) },
    })?.field).toBe('transcript.processor_version');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, model_version: 'invalid version' },
    })?.field).toBe('transcript.model_version');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, model_version: undefined },
    })?.field).toBe('transcript.model_version');
    expect(validateMediaEvidence({
      ...valid,
      transcript: { ...valid.transcript!, source_kind: 'unknown' },
    })?.field).toBe('transcript.source_kind');
    expect(validateMediaEvidence({
      ...valid,
      transcript: {
        ...valid.transcript!,
        segments: [{ start_seconds: 3, end_seconds: 2, text: 'invalid' }],
      },
    })?.field).toBe('transcript.segments[0]');

    const { segments: _segments, ...withoutSegments } = valid.transcript!;
    expect(validateMediaEvidence({
      ...valid,
      transcript: withoutSegments,
    })).toBeNull();

    expect(validateMediaEvidence({
      ...valid,
      transcript: {
        ...valid.transcript!,
        segments: Array.from({ length: 21 }, (_, index) => ({
          start_seconds: index,
          end_seconds: index + 1,
          text: 'x'.repeat(100_000),
        })),
      },
    })?.field).toBe('transcript.segments');
  });

  test('validation diagnostics never echo sensitive media URLs or external IDs', () => {
    const error = validateMediaEvidence(pending({
      api_version: 'wrong-version' as MediaEvidence['api_version'],
    }));
    expect(error).not.toBeNull();
    expect(String(error)).not.toContain(SENSITIVE_URL);
    expect(String(error)).not.toContain(SENSITIVE_EXTERNAL_ID);
    expect(JSON.stringify(error)).not.toContain(SENSITIVE_URL);
    expect(JSON.stringify(error)).not.toContain(SENSITIVE_EXTERNAL_ID);
  });
});

describe('media processor idempotency identity', () => {
  test('is stable, content-free, and changes across every processing-affecting field', () => {
    const base = pending({
      content_hash: SHA_A,
      acquisition: { status: 'acquired', reason_code: null },
    });
    const first = deriveMediaProcessorIdempotencyKey(base, processor);
    expect(first).toBe(deriveMediaProcessorIdempotencyKey(structuredClone(base), {
      ...processor,
    }));
    expect(first).toMatch(/^media-process:[a-f0-9]{64}$/);
    expect(first).not.toContain(SENSITIVE_URL);
    expect(first).not.toContain(SENSITIVE_EXTERNAL_ID);

    const variants: Array<[MediaEvidence, MediaProcessorIdentity]> = [
      [{ ...base, owner: { ...base.owner, brain_id: 'other' } }, processor],
      [{ ...base, owner: { ...base.owner, target_source_id: 'default' } }, processor],
      [{ ...base, provenance: { ...base.provenance, source_id: 'other-source' } }, processor],
      [{ ...base, provenance: { ...base.provenance, external_id: 'other-external' } }, processor],
      [{ ...base, content_hash: SHA_B }, processor],
      [base, { ...processor, processor_key: 'media.analysis' }],
      [base, { ...processor, processor_version: '2' }],
      [base, { ...processor, model_provider: 'openai' }],
      [base, { ...processor, model_name: 'whisper-1' }],
      [base, { ...processor, model_version: '2026-07-24' }],
    ];
    for (const [media, identity] of variants) {
      expect(deriveMediaProcessorIdempotencyKey(media, identity)).not.toBe(first);
    }
    expect(deriveMediaProcessorIdempotencyKey({
      ...base,
      url: 'https://media.example/rotated-signed-url.mp4?token=new',
    }, processor)).toBe(first);
    expect(deriveMediaProcessorIdempotencyKey({
      ...base,
      provenance: {
        ...base.provenance,
        source_uri: 'https://x.com/example/status/updated-location',
      },
    }, processor)).toBe(first);

    const pendingFirst = deriveMediaProcessorIdempotencyKey(pending(), processor);
    expect(deriveMediaProcessorIdempotencyKey(pending({
      url: 'https://media.example/other-pending.mp4',
    }), processor)).not.toBe(pendingFirst);

    const withTranscript: MediaEvidence = {
      ...base,
      transcript: {
        source_kind: 'asr',
        media_id: base.id,
        media_content_hash: SHA_A,
        ...processor,
        transcript_content_hash: SHA_B,
        language: 'en',
        text: 'Output is not part of processing identity.',
        segments: [],
      },
    };
    expect(deriveMediaProcessorIdempotencyKey(withTranscript, processor)).toBe(first);
    expect(deriveMediaProcessorIdempotencyKey({
      ...withTranscript,
      transcript: {
        ...withTranscript.transcript!,
        text: '',
        transcript_content_hash: 'not-a-hash',
        source_kind: 'invalid' as 'asr',
      },
    }, processor)).toBe(first);
  });
});
