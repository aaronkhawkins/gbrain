import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from '../minions/queue.ts';
import type { MinionJob, MinionJobStatus } from '../minions/types.ts';
import { fetchSource, parseSourceConfig } from '../sources-load.ts';
import { isValidSourceId } from '../source-id.ts';
import {
  INTAKE_POSTURES,
  computeContentHash,
  deriveNativeIntakeIdempotencyKey,
  deriveNativeIntakeOutputSlug,
  isValidPromotionPolicyId,
  validateNativeIntakeEnvelope,
  type IntakePosture,
  type NativeIntakeDiagnosticIdentity,
  type NativeIntakeEnvelope,
} from './types.ts';

const INLINE_TEXT_TYPES = new Set([
  'text/markdown',
  'text/plain',
  'text/html',
  'application/json',
  'unknown',
]);

const NATIVE_INTAKE_JOB_POLICY = {
  max_attempts: 5,
  backoff_type: 'exponential',
  backoff_delay: 5_000,
  backoff_jitter: 0.2,
  max_stalled: 3,
  timeout_ms: 5 * 60_000,
} as const;

export type NativeIntakeAdmissionErrorCode =
  | 'invalid_envelope'
  | 'brain_mismatch'
  | 'producer_mismatch'
  | 'producer_unavailable'
  | 'invalid_producer_policy'
  | 'unauthorized_target'
  | 'target_unavailable'
  | 'invalid_target_policy'
  | 'posture_mismatch'
  | 'promotion_policy_unauthorized'
  | 'operator_promotion_unsupported'
  | 'content_hash_mismatch'
  | 'unsupported_content_type'
  | 'idempotency_conflict'
  | 'prior_delivery_terminal'
  | 'retryable_backpressure';

export class NativeIntakeAdmissionError extends Error {
  constructor(
    public readonly code: NativeIntakeAdmissionErrorCode,
    public readonly diagnostic: NativeIntakeDiagnosticIdentity,
  ) {
    super(`Native intake admission rejected: ${code}`);
    this.name = 'NativeIntakeAdmissionError';
  }
}

export interface NativeIntakeProducerPolicy {
  allowed_targets: readonly string[];
}

export interface NativeIntakeTargetPolicy {
  posture: IntakePosture;
  promotion_policy_ids: readonly string[];
}

export interface NativeIntakeAdmissionContext {
  /** Identity of the already-open runtime. Event input cannot select it. */
  activeBrainId: string;
  /** AuthInfo.sourceId (or an equivalent authenticated adapter binding). */
  authenticatedSourceId: string;
}

export interface NativeIntakeSubmissionResult {
  disposition: 'accepted' | 'duplicate';
  job_id: number;
  brain_id: string;
  producer_source_id: string;
  target_source_id: string;
  posture: IntakePosture;
  job_status: MinionJobStatus;
}

function diagnostic(envelope: unknown): NativeIntakeDiagnosticIdentity {
  if (envelope === null || typeof envelope !== 'object') return {};
  const value = envelope as Record<string, unknown>;
  const bounded = (field: string): string | undefined => {
    const candidate = value[field];
    return typeof candidate === 'string'
      ? candidate.replace(/[^\x20-\x7e]/g, '?').slice(0, 64)
      : undefined;
  };
  return {
    ...(bounded('api_version') ? { api_version: bounded('api_version') } : {}),
    ...(bounded('brain_id') ? { brain_id: bounded('brain_id') } : {}),
    ...(bounded('source_id') ? { source_id: bounded('source_id') } : {}),
    ...(bounded('target_source_id') ? { target_source_id: bounded('target_source_id') } : {}),
  };
}

function reject(
  code: NativeIntakeAdmissionErrorCode,
  envelope: unknown,
): never {
  throw new NativeIntakeAdmissionError(code, diagnostic(envelope));
}

/** Parse the closed producer authorization policy from sources.config. */
export function parseNativeIntakeProducerPolicy(
  config: unknown,
): NativeIntakeProducerPolicy | null {
  const nativeIntake = parseSourceConfig(config).native_intake;
  if (nativeIntake === null || typeof nativeIntake !== 'object' || Array.isArray(nativeIntake)) {
    return null;
  }
  const allowedTargets = (nativeIntake as Record<string, unknown>).allowed_targets;
  if (
    !Array.isArray(allowedTargets) ||
    allowedTargets.length === 0 ||
    !allowedTargets.every((target) => typeof target === 'string' && isValidSourceId(target))
  ) {
    return null;
  }
  return { allowed_targets: [...new Set(allowedTargets)] };
}

