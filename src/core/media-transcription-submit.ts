import type { BrainEngine } from './engine.ts';
import {
  deriveMediaProcessorIdempotencyKey,
  validateMediaEvidence,
  type MediaEvidence,
  type MediaProcessorIdentity,
} from './ingestion/media-evidence.ts';
import type {
  MinionAddResult,
} from './minions/queue.ts';
import { MinionQueue } from './minions/queue.ts';
import type { MinionJobInput, MinionJobStatus } from './minions/types.ts';
import { MEDIA_TRANSCRIPTION_JOB_NAME } from './media-transcription-transport.ts';
import { assertActiveMediaTranscriptionSource } from './media-transcription-operations.ts';

export const MEDIA_TRANSCRIPTION_JOB_POLICY = {
  max_attempts: 3,
  backoff_type: 'exponential',
  backoff_delay: 5 * 60 * 1000,
  backoff_jitter: 0.2,
  timeout_ms: 35 * 60 * 1000,
} as const satisfies Partial<MinionJobInput>;

export interface MediaTranscriptionJobData {
  schema_version: 1;
  /** Observer correlation field. Mirrors media.owner.target_source_id. */
  source_id: string;
  media: MediaEvidence;
  processor: MediaProcessorIdentity;
}

export type MediaTranscriptionSubmissionErrorCode =
  | 'invalid_media'
  | 'media_not_acquired_audio'
  | 'already_transcribed'
  | 'invalid_processor'
  | 'idempotency_conflict';

export class MediaTranscriptionSubmissionError extends Error {
  constructor(public readonly code: MediaTranscriptionSubmissionErrorCode) {
    super(`media_transcription:${code}`);
    this.name = 'MediaTranscriptionSubmissionError';
  }
}

export interface MediaTranscriptionSubmissionResult {
  disposition: 'accepted' | 'duplicate';
  job_id: number;
  job_status: MinionJobStatus;
}

type MediaTranscriptionQueue = Pick<MinionQueue, 'addWithDisposition'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameProcessor(
  actual: unknown,
  expected: MediaProcessorIdentity,
): boolean {
  if (!isRecord(actual)) return false;
  return actual.processor_key === expected.processor_key
    && actual.processor_version === expected.processor_version
    && actual.model_provider === expected.model_provider
    && actual.model_name === expected.model_name
    && actual.model_version === expected.model_version;
}

function sameDurableIdentity(
  queued: MinionAddResult['job'],
  media: MediaEvidence,
  processor: MediaProcessorIdentity,
  expectedIdempotencyKey: string,
): boolean {
  if (queued.name !== MEDIA_TRANSCRIPTION_JOB_NAME || !isRecord(queued.data)) {
    return false;
  }
  const queuedMedia = queued.data.media;
  if (queued.data.schema_version !== 1
    || queued.data.source_id !== media.owner.target_source_id
    || !isRecord(queuedMedia)
    || !sameProcessor(queued.data.processor, processor)
    || queued.idempotency_key !== expectedIdempotencyKey) {
    return false;
  }
  try {
    return deriveMediaProcessorIdempotencyKey(
      queuedMedia as unknown as MediaEvidence,
      queued.data.processor as unknown as MediaProcessorIdentity,
    ) === expectedIdempotencyKey;
  } catch {
    return false;
  }
}

/**
 * Queue one acquired audio item for exactly one processor/model identity.
 *
 * This is intentionally a root-job API: callers cannot supply parent linkage
 * or override retry/deadline/removal policy.
 */
export async function submitMediaTranscription(
  engine: BrainEngine,
  mediaInput: unknown,
  processorInput: unknown,
  deps: { queue?: MediaTranscriptionQueue } = {},
): Promise<MediaTranscriptionSubmissionResult> {
  const validationError = validateMediaEvidence(mediaInput);
  if (validationError) {
    throw new MediaTranscriptionSubmissionError('invalid_media');
  }
  const media = mediaInput as MediaEvidence;
  if (
    media.kind !== 'audio'
    || media.acquisition.status !== 'acquired'
    || media.content_hash === null
  ) {
    throw new MediaTranscriptionSubmissionError('media_not_acquired_audio');
  }
  if (media.transcript !== undefined) {
    throw new MediaTranscriptionSubmissionError('already_transcribed');
  }
  await assertActiveMediaTranscriptionSource(engine, media.owner.target_source_id);

  let idempotencyKey: string;
  try {
    idempotencyKey = deriveMediaProcessorIdempotencyKey(
      media,
      processorInput as MediaProcessorIdentity,
    );
  } catch {
    throw new MediaTranscriptionSubmissionError('invalid_processor');
  }
  const processor = processorInput as MediaProcessorIdentity;
  const data: MediaTranscriptionJobData = {
    schema_version: 1,
    source_id: media.owner.target_source_id,
    media,
    processor,
  };
  const queue = deps.queue ?? new MinionQueue(engine);

  const queued = await queue.addWithDisposition(
    MEDIA_TRANSCRIPTION_JOB_NAME,
    data as unknown as Record<string, unknown>,
    {
      ...MEDIA_TRANSCRIPTION_JOB_POLICY,
      idempotency_key: idempotencyKey,
      remove_on_complete: false,
      remove_on_fail: false,
    },
    { allowProtectedSubmit: true },
  );

  if (queued.disposition === 'coalesced') {
    throw new MediaTranscriptionSubmissionError('idempotency_conflict');
  }
  if (
    queued.disposition === 'duplicate'
    && !sameDurableIdentity(queued.job, media, processor, idempotencyKey)
  ) {
    throw new MediaTranscriptionSubmissionError('idempotency_conflict');
  }

  return {
    disposition: queued.disposition === 'inserted' ? 'accepted' : 'duplicate',
    job_id: queued.job.id,
    job_status: queued.job.status,
  };
}
