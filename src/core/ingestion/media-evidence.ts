/**
 * Pure, versioned contract for media acquisition and transcript evidence.
 *
 * This module deliberately has no persistence or queue dependencies. In
 * particular, validation errors retain only a field name and a content-free
 * reason so signed URLs, upstream identifiers, hashes, and transcript text are
 * never copied into diagnostics.
 */

import { createHash } from 'node:crypto';
import { isValidSourceId } from '../source-id.ts';

export const MEDIA_EVIDENCE_API_VERSION = 'gbrain-media-evidence-v1' as const;

export const MEDIA_KINDS = ['audio', 'video'] as const;
export type MediaKind = typeof MEDIA_KINDS[number];

export const MEDIA_ACQUISITION_STATUSES = [
  'pending',
  'acquired',
  'no-audio',
  'unavailable',
  'unsupported',
] as const;
export type MediaAcquisitionStatus = typeof MEDIA_ACQUISITION_STATUSES[number];

export const TERMINAL_MEDIA_ACQUISITION_STATUSES = [
  'acquired',
  'no-audio',
  'unavailable',
  'unsupported',
] as const;
export type TerminalMediaAcquisitionStatus =
  typeof TERMINAL_MEDIA_ACQUISITION_STATUSES[number];

export interface MediaEvidenceOwner {
  brain_id: string;
  target_source_id: string;
}

export interface MediaEvidenceProvenance {
  source_id: string;
  external_id: string;
  source_uri: string;
}

export interface MediaEvidenceDerivation {
  media_id: string;
  content_hash: string;
}

export interface MediaAcquisition {
  status: MediaAcquisitionStatus;
  reason_code: string | null;
}

export interface MediaProcessorIdentity {
  processor_key: string;
  processor_version: string;
  model_provider: string;
  model_name: string;
  model_version: string;
}

export const MEDIA_TRANSCRIPT_SOURCE_KINDS = [
  'platform-caption',
  'asr',
] as const;
export type MediaTranscriptSourceKind =
  typeof MEDIA_TRANSCRIPT_SOURCE_KINDS[number];

export interface MediaTranscriptSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
  speaker?: string;
}

export interface MediaTranscriptEvidence extends MediaProcessorIdentity {
  source_kind: MediaTranscriptSourceKind;
  media_id: string;
  media_content_hash: string;
  transcript_content_hash: string;
  language: string;
  text: string;
  segments?: MediaTranscriptSegment[];
}

export interface MediaEvidence {
  api_version: typeof MEDIA_EVIDENCE_API_VERSION;
  id: string;
  url: string;
  kind: MediaKind;
  /** Lowercase SHA-256 of the media bytes represented by this evidence. */
  content_hash: string | null;
  owner: MediaEvidenceOwner;
  provenance: MediaEvidenceProvenance;
  /** Immediate parent media when these bytes were derived from another item. */
  derived_from?: MediaEvidenceDerivation;
  acquisition: MediaAcquisition;
  transcript?: MediaTranscriptEvidence;
}

export class MediaEvidenceValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`MediaEvidence.${field}: ${reason}`);
    this.name = 'MediaEvidenceValidationError';
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const REASON_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const PROCESSOR_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PROCESSOR_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MODEL_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const LANGUAGE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const CONTENT_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const MAX_MEDIA_ID_LENGTH = 256;
const MAX_MEDIA_URL_LENGTH = 8192;
const MAX_EXTERNAL_ID_LENGTH = 512;
const MAX_SOURCE_URI_LENGTH = 4096;
const MAX_MODEL_NAME_LENGTH = 256;
const MAX_TRANSCRIPT_TEXT_LENGTH = 2_000_000;
const MAX_TRANSCRIPT_SEGMENTS = 100_000;
const MAX_SEGMENT_TEXT_LENGTH = 100_000;
const MAX_SPEAKER_LENGTH = 256;
const MAX_TOTAL_SEGMENT_CONTENT_LENGTH = 2_000_000;

