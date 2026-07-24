/**
 * Ingestion contract — IngestionSource, IngestionEvent, IngestionSourceContext.
 *
 * The locked public API surface for third-party skillpack publishers. Once a
 * skillpack ships against this contract, breaking it requires a major bump and
 * shows up in test/public-exports.test.ts. Treat these types as a versioned
 * public API the same way BrainEngine is.
 *
 * Source contract design decisions (locked in /plan-ceo-review + /plan-eng-review):
 *
 *   - Sources are dumb emitters; daemon owns supervision (SourceSupervisor
 *     mirrors the v0.34.3.0 ChildWorkerSupervisor pattern for in-process
 *     modules — see daemon.ts). Sources THROW exceptions on failure; daemon
 *     catches and applies exponential backoff per the crash-counter rule.
 *
 *   - IngestionEvent.content_type taxonomy drives daemon-side hybrid routing
 *     (E2 eng-review decision): content under 1MB is processed inline before
 *     queue submission; content over 1MB submits a separate process_audio /
 *     process_video Minion handler chain. Sources can opt out per-event by
 *     pre-emitting content_type: 'text/markdown' with already-extracted text.
 *
 *   - IngestionEvent.untrusted_payload flag round-trips to the put_page
 *     handler. Set by the webhook source (network input) and skillpack
 *     sources that fetch URLs. When true, put_page skips auto-link and
 *     applies the slug-allowlist gate. Untrusted in-process callers (CLI
 *     `gbrain capture`) leave it false.
 *
 *   - The api_version constant on the skillpack manifest decouples the
 *     contract from skillpack release cadence. v1 sources fail loudly with a
 *     paste-ready upgrade hint when the daemon loads against contract v2.
 */

import type { BrainEngine } from '../engine.ts';
import type { Logger } from '../operations.ts';
import { isValidSourceId } from '../source-id.ts';

/**
 * Contract version stamped on every gbrain.plugin.json that ships an
 * IngestionSource. Bumped only when the IngestionSource / IngestionEvent
 * shape changes incompatibly. Reverse aliases for prior versions live in the
 * skillpack-load module so existing packs continue to work across a
 * deprecation window.
 */
export const INGESTION_SOURCE_API_VERSION = 'gbrain-ingestion-source-v1';

/**
 * Serialized native-intake envelope version. Independent from
 * INGESTION_SOURCE_API_VERSION: producer plugin lifecycle and durable payload
 * lifecycle evolve on separate compatibility timelines.
 */
export const NATIVE_INTAKE_API_VERSION = 'gbrain-native-intake-v1';

/**
 * Canonical taxonomy of content types the daemon recognizes. The router
 * dispatches on these values; unknown types pass through unchanged and the
 * pipeline treats them as opaque text/markdown for indexing purposes.
 *
 * `image/*`, `audio/*`, `video/*` are deliberately the only wildcard forms.
 * Subtypes are encoded in IngestionEvent.metadata when needed (e.g.
 * `{format: 'png'}`). Wildcards keep the router map small while preserving
 * provenance fidelity.
 */
export const INGESTION_CONTENT_TYPES = [
  'text/markdown',
  'text/plain',
  'text/html',
  'application/pdf',
  'application/json',
  'image/*',
  'audio/*',
  'video/*',
  'unknown',
] as const;

export type IngestionContentType = typeof INGESTION_CONTENT_TYPES[number];

/**
 * Retrieval/write posture owned by a registered source within a brain.
 *
 * The source registration chooses where intake lands; an adapter MUST NOT
 * invent a second registry or reinterpret these values as brain identities.
 * `canonical` is durable knowledge. The other three are evidence postures and
 * cross into canonical only through the explicit `promotion_boundary` carried
 * by a NativeIntakeEnvelope.
 */
export const INTAKE_POSTURES = [
  'canonical',
  'inbox',
  'research',
  'session-evidence',
] as const;

export type IntakePosture = typeof INTAKE_POSTURES[number];

export const INTAKE_PROMOTION_AUTHORITIES = ['operator', 'policy'] as const;
export type IntakePromotionAuthority = typeof INTAKE_PROMOTION_AUTHORITIES[number];

/**
 * Stable event the daemon receives from every source. Carries enough
 * identity for content-hash dedup at the daemon layer and enough provenance
 * for the put_page handler to stamp frontmatter without re-deriving fields.
 *
 * Sources MUST populate every required field. The daemon validates at the
 * boundary via `validateIngestionEvent`; malformed events are rejected with
 * a logged error rather than crashing the source.
 */
