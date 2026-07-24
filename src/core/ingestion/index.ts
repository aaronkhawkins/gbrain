/**
 * Public barrel for the gbrain/ingestion subpath.
 *
 * Skillpack publishers import from here:
 *
 *   import { IngestionSource, IngestionEvent, computeContentHash } from 'gbrain/ingestion';
 *
 * Treat this surface as a versioned public API. Adding exports is a minor
 * release; removing or breaking-changing them is a major. Pinned by
 * test/public-exports.test.ts.
 *
 * The daemon itself is intentionally NOT exported — it's gbrain-internal.
 * Publishers run their sources via either:
 *   - the test harness (gbrain/ingestion/test-harness, for unit tests)
 *   - the CLI (`gbrain ingest test`, for hot-iteration dry-run)
 *   - the production daemon (`gbrain ingest`, which composes everything)
 */

export type {
  IngestionContentType,
  IngestionEvent,
  IntakePosture,
  IntakePromotionAuthority,
  IntakePromotionBoundary,
  IngestionSource,
  IngestionSourceContext,
  IngestionSourceHealth,
  NativeIntakeDiagnosticIdentity,
  NativeIntakeIdempotencyInput,
  NativeIntakeEnvelope,
} from './types.ts';

export {
  INGESTION_CONTENT_TYPES,
  INTAKE_POSTURES,
  INTAKE_PROMOTION_AUTHORITIES,
  INGESTION_SOURCE_API_VERSION,
  NATIVE_INTAKE_API_VERSION,
  IngestionEventError,
  computeContentHash,
  deriveNativeIntakeIdempotencyKey,
  validateIngestionEvent,
  validateNativeIntakeEnvelope,
} from './types.ts';

export {
  NativeIntakeAdmissionError,
  parseNativeIntakeProducerPolicy,
  parseNativeIntakeTargetPolicy,
  submitNativeIntake,
} from './native-intake.ts';

export type {
  NativeIntakeAdmissionContext,
  NativeIntakeAdmissionErrorCode,
  NativeIntakeProducerPolicy,
  NativeIntakeSubmissionResult,
  NativeIntakeTargetPolicy,
} from './native-intake.ts';

export type {
  MediaAcquisition,
  MediaAcquisitionStatus,
  MediaEvidence,
  MediaEvidenceDerivation,
  MediaEvidenceOwner,
  MediaEvidenceProvenance,
  MediaKind,
  MediaProcessorIdentity,
  MediaTranscriptEvidence,
  MediaTranscriptSegment,
  MediaTranscriptSourceKind,
  TerminalMediaAcquisitionStatus,
} from './media-evidence.ts';

export {
  MEDIA_ACQUISITION_STATUSES,
  MEDIA_EVIDENCE_API_VERSION,
  MEDIA_KINDS,
  MEDIA_TRANSCRIPT_SOURCE_KINDS,
  TERMINAL_MEDIA_ACQUISITION_STATUSES,
  MediaEvidenceValidationError,
  deriveMediaProcessorIdempotencyKey,
  isTerminalMediaAcquisition,
  validateMediaEvidence,
} from './media-evidence.ts';