function error(field: string, reason: string): MediaEvidenceValidationError {
  return new MediaEvidenceValidationError(field, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
    && !CONTROL_CHAR_RE.test(value);
}

function validateHttpUrl(value: unknown): boolean {
  if (!isBoundedText(value, MAX_MEDIA_URL_LENGTH)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function isBoundedContentText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && !CONTENT_CONTROL_CHAR_RE.test(value);
}

function validateProcessorIdentity(
  value: Record<string, unknown>,
  prefix: string,
): MediaEvidenceValidationError | null {
  if (typeof value.processor_key !== 'string'
    || !PROCESSOR_KEY_RE.test(value.processor_key)) {
    return error(`${prefix}processor_key`, 'must be a bounded processor key');
  }
  if (typeof value.processor_version !== 'string'
    || !PROCESSOR_VERSION_RE.test(value.processor_version)) {
    return error(`${prefix}processor_version`, 'must be a bounded processor version');
  }
  if (typeof value.model_provider !== 'string'
    || !MODEL_PROVIDER_RE.test(value.model_provider)) {
    return error(`${prefix}model_provider`, 'must be a bounded model provider');
  }
  if (!isBoundedText(value.model_name, MAX_MODEL_NAME_LENGTH)) {
    return error(`${prefix}model_name`, 'must be a bounded model name');
  }
  if (typeof value.model_version !== 'string'
    || !MODEL_VERSION_RE.test(value.model_version)) {
    return error(`${prefix}model_version`, 'must be a bounded model version');
  }
  return null;
}

function validateTranscript(
  value: unknown,
  mediaId: string,
  mediaContentHash: string,
): MediaEvidenceValidationError | null {
  if (!isRecord(value)) {
    return error('transcript', 'must be an object');
  }
  if (!(MEDIA_TRANSCRIPT_SOURCE_KINDS as readonly unknown[])
    .includes(value.source_kind)) {
    return error('transcript.source_kind', 'must be a supported transcript source kind');
  }
  if (value.media_id !== mediaId) {
    return error('transcript.media_id', 'must identify the containing media evidence');
  }
  if (value.media_content_hash !== mediaContentHash) {
    return error(
      'transcript.media_content_hash',
      'must match the acquired media content hash',
    );
  }

  const processorError = validateProcessorIdentity(value, 'transcript.');
  if (processorError) return processorError;

  if (typeof value.transcript_content_hash !== 'string'
    || !SHA256_RE.test(value.transcript_content_hash)) {
    return error(
      'transcript.transcript_content_hash',
      'must be a lowercase SHA-256 digest',
    );
  }
  if (typeof value.language !== 'string' || !LANGUAGE_RE.test(value.language)) {
    return error('transcript.language', 'must be a bounded language tag');
  }
  if (!isBoundedContentText(value.text, MAX_TRANSCRIPT_TEXT_LENGTH)) {
    return error('transcript.text', 'must be bounded text');
  }
  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments)
      || value.segments.length > MAX_TRANSCRIPT_SEGMENTS) {
      return error('transcript.segments', 'must be a bounded segment array');
    }

    let totalSegmentContentLength = 0;
    for (let index = 0; index < value.segments.length; index += 1) {
      const segment = value.segments[index];
      if (!isRecord(segment)
        || typeof segment.start_seconds !== 'number'
        || !Number.isFinite(segment.start_seconds)
        || segment.start_seconds < 0
        || typeof segment.end_seconds !== 'number'
        || !Number.isFinite(segment.end_seconds)
        || segment.end_seconds < segment.start_seconds
        || !isBoundedContentText(segment.text, MAX_SEGMENT_TEXT_LENGTH)
        || (segment.speaker !== undefined
          && !isBoundedText(segment.speaker, MAX_SPEAKER_LENGTH))) {
        return error(
          `transcript.segments[${index}]`,
          'must contain valid bounds and bounded text',
        );
      }
      totalSegmentContentLength += segment.text.length
        + (typeof segment.speaker === 'string' ? segment.speaker.length : 0);
      if (totalSegmentContentLength > MAX_TOTAL_SEGMENT_CONTENT_LENGTH) {
        return error(
          'transcript.segments',
          'must have bounded aggregate text and speaker content',
        );
      }
    }
  }
  return null;
}