export interface IngestionEvent {
  /** Source instance id. Matches the IngestionSource.id of the emitter. */
  source_id: string;
  /** Source kind taxonomy (file-watcher | inbox-folder | webhook | <skillpack-kind>). */
  source_kind: string;
  /** Original URI of the content (file path, mail message-id, URL, etc.). */
  source_uri: string;
  /** UTC ISO timestamp the source observed the event. */
  received_at: string;
  /** Detected content type. Drives daemon-side routing per E2 hybrid model. */
  content_type: IngestionContentType;
  /** Primary content body. For text/* types this is the markdown/text payload.
   *  For binary types (image/audio/video/pdf), this is an absolute path or
   *  a data URI; the processor reads from there. */
  content: string;
  /** SHA-256 hex of `content`. Daemon dedups on (source_kind, content_hash)
   *  within a 24h window before queueing. Computing this is the source's
   *  responsibility because the source knows whether content is text or
   *  a path-pointer. */
  content_hash: string;
  /**
   * Trust tag. Set to true by sources that receive input from untrusted
   * channels (webhook, future URL fetcher sources). The downstream put_page
   * handler honors this flag: skips auto-link entity extraction and applies
   * the slug-allowlist gate. Local in-process callers (CLI capture, file
   * watcher reading the user's own brain repo) MUST leave this false.
   */
  untrusted_payload?: boolean;
  /** Optional source-specific metadata. Free-form. Persisted into the page's
   *  frontmatter under `ingestion_metadata` when present. */
  metadata?: Record<string, unknown>;
}

/**
 * The boundary an evidence posture must cross before becoming canonical.
 *
 * Dream may coordinate enrichment and propose work, but it is not a competing
 * owner of canonical state. Promotion is authorized either directly by an
 * operator or by a named, stable policy. Evidence remains in its original
 * posture after promotion so lineage is not destroyed.
 */
export type IntakePromotionBoundary =
  | {
      target_posture: 'canonical';
      authority: 'policy';
      /** Stable configured policy identity authorizing this promotion. */
      policy_id: string;
    }
  | {
      target_posture: 'canonical';
      authority: 'operator';
      policy_id?: never;
    };

/**
 * Normalized evidence submitted by a native intake adapter.
 *
 * This extends the existing IngestionEvent rather than creating a parallel
 * source contract. IngestionEvent.source_id remains the producer/adapter
 * instance identity. `target_source_id` identifies the existing registered
 * GBrain source where evidence should land; resolving that registration
 * belongs to the runtime.
 *
 * `brain_id` is an assertion about the already-active runtime, not a database
 * selector. Admission added in issue #3 MUST reject an envelope whose brain id
 * does not match that runtime; it MUST NOT switch databases from event input.
 * It MUST also authorize the (source_id, target_source_id) producer-to-target
 * pair from registered/authenticated producer config before comparing the
 * adapter's posture assertion with the registered target posture.
 *
 * External identity is scoped to
 * (brain_id, target_source_id, source_id, external_id). The idempotency key is
 * a stable, adapter-supplied operation identity and may include a processor
 * or schema version so intentional reprocessing is distinguishable from retry.
 */
export interface NativeIntakeEnvelope extends IngestionEvent {
  /** Serialized envelope contract version. */
  api_version: typeof NATIVE_INTAKE_API_VERSION;
  /**
   * Asserted active runtime id (`host` or a registered mount id). Cannot
   * select another database; issue #3 admission verifies it against runtime.
   */
  brain_id: string;
  /** Existing registered GBrain source that receives this evidence. */
  target_source_id: string;
  /** Stable identity assigned by the upstream system. */
  external_id: string;
  /**
   * Optional upstream content creation time. When present, MUST be canonical
   * UTC Date.toISOString() form (`YYYY-MM-DDTHH:mm:ss.sssZ`). Inherited
   * received_at remains when the adapter observed/received the event.
   */
  source_created_at?: string;
  /**
   * Adapter assertion about the registered target's configured posture.
   * Issue #3 admission MUST compare it with the resolved target registration
   * and reject a mismatch; this field cannot override target configuration.
   */
  posture: IntakePosture;
  /**
   * Required for evidence postures and forbidden for canonical intake. This
   * makes the evidence → canonical ownership boundary explicit.
   */
  promotion_boundary?: IntakePromotionBoundary;
  /**
   * Adapter-local retry identity. MUST be stable for retries and unique across
   * external items/revisions within (brain_id, target_source_id, source_id).
   * It may be reused in another scope. Issue #3 MUST pass the globally scoped
   * output of deriveNativeIntakeIdempotencyKey to the Minion queue, never this
   * raw value directly. If a durable key already exists, issue #3 MUST compare
   * its stored external identity and content hash with this envelope before
   * acknowledging it as a retry; a mismatch is a visible conflict.
   */
  idempotency_key: string;
}

