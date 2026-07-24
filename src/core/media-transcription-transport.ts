import type {
  MediaEvidence,
  MediaProcessorIdentity,
  MediaTranscriptEvidence,
} from './ingestion/media-evidence.ts';

export const MEDIA_TRANSCRIPTION_JOB_NAME = 'media_transcription' as const;

export interface MediaTranscriptionAttempt {
  job_id: number;
  /** One-based attempt number presented to the transport for diagnostics only. */
  attempt: number;
  media: MediaEvidence;
  processor: MediaProcessorIdentity;
  /** Adapter deadline, always earlier than the Minion hard deadline. */
  deadline_at_ms: number;
  signal: AbortSignal;
}

export interface MediaTranscriptionCoveredRange {
  start_seconds: number;
  end_seconds: number;
}

export type MediaTranscriptionAttemptResult =
  | {
      schema_version: 1;
      outcome: 'complete';
      transcript: MediaTranscriptEvidence;
    }
  | {
      schema_version: 1;
      outcome: 'partial';
      transcript: MediaTranscriptEvidence;
      reason_codes: string[];
      covered_ranges: MediaTranscriptionCoveredRange[];
    }
  | {
      schema_version: 1;
      outcome: 'ignored';
      reason_code: 'no_meaningful_speech';
    };

/**
 * One attempt only. Implementations resolve the acquired media bytes from
 * trusted configuration; they do not scan queues, retry, or persist Minion
 * state.
 */
export interface MediaTranscriptionTransport {
  attempt(input: MediaTranscriptionAttempt): Promise<MediaTranscriptionAttemptResult>;
}

export type MediaTranscriptionTransportErrorKind =
  | 'transient'
  | 'permanent'
  | 'cancelled';

export const PERMANENT_MEDIA_TRANSCRIPTION_ERROR_CODES = [
  'invalid_request',
  'input_changed',
  'unsupported_processor',
  'invalid_result',
  'result_too_large',
  'invalid_runtime_config',
  'authentication_failed',
  'invalid_audio',
  'locator_invalid',
  'artifact_missing',
  'hash_mismatch',
  'audio_unsupported',
  'processor_mismatch',
  'runtime_mismatch',
  'runtime_identity_mismatch',
  'model_mismatch',
  'result_schema_invalid',
] as const;

export const TRANSIENT_MEDIA_TRANSCRIPTION_ERROR_CODES = [
  'remote_unreachable',
  'transfer_timeout',
  'remote_busy',
  'gpu_unavailable',
  'remote_execution_failed',
  'result_transfer_failed',
  'attempt_timeout',
  'deadline_exceeded',
  'runtime_failed',
  'transcription_failed',
  'transport_failed',
] as const;

export const CANCELLED_MEDIA_TRANSCRIPTION_ERROR_CODES = [
  'cancelled',
] as const;

export type MediaTranscriptionTransportErrorCode =
  | typeof PERMANENT_MEDIA_TRANSCRIPTION_ERROR_CODES[number]
  | typeof TRANSIENT_MEDIA_TRANSCRIPTION_ERROR_CODES[number]
  | typeof CANCELLED_MEDIA_TRANSCRIPTION_ERROR_CODES[number];

const PERMANENT_ERROR_CODE_SET = new Set<string>(
  PERMANENT_MEDIA_TRANSCRIPTION_ERROR_CODES,
);
const TRANSIENT_ERROR_CODE_SET = new Set<string>(
  TRANSIENT_MEDIA_TRANSCRIPTION_ERROR_CODES,
);
const CANCELLED_ERROR_CODE_SET = new Set<string>(
  CANCELLED_MEDIA_TRANSCRIPTION_ERROR_CODES,
);

function transportErrorMessage(
  code: MediaTranscriptionTransportErrorCode,
  kind: MediaTranscriptionTransportErrorKind,
): string {
  if (kind !== 'permanent' && kind !== 'transient' && kind !== 'cancelled') {
    throw new Error('invalid media transcription transport error classification');
  }
  const valid = kind === 'permanent'
    ? PERMANENT_ERROR_CODE_SET.has(code)
    : kind === 'transient'
      ? TRANSIENT_ERROR_CODE_SET.has(code)
      : CANCELLED_ERROR_CODE_SET.has(code);
  if (!valid) {
    throw new Error('invalid media transcription transport error classification');
  }
  return `media_transcription:${code}`;
}

/**
 * Convert the content-free error code emitted by the #39 Python CLI into this
 * boundary's retry taxonomy. Unknown values never cross the boundary.
 */
export function mediaTranscriptionErrorFromCliCode(
  code: unknown,
): MediaTranscriptionTransportError {
  if (typeof code === 'string' && PERMANENT_ERROR_CODE_SET.has(code)) {
    return new MediaTranscriptionTransportError(
      code as MediaTranscriptionTransportErrorCode,
      'permanent',
    );
  }
  if (typeof code === 'string' && TRANSIENT_ERROR_CODE_SET.has(code)) {
    return new MediaTranscriptionTransportError(
      code as MediaTranscriptionTransportErrorCode,
      'transient',
    );
  }
  if (typeof code === 'string' && CANCELLED_ERROR_CODE_SET.has(code)) {
    return new MediaTranscriptionTransportError('cancelled', 'cancelled');
  }
  return new MediaTranscriptionTransportError('transport_failed', 'transient');
}

/**
 * Transport errors carry a fixed, content-free message. Raw stderr, paths,
 * URLs, hashes, and transcript text must stay inside the transport boundary.
 */
export class MediaTranscriptionTransportError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: MediaTranscriptionTransportErrorCode,
    public readonly kind: MediaTranscriptionTransportErrorKind,
  ) {
    super(transportErrorMessage(code, kind));
    this.name = 'MediaTranscriptionTransportError';
    this.retryable = kind === 'transient';
  }
}