function validateMediaProcessingInput(
  value: unknown,
): MediaEvidenceValidationError | null {
  if (!isRecord(value)) return error('root', 'must be an object');
  if (value.api_version !== MEDIA_EVIDENCE_API_VERSION) {
    return error('api_version', 'must be the supported media evidence version');
  }
  if (!isBoundedText(value.id, MAX_MEDIA_ID_LENGTH)) {
    return error('id', 'must be a bounded media identifier');
  }
  if (!validateHttpUrl(value.url)) {
    return error(
      'url',
      'must be a bounded absolute HTTP(S) URL without credentials',
    );
  }
  if (!(MEDIA_KINDS as readonly unknown[]).includes(value.kind)) {
    return error('kind', 'must be a supported media kind');
  }
  if (!Object.hasOwn(value, 'content_hash')) {
    return error('content_hash', 'must be explicitly present');
  }

  if (!isRecord(value.owner)) return error('owner', 'must be an object');
  if (!isValidSourceId(value.owner.brain_id)) {
    return error('owner.brain_id', 'must be a valid source identifier');
  }
  if (!isValidSourceId(value.owner.target_source_id)) {
    return error('owner.target_source_id', 'must be a valid source identifier');
  }

  if (!isRecord(value.provenance)) {
    return error('provenance', 'must be an object');
  }
  if (!isValidSourceId(value.provenance.source_id)) {
    return error('provenance.source_id', 'must be a valid source identifier');
  }
  if (!isBoundedText(value.provenance.external_id, MAX_EXTERNAL_ID_LENGTH)) {
    return error('provenance.external_id', 'must be a bounded external identifier');
  }
  if (!isBoundedText(value.provenance.source_uri, MAX_SOURCE_URI_LENGTH)) {
    return error('provenance.source_uri', 'must be a bounded source URI');
  }

  if (value.derived_from !== undefined) {
    if (!isRecord(value.derived_from)) {
      return error('derived_from', 'must be an object when present');
    }
    if (!isBoundedText(value.derived_from.media_id, MAX_MEDIA_ID_LENGTH)) {
      return error('derived_from.media_id', 'must be a bounded media identifier');
    }
    if (typeof value.derived_from.content_hash !== 'string'
      || !SHA256_RE.test(value.derived_from.content_hash)) {
      return error(
        'derived_from.content_hash',
        'must be a lowercase SHA-256 digest',
      );
    }
  }

  if (!isRecord(value.acquisition)) {
    return error('acquisition', 'must be an object');
  }
  if (!(MEDIA_ACQUISITION_STATUSES as readonly unknown[])
    .includes(value.acquisition.status)) {
    return error('acquisition.status', 'must be a supported acquisition status');
  }

  const status = value.acquisition.status as MediaAcquisitionStatus;
  if (status === 'acquired') {
    if (typeof value.content_hash !== 'string'
      || !SHA256_RE.test(value.content_hash)) {
      return error('content_hash', 'must be a lowercase SHA-256 digest when acquired');
    }
    if (value.acquisition.reason_code !== null) {
      return error('acquisition.reason_code', 'must be null when acquired');
    }
  } else {
    if (value.content_hash !== null) {
      return error('content_hash', 'must be null unless acquired');
    }
    if (status === 'pending') {
      if (value.acquisition.reason_code !== null) {
        return error('acquisition.reason_code', 'must be null while pending');
      }
    } else if (typeof value.acquisition.reason_code !== 'string'
      || !REASON_CODE_RE.test(value.acquisition.reason_code)) {
      return error(
        'acquisition.reason_code',
        'must be a bounded content-free reason code for terminal outcomes',
      );
    }
  }

  if (status === 'no-audio' && value.kind !== 'video') {
    return error('acquisition.status', 'no-audio applies only to video media');
  }

  return null;
}

/**
 * Validate unknown input without retaining or echoing any content from it.
 */
export function validateMediaEvidence(
  value: unknown,
): MediaEvidenceValidationError | null {
  const inputError = validateMediaProcessingInput(value);
  if (inputError) return inputError;

  const media = value as Record<string, unknown>;
  if (media.transcript !== undefined) {
    const acquisition = media.acquisition as Record<string, unknown>;
    if (acquisition.status !== 'acquired' || typeof media.content_hash !== 'string') {
      return error('transcript', 'requires acquired media');
    }
    return validateTranscript(media.transcript, media.id as string, media.content_hash);
  }
  return null;
}

export function isTerminalMediaAcquisition(
  acquisition: MediaAcquisition | MediaAcquisitionStatus,
): boolean {
  const status = typeof acquisition === 'string'
    ? acquisition
    : acquisition.status;
  return (TERMINAL_MEDIA_ACQUISITION_STATUSES as readonly string[])
    .includes(status);
}

/**
 * Derive the processing identity from an ordered, versioned field list.
 *
 * Acquisition status/reason and transcript output are intentionally excluded:
 * they are mutable results, not processing inputs.
 */
export function deriveMediaProcessorIdempotencyKey(
  media: MediaEvidence,
  processor: MediaProcessorIdentity,
): string {
  const mediaError = validateMediaProcessingInput(media);
  if (mediaError) throw mediaError;
  const processorError = validateProcessorIdentity(
    processor as unknown as Record<string, unknown>,
    'processor.',
  );
  if (processorError) throw processorError;

  const basis = [
    MEDIA_EVIDENCE_API_VERSION,
    media.id,
    media.kind,
    media.content_hash ?? media.url,
    media.owner.brain_id,
    media.owner.target_source_id,
    media.provenance.source_id,
    media.provenance.external_id,
    media.content_hash === null ? media.provenance.source_uri : null,
    media.derived_from?.media_id ?? null,
    media.derived_from?.content_hash ?? null,
    processor.processor_key,
    processor.processor_version,
    processor.model_provider,
    processor.model_name,
    processor.model_version,
  ];
  const digest = createHash('sha256')
    .update(JSON.stringify(basis))
    .digest('hex');
  return `media-process:${digest}`;
}