export type NativeIntakeIdempotencyInput = Pick<
  NativeIntakeEnvelope,
  | 'api_version'
  | 'brain_id'
  | 'target_source_id'
  | 'source_id'
  | 'external_id'
  | 'idempotency_key'
>;

/** Content-free identity safe to attach to native intake validation errors. */
export interface NativeIntakeDiagnosticIdentity {
  api_version?: string;
  brain_id?: string;
  source_id?: string;
  target_source_id?: string;
}

/**
 * Health probe surface for sources that want to expose state to
 * `gbrain doctor ingestion_health`. Optional — sources that don't implement
 * it surface as `ok` from the daemon side (no signal == healthy assumption).
 */
export interface IngestionSourceHealth {
  status: 'ok' | 'warn' | 'fail';
  message?: string;
}

/**
 * Pluggable ingestion source. Built-in sources (file-watcher, inbox-folder,
 * cron-scheduler) and skillpack-distributed sources implement the same
 * interface — there are no special code paths for built-ins.
 *
 * Lifecycle:
 *   1. Daemon constructs the source via the skillpack-declared factory.
 *   2. Daemon calls `start(ctx)`. MUST resolve when source is ready to emit.
 *      MAY throw — the SourceSupervisor catches and applies backoff.
 *   3. Source emits events via `ctx.emit(event)` until shutdown.
 *   4. Daemon calls `stop()`. MUST drain any in-flight emission within a
 *      bounded grace window (default 5 seconds; configurable via
 *      `ingestion.shutdown_grace_ms`).
 *   5. Daemon may call `healthCheck()` periodically (default every 60s)
 *      for the doctor surface.
 *
 * Error model (locked /plan-devex-review D1): exceptions thrown from
 * `start` / `stop` / inside an `onEvent` callback bubble to the daemon.
 * The SourceSupervisor catches them, increments the crash counter,
 * applies exponential backoff, and restarts (up to maxCrashes). Sources
 * that need richer semantics (transient vs fatal) are a v2 concern; for
 * v1, "throw to fail" is the entire contract.
 */
/**
 * Source operating mode (v0.41 T2 — codex outside-voice challenge: bulk
 * migration semantics differ from trickle ingestion). The daemon branches
 * on this flag to decide whether to apply the 24h content-hash dedup window
 * (trickle) or bypass it (migration; the source owns its own permanent
 * slug-keyed idempotency via op_checkpoint or similar).
 *
 * Defaults to 'trickle' when unset — preserves v0.38-shipped source
 * behavior unchanged. Any source declaring mode: 'migration' opts into
 * the bulk semantics:
 *   - Daemon bypasses DedupWindow.mark() so retries beyond 24h still ingest.
 *   - Source MUST implement permanent idempotency (slug + content_hash
 *     forever, NOT a windowed dedup) on its own. The greenfield importer
 *     uses op_checkpoint keyed on the importer's fingerprint.
 *   - Rate limit + validate + dispatch still apply uniformly.
 *
 * Migration-mode sources are one-shot bulk importers. Trickle-mode sources
 * are file-watcher / inbox-folder / webhook (the v0.38 default shape).
 */
export type IngestionSourceMode = 'trickle' | 'migration';