/** Parse the authoritative target posture from sources.config. */
export function parseNativeIntakeTargetPolicy(
  config: unknown,
): NativeIntakeTargetPolicy | null {
  const nativeIntake = parseSourceConfig(config).native_intake;
  if (nativeIntake === null || typeof nativeIntake !== 'object' || Array.isArray(nativeIntake)) {
    return null;
  }
  const policy = nativeIntake as Record<string, unknown>;
  if (!INTAKE_POSTURES.includes(policy.posture as IntakePosture)) return null;
  const promotionPolicyIds = policy.promotion_policy_ids ?? [];
  if (
    !Array.isArray(promotionPolicyIds) ||
    !promotionPolicyIds.every(isValidPromotionPolicyId)
  ) {
    return null;
  }
  return {
    posture: policy.posture as IntakePosture,
    promotion_policy_ids: [...new Set(promotionPolicyIds)],
  };
}

function sameDurableIdentity(
  job: MinionJob,
  incoming: NativeIntakeEnvelope,
): boolean {
  if (job.name !== 'ingest_capture' || job.data.sourceId !== incoming.target_source_id) {
    return false;
  }
  const stored = job.data.event;
  if (stored === null || typeof stored !== 'object') return false;
  if (validateNativeIntakeEnvelope(stored)) return false;
  const event = stored as NativeIntakeEnvelope;
  const storedContentHash = INLINE_TEXT_TYPES.has(event.content_type)
    ? computeContentHash(event.content)
    : null;
  if (
    storedContentHash === null ||
    storedContentHash !== event.content_hash.toLowerCase()
  ) {
    return false;
  }
  const storedBoundary = event.promotion_boundary;
  const incomingBoundary = incoming.promotion_boundary;
  const sameBoundary =
    storedBoundary === undefined && incomingBoundary === undefined ||
    storedBoundary !== undefined &&
      incomingBoundary !== undefined &&
      storedBoundary.target_posture === incomingBoundary.target_posture &&
      storedBoundary.authority === incomingBoundary.authority &&
      storedBoundary.policy_id === incomingBoundary.policy_id;
  // Mirror admission's deterministic output identity. Other event metadata is
  // receipt/provenance-only today and may drift across retries.
  const expectedSlug = (candidate: NativeIntakeEnvelope): string => {
    const metadataSlug = candidate.metadata?.slug;
    return typeof metadataSlug === 'string' && metadataSlug.length > 0
      ? metadataSlug
      : deriveNativeIntakeOutputSlug(candidate);
  };
  const storedSlug = job.data.slug;
  const incomingSlug = expectedSlug(incoming);
  // Native admission does not request inline embedding. A malformed stored
  // wrapper that flips noEmbed=false would execute materially different work.
  const sameEmbeddingMode = job.data.noEmbed !== false;

  return event.api_version === incoming.api_version
    && event.brain_id === incoming.brain_id
    && event.target_source_id === incoming.target_source_id
    && event.source_id === incoming.source_id
    && event.external_id === incoming.external_id
    && event.content_hash.toLowerCase() === incoming.content_hash
    && event.content_type === incoming.content_type
    && event.source_kind === incoming.source_kind
    && event.posture === incoming.posture
    && (event.untrusted_payload === true) === (incoming.untrusted_payload === true)
    && sameBoundary
    && storedSlug === expectedSlug(event)
    && storedSlug === incomingSlug
    && sameEmbeddingMode;
}

/**
 * Validate, authorize, and durably queue a native intake envelope.
 *
 * The supplied engine is always the active runtime. `brain_id` is checked as
 * an assertion only and is never used to open or select storage.
 */
