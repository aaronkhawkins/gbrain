import {
  deriveMediaProcessorIdempotencyKey,
  validateMediaEvidence,
  type MediaEvidence,
  type MediaProcessorIdentity,
  type MediaTranscriptEvidence,
} from '../../ingestion/media-evidence.ts';
import {
  MEDIA_TRANSCRIPTION_JOB_NAME,
  MediaTranscriptionTransportError,
  type MediaTranscriptionAttemptResult,
  type MediaTranscriptionCoveredRange,
  type MediaTranscriptionTransport,
} from '../../media-transcription-transport.ts';
import type { MediaTranscriptionJobData } from '../../media-transcription-submit.ts';
import { UnrecoverableError, type MinionHandler } from '../types.ts';

const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HARD_DEADLINE_GUARD_MS = 60 * 1000;
const REASON_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;

interface MediaTranscriptionHandlerOpts {
  attemptTimeoutMs?: number;
  hardDeadlineGuardMs?: number;
  now?: () => number;
}

function permanent(code: string): UnrecoverableError {
  return new UnrecoverableError(`media_transcription:${code}`);
}

function retryable(code: string): Error {
  return new Error(`media_transcription:${code}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameProcessor(
  transcript: MediaTranscriptEvidence,
  processor: MediaProcessorIdentity,
): boolean {
  return transcript.processor_key === processor.processor_key
    && transcript.processor_version === processor.processor_version
    && transcript.model_provider === processor.model_provider
    && transcript.model_name === processor.model_name
    && transcript.model_version === processor.model_version;
}

function parseJobData(value: unknown): MediaTranscriptionJobData {
  if (!isRecord(value)
    || value.schema_version !== 1
    || typeof value.source_id !== 'string'
    || !isRecord(value.media)
    || !isRecord(value.processor)) {
    throw permanent('invalid_job_data');
  }
  const media = value.media as unknown as MediaEvidence;
  const processor = value.processor as unknown as MediaProcessorIdentity;
  const validationError = validateMediaEvidence(media);
  if (validationError
    || media.kind !== 'audio'
    || media.acquisition.status !== 'acquired'
    || media.content_hash === null
    || media.transcript !== undefined
    || value.source_id !== media.owner.target_source_id) {
    throw permanent('invalid_job_data');
  }

  // The idempotency derivation is also the canonical processor validator.
  try {
    deriveMediaProcessorIdempotencyKey(media, processor);
  } catch {
    throw permanent('invalid_job_data');
  }

  return {
    schema_version: 1,
    source_id: value.source_id,
    media,
    processor,
  };
}

function validateCoveredRanges(
  value: unknown,
  transcript: MediaTranscriptEvidence,
): boolean {
  if (!Array.isArray(value) || value.length === 0
    || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    return false;
  }
  let previousEnd = -1;
  const ranges: MediaTranscriptionCoveredRange[] = [];
  for (const range of value) {
    if (
      !isRecord(range)
      || typeof range.start_seconds !== 'number'
      || !Number.isFinite(range.start_seconds)
      || range.start_seconds < 0
      || typeof range.end_seconds !== 'number'
      || !Number.isFinite(range.end_seconds)
      || range.end_seconds <= range.start_seconds
      || range.start_seconds < previousEnd
    ) {
      return false;
    }
    const startSeconds = range.start_seconds;
    const endSeconds = range.end_seconds;
    const overlapsSegment = transcript.segments.some((segment) =>
      segment.start_seconds < endSeconds
      && segment.end_seconds > startSeconds
    );
    if (!overlapsSegment) return false;
    ranges.push({
      start_seconds: startSeconds,
      end_seconds: endSeconds,
    });
    previousEnd = endSeconds;
  }
  return transcript.segments.every((segment) =>
    ranges.some((range) =>
      segment.start_seconds >= range.start_seconds
      && segment.end_seconds <= range.end_seconds
    )
  );
}

function validateTranscriptResult(
  result: Extract<MediaTranscriptionAttemptResult, { outcome: 'complete' | 'partial' }>,
  data: MediaTranscriptionJobData,
): void {
  const transcript = result.transcript;
  if (
    transcript.source_kind !== 'asr'
    || transcript.media_id !== data.media.id
    || transcript.media_content_hash !== data.media.content_hash
    || !sameProcessor(transcript, data.processor)
  ) {
    throw permanent('result_identity_mismatch');
  }
  const validationError = validateMediaEvidence({
    ...data.media,
    transcript,
  });
  if (validationError) {
    throw permanent('result_schema_invalid');
  }
  if (result.outcome === 'partial') {
    if (
      !Array.isArray(result.reason_codes)
      || result.reason_codes.length === 0
      || !result.reason_codes.every((code) => typeof code === 'string' && REASON_CODE_RE.test(code))
      || !validateCoveredRanges(result.covered_ranges, transcript)
    ) {
      throw permanent('result_schema_invalid');
    }
  }
}

function validateAttemptResult(
  result: unknown,
  data: MediaTranscriptionJobData,
): asserts result is MediaTranscriptionAttemptResult {
  if (!isRecord(result) || result.schema_version !== 1) {
    throw permanent('result_schema_invalid');
  }
  if (result.outcome === 'ignored') {
    if (result.reason_code !== 'no_meaningful_speech') {
      throw permanent('result_schema_invalid');
    }
    return;
  }
  if (result.outcome !== 'complete' && result.outcome !== 'partial') {
    throw permanent('result_schema_invalid');
  }
  if (!isRecord(result.transcript)) throw permanent('result_schema_invalid');
  validateTranscriptResult(
    result as unknown as Extract<
      MediaTranscriptionAttemptResult,
      { outcome: 'complete' | 'partial' }
    >,
    data,
  );
}

export function makeMediaTranscriptionHandler(
  transport: MediaTranscriptionTransport | undefined,
  opts: MediaTranscriptionHandlerOpts = {},
): MinionHandler {
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const hardDeadlineGuardMs = opts.hardDeadlineGuardMs ?? DEFAULT_HARD_DEADLINE_GUARD_MS;
  const now = opts.now ?? Date.now;

  return async (job) => {
    if (job.name !== MEDIA_TRANSCRIPTION_JOB_NAME) {
      throw permanent('invalid_job_name');
    }
    const data = parseJobData(job.data);
    if (!transport) throw permanent('transport_unconfigured');
    if (job.deadlineAtMs === null) throw permanent('missing_hard_deadline');

    const startedAt = now();
    const remainingBeforeGuard = job.deadlineAtMs - hardDeadlineGuardMs - startedAt;
    if (remainingBeforeGuard <= 0) {
      throw retryable('attempt_budget_exhausted');
    }
    const adapterBudgetMs = Math.min(attemptTimeoutMs, remainingBeforeGuard);
    const adapterDeadlineAtMs = startedAt + adapterBudgetMs;
    await job.updateProgress({
      phase: 'transcription_attempt',
      attempt: job.attempts_made + 1,
      max_attempts: 3,
      elapsed_ms: 0,
    });

    const attemptAbort = new AbortController();
    let adapterTimedOut = false;
    const abortFromJob = () => {
      if (!attemptAbort.signal.aborted) {
        attemptAbort.abort(job.signal.reason);
      }
    };
    if (job.signal.aborted) abortFromJob();
    else job.signal.addEventListener('abort', abortFromJob, { once: true });
    const timeout = setTimeout(() => {
      adapterTimedOut = true;
      if (!attemptAbort.signal.aborted) {
        attemptAbort.abort(new Error('media_transcription:attempt_timeout'));
      }
    }, adapterBudgetMs);

    try {
      const result = await transport.attempt({
        job_id: job.id,
        attempt: job.attempts_made + 1,
        media: data.media,
        processor: data.processor,
        deadline_at_ms: adapterDeadlineAtMs,
        signal: attemptAbort.signal,
      });
      if (adapterTimedOut) throw retryable('attempt_timeout');
      validateAttemptResult(result, data);
      await job.updateProgress({
        phase: 'transcription_complete',
        attempt: job.attempts_made + 1,
        outcome: result.outcome,
        elapsed_ms: Math.max(0, now() - startedAt),
      });
      return result;
    } catch (error) {
      if (job.signal.aborted) {
        throw retryable('cancelled');
      }
      if (adapterTimedOut) {
        throw retryable('attempt_timeout');
      }
      if (error instanceof UnrecoverableError) throw error;
      if (error instanceof MediaTranscriptionTransportError) {
        if (error.kind === 'permanent') throw permanent(error.code);
        if (error.kind === 'cancelled') throw permanent(error.code);
        throw retryable(error.code);
      }
      throw retryable('transport_failed');
    } finally {
      clearTimeout(timeout);
      job.signal.removeEventListener('abort', abortFromJob);
    }
  };
}