export interface IngestionSource {
  /** Unique source instance id. Two file-watcher sources pointing at
   *  different directories MUST have different ids. The daemon dedups
   *  events on (source_kind, content_hash); id is for provenance and
   *  health reporting. */
  readonly id: string;
  /** Source kind taxonomy. The router uses this to look up processors
   *  and the dedup window to scope content-hash keys. */
  readonly kind: string;
  /**
   * v0.41 T2 — operating mode discriminator. Defaults to 'trickle' when
   * unset (preserves v0.38 shipped behavior). 'migration' bypasses the
   * 24h dedup window; the source owns its own permanent idempotency.
   */
  readonly mode?: IngestionSourceMode;
  /**
   * Begin emitting events. MUST resolve when the source is ready to emit;
   * MAY throw on unrecoverable startup failure. The daemon catches throws
   * and applies the supervisor backoff policy.
   */
  start(ctx: IngestionSourceContext): Promise<void>;
  /**
   * Stop emitting and drain in-flight work. The daemon will wait up to the
   * configured grace window before forcing shutdown. Sources MUST cooperate
   * with `ctx.abortSignal` — long-running waits should be `Promise.race`-d
   * against the signal.
   */
  stop(): Promise<void>;
  /** Optional health probe. Fired by the daemon every ~60s for the doctor
   *  surface. When omitted, the source is assumed healthy unless it has
   *  crashed recently. */
  healthCheck?(): Promise<IngestionSourceHealth>;
}

/**
 * Context the daemon passes to every source's `start()` call. Sources
 * interact with the daemon exclusively through this shape — they do not
 * touch the Minion queue, the engine, or the audit log directly.
 */
export interface IngestionSourceContext {
  /**
   * Pure event-emit. The daemon dedups, applies the per-source rate limit,
   * and dispatches the event to the Minion queue. Synchronous from the
   * source's perspective — emit returns immediately whether the daemon
   * accepted, dropped (dedup hit), or rate-limited the event.
   */
  emit(event: IngestionEvent): void;
  /**
   * Read-only engine handle for sources that need to consult the existing
   * brain (e.g. a future dedup-aware source that checks for an existing
   * page before emitting). Sources MUST NOT write directly — emit an event
   * and let the daemon route it through put_page.
   */
  engine: BrainEngine;
  /** Daemon-provided logger. Sources log here, not to console.log. */
  logger: Logger;
  /** Fires when the daemon is shutting down. Sources MUST cooperate by
   *  exiting any pending operations within the grace window. Long-running
   *  watches should `Promise.race(..., new Promise(r => signal.addEventListener('abort', r)))`. */
  abortSignal: AbortSignal;
  /** Source-specific config resolved at daemon startup from gbrain.yml
   *  (built-in sources) or gbrain.plugin.json default_config + per-install
   *  overrides (skillpack sources). Free-form JSON-serializable. */
  config: Record<string, unknown>;
}

/**
 * Validation error raised by `validateIngestionEvent`. Carries the field
 * that failed and a human-readable reason. The daemon logs and rejects;
 * the source's emit returns silently (the source already moved on).
 */
export class IngestionEventError<
  TEvent extends Partial<IngestionEvent> = Partial<IngestionEvent>,
> extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
    public readonly event: TEvent,
  ) {
    super(`IngestionEvent.${field}: ${reason}`);
    this.name = 'IngestionEventError';
  }
}

/**
 * Boundary validator. Daemon runs this on every emit before queueing. Returns
 * null on success; an IngestionEventError on the first failed field.
 *
 * Deliberately structural — we don't validate content_hash matches the SHA-256
 * of content here because (a) the source computed it; (b) recomputing on
 * every emit would double the CPU cost on the hot path. The dedup layer is
 * tolerant of bad hashes — a bad hash just means dedup misses, not corruption.
 */