export async function submitNativeIntake(
  engine: BrainEngine,
  queue: Pick<MinionQueue, 'addWithDisposition'>,
  input: unknown,
  context: NativeIntakeAdmissionContext,
): Promise<NativeIntakeSubmissionResult> {
  const validationError = validateNativeIntakeEnvelope(input);
  if (validationError) {
    throw new NativeIntakeAdmissionError('invalid_envelope', validationError.event);
  }
  const envelope = input as NativeIntakeEnvelope;

  if (envelope.brain_id !== context.activeBrainId) reject('brain_mismatch', envelope);
  if (envelope.source_id !== context.authenticatedSourceId) reject('producer_mismatch', envelope);

  const producer = await fetchSource(engine, context.authenticatedSourceId);
  if (!producer || producer.archived !== false) reject('producer_unavailable', envelope);
  const producerPolicy = parseNativeIntakeProducerPolicy(producer.config);
  if (!producerPolicy) reject('invalid_producer_policy', envelope);
  if (!producerPolicy.allowed_targets.includes(envelope.target_source_id)) {
    reject('unauthorized_target', envelope);
  }

  const target = await fetchSource(engine, envelope.target_source_id);
  if (!target || target.archived !== false) reject('target_unavailable', envelope);
  const targetPolicy = parseNativeIntakeTargetPolicy(target.config);
  if (!targetPolicy) reject('invalid_target_policy', envelope);
  if (envelope.posture !== targetPolicy.posture) reject('posture_mismatch', envelope);

  if (envelope.promotion_boundary?.authority === 'operator') {
    reject('operator_promotion_unsupported', envelope);
  }
  if (envelope.promotion_boundary?.authority === 'policy') {
    if (!targetPolicy.promotion_policy_ids.includes(envelope.promotion_boundary.policy_id)) {
      reject('promotion_policy_unauthorized', envelope);
    }
  }

  // Binary `content` is a path/data-URI pointer, not the bytes themselves.
  // This core deliberately does not pretend hashing the pointer verifies the
  // media. A processor-backed binary admission contract is separate work.
  if (!INLINE_TEXT_TYPES.has(envelope.content_type)) {
    reject('unsupported_content_type', envelope);
  }

  const computedHash = computeContentHash(envelope.content);
  if (computedHash !== envelope.content_hash.toLowerCase()) {
    reject('content_hash_mismatch', envelope);
  }
  const normalizedEnvelope: NativeIntakeEnvelope = {
    ...envelope,
    // The resolved server-side values remain authoritative after admission.
    target_source_id: target.id,
    posture: targetPolicy.posture,
    content_hash: computedHash,
  };
  const idempotencyKey = deriveNativeIntakeIdempotencyKey(normalizedEnvelope);
  const metadataSlug = normalizedEnvelope.metadata?.slug;
  const outputSlug = typeof metadataSlug === 'string' && metadataSlug.length > 0
    ? metadataSlug
    : deriveNativeIntakeOutputSlug(normalizedEnvelope);
  const queued = await queue.addWithDisposition(
    'ingest_capture',
    {
      sourceId: target.id,
      slug: outputSlug,
      event: normalizedEnvelope,
    },
    {
      idempotency_key: idempotencyKey,
      ...NATIVE_INTAKE_JOB_POLICY,
      remove_on_complete: false,
      remove_on_fail: false,
    },
    { allowProtectedSubmit: true },
  );

  if (queued.disposition === 'coalesced') {
    reject('retryable_backpressure', normalizedEnvelope);
  }
  if (
    queued.disposition === 'duplicate' &&
    !sameDurableIdentity(queued.job, normalizedEnvelope)
  ) {
    reject('idempotency_conflict', normalizedEnvelope);
  }
  if (
    queued.disposition === 'duplicate' &&
    ['failed', 'dead', 'cancelled'].includes(queued.job.status)
  ) {
    reject('prior_delivery_terminal', normalizedEnvelope);
  }
  if (
    queued.disposition === 'duplicate' &&
    !['waiting', 'delayed', 'active', 'completed'].includes(queued.job.status)
  ) {
    reject('idempotency_conflict', normalizedEnvelope);
  }

  return {
    disposition: queued.disposition === 'inserted' ? 'accepted' : 'duplicate',
    job_id: queued.job.id,
    brain_id: context.activeBrainId,
    producer_source_id: producer.id,
    target_source_id: target.id,
    posture: targetPolicy.posture,
    job_status: queued.job.status,
  };
}