export function validateIngestionEvent(event: unknown): IngestionEventError | null {
  if (event === null || typeof event !== 'object') {
    return new IngestionEventError('root', 'must be an object', {});
  }
  const e = event as Record<string, unknown>;

  // Required strings.
  for (const field of [
    'source_id',
    'source_kind',
    'source_uri',
    'received_at',
    'content',
    'content_hash',
  ] as const) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      return new IngestionEventError(field, 'must be a non-empty string', e as Partial<IngestionEvent>);
    }
  }

  // Content type from the closed taxonomy.
  if (typeof e.content_type !== 'string') {
    return new IngestionEventError('content_type', 'must be a string', e as Partial<IngestionEvent>);
  }
  if (!INGESTION_CONTENT_TYPES.includes(e.content_type as IngestionContentType)) {
    return new IngestionEventError(
      'content_type',
      `must be one of ${INGESTION_CONTENT_TYPES.join(', ')}; got '${e.content_type}'`,
      e as Partial<IngestionEvent>,
    );
  }

  // received_at must parse as an ISO timestamp. Reject malformed without trying
  // to be clever about formats — sources should emit Date.prototype.toISOString().
  const parsed = Date.parse(e.received_at as string);
  if (!Number.isFinite(parsed)) {
    return new IngestionEventError(
      'received_at',
      `must be an ISO 8601 timestamp; got '${e.received_at}'`,
      e as Partial<IngestionEvent>,
    );
  }

  // content_hash should look like a SHA-256 hex string. We don't recompute and
  // verify (CPU cost), but we reject obviously bogus values that would create
  // hash-key chaos at the dedup layer.
  const hash = e.content_hash as string;
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return new IngestionEventError(
      'content_hash',
      `must be 64 lowercase hex characters (SHA-256); got '${hash.slice(0, 16)}...'`,
      e as Partial<IngestionEvent>,
    );
  }

  // untrusted_payload is optional but must be boolean if present.
  if (e.untrusted_payload !== undefined && typeof e.untrusted_payload !== 'boolean') {
    return new IngestionEventError(
      'untrusted_payload',
      `must be boolean when present; got ${typeof e.untrusted_payload}`,
      e as Partial<IngestionEvent>,
    );
  }

  // metadata is optional but must be a plain object if present.
  if (e.metadata !== undefined) {
    if (e.metadata === null || typeof e.metadata !== 'object' || Array.isArray(e.metadata)) {
      return new IngestionEventError(
        'metadata',
        'must be a plain object when present',
        e as Partial<IngestionEvent>,
      );
    }
  }

  return null;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const PROMOTION_POLICY_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CANONICAL_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isNormalizedExternalId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** Internal shared validator for configured and envelope promotion policy IDs. */
export function isValidPromotionPolicyId(value: unknown): value is string {
  return typeof value === 'string' && PROMOTION_POLICY_ID_RE.test(value);
}

function isCanonicalUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC_ISO_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function boundedDiagnosticString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, maxLength);
}

function nativeIntakeDiagnosticIdentity(envelope: unknown): NativeIntakeDiagnosticIdentity {
  if (envelope === null || typeof envelope !== 'object') return {};
  const e = envelope as Record<string, unknown>;
  return {
    ...(boundedDiagnosticString(e.api_version, 64) !== undefined
      ? { api_version: boundedDiagnosticString(e.api_version, 64) }
      : {}),
    ...(boundedDiagnosticString(e.brain_id, 32) !== undefined
      ? { brain_id: boundedDiagnosticString(e.brain_id, 32) }
      : {}),
    ...(boundedDiagnosticString(e.source_id, 32) !== undefined
      ? { source_id: boundedDiagnosticString(e.source_id, 32) }
      : {}),
    ...(boundedDiagnosticString(e.target_source_id, 32) !== undefined
      ? { target_source_id: boundedDiagnosticString(e.target_source_id, 32) }
      : {}),
  };
}

function nativeIntakeError(
  field: string,
  reason: string,
  envelope: unknown,
): IngestionEventError<NativeIntakeDiagnosticIdentity> {
  return new IngestionEventError(field, reason, nativeIntakeDiagnosticIdentity(envelope));
}

/**
 * Validate the native envelope before durable submission. Target registration
 * existence and brain-id equality are deliberately not checked here: issue #3
 * admission resolves target_source_id through the active runtime's existing
 * source registrations and treats brain_id only as a matching assertion. This
 * pure contract cannot select a database and does not create a second registry.
 */
export function validateNativeIntakeEnvelope(
  envelope: unknown,
): IngestionEventError<NativeIntakeDiagnosticIdentity> | null {
  const eventError = validateIngestionEvent(envelope);
  if (eventError) return nativeIntakeError(eventError.field, eventError.reason, envelope);

  const e = envelope as Record<string, unknown>;

  if (e.api_version !== NATIVE_INTAKE_API_VERSION) {
    return nativeIntakeError(
      'api_version',
      `must be '${NATIVE_INTAKE_API_VERSION}'`,
      envelope,
    );
  }

  // Brain, producer, and destination IDs share GBrain's canonical routing-id
  // syntax. Both source IDs reuse the dependency-free canonical validator.
  if (!isValidSourceId(e.brain_id)) {
    return nativeIntakeError(
      'brain_id',
      'must be a registered brain id (1-32 lowercase alphanumeric characters with optional interior hyphens)',
      envelope,
    );
  }
  if (!isValidSourceId(e.source_id)) {
    return nativeIntakeError(
      'source_id',
      'must be a producer source id (1-32 lowercase alphanumeric characters with optional interior hyphens)',
      envelope,
    );
  }
  if (!isValidSourceId(e.target_source_id)) {
    return nativeIntakeError(
      'target_source_id',
      'must be a registered destination source id (1-32 lowercase alphanumeric characters with optional interior hyphens)',
      envelope,
    );
  }
  if (!isNormalizedExternalId(e.external_id)) {
    return nativeIntakeError(
      'external_id',
      'must be a trimmed, non-empty, control-free string no longer than 512 characters',
      envelope,
    );
  }
  if (!INTAKE_POSTURES.includes(e.posture as IntakePosture)) {
    return nativeIntakeError(
      'posture',
      `must be one of ${INTAKE_POSTURES.join(', ')}`,
      envelope,
    );
  }
  if (!isCanonicalUtcIsoTimestamp(e.received_at)) {
    return nativeIntakeError(
      'received_at',
      'must be canonical UTC Date.toISOString() format (YYYY-MM-DDTHH:mm:ss.sssZ)',
      envelope,
    );
  }
  if (e.source_created_at !== undefined && !isCanonicalUtcIsoTimestamp(e.source_created_at)) {
    return nativeIntakeError(
      'source_created_at',
      'must be canonical UTC Date.toISOString() format (YYYY-MM-DDTHH:mm:ss.sssZ) when present',
      envelope,
    );
  }
  if (typeof e.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(e.idempotency_key)) {
    return nativeIntakeError(
      'idempotency_key',
      'must be 1-512 characters using alphanumeric, dot, underscore, colon, slash, or hyphen characters',
      envelope,
    );
  }

  if (e.posture === 'canonical') {
    if (e.promotion_boundary !== undefined) {
      return nativeIntakeError(
        'promotion_boundary',
        'must be absent when posture is canonical',
        envelope,
      );
    }
    return null;
  }

  if (
    e.promotion_boundary === null ||
    typeof e.promotion_boundary !== 'object' ||
    Array.isArray(e.promotion_boundary)
  ) {
    return nativeIntakeError(
      'promotion_boundary',
      'is required for inbox, research, and session-evidence postures',
      envelope,
    );
  }

  const boundary = e.promotion_boundary as Record<string, unknown>;
  if (boundary.target_posture !== 'canonical') {
    return nativeIntakeError(
      'promotion_boundary.target_posture',
      "must be 'canonical'",
      envelope,
    );
  }
  if (!INTAKE_PROMOTION_AUTHORITIES.includes(boundary.authority as IntakePromotionAuthority)) {
    return nativeIntakeError(
      'promotion_boundary.authority',
      `must be one of ${INTAKE_PROMOTION_AUTHORITIES.join(', ')}`,
      envelope,
    );
  }
  if (
    boundary.authority === 'policy' &&
    !isValidPromotionPolicyId(boundary.policy_id)
  ) {
    return nativeIntakeError(
      'promotion_boundary.policy_id',
      'is required for policy authority and must be a stable 1-64 character lowercase policy id',
      envelope,
    );
  }
  if (boundary.authority === 'operator' && boundary.policy_id !== undefined) {
    return nativeIntakeError(
      'promotion_boundary.policy_id',
      'must be absent for operator authority',
      envelope,
    );
  }

  return null;
}

/**
 * Derive the globally unique key issue #3 passes to MinionQueue.
 *
 * The adapter key remains opaque and local to its asserted identity scope.
 * Hashing the version and complete scope prevents cross-brain/source producer
 * collisions in Minion's globally unique idempotency_key column without
 * exposing potentially sensitive upstream identifiers in queue diagnostics.
 */
export function deriveNativeIntakeIdempotencyKey(
  input: NativeIntakeIdempotencyInput,
): string {
  const scopedIdentity = JSON.stringify([
    input.api_version,
    input.brain_id,
    input.target_source_id,
    input.source_id,
    input.external_id,
    input.idempotency_key,
  ]);
  return `native-intake:${computeContentHash(scopedIdentity)}`;
}

/**
 * Compute SHA-256 hex of a string. Helper for source authors so they don't
 * each invent their own hashing. Sources can also pre-hash binary content
 * separately (e.g. file-watcher hashes the file bytes, not the path).
 */
export function computeContentHash(content: string): string {
  // Bun's built-in crypto returns hex directly. We don't import Node's
  // 'node:crypto' because the conditional types diverge in the Bun runtime.
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}
