/**
 * `ingest_capture` Minion job handler. Receives an IngestionEvent payload
 * from the daemon's dispatcher (or the webhook source's POST /ingest
 * handler) and routes it through `importFromContent` to land as a brain
 * page.
 *
 * Trust posture (E1 + eng-review decisions):
 *   - The event's `untrusted_payload` flag is preserved on the job's
 *     result for audit, but does NOT change the importFromContent call
 *     itself — auto-link runs at the put_page operation layer, which we
 *     deliberately bypass here. The handler calls importFromContent
 *     directly. v1 path: webhook OAuth gate is the trust boundary; the
 *     handler trusts the event-shape but treats content as user-authored
 *     markdown.
 *   - Auto-link integration with the untrusted_payload tag is a v2
 *     improvement (would require routing through the put_page op AND
 *     extending OperationContext with the trust tag). See TODOs in the
 *     plan.
 *
 * Slug resolution (in order):
 *   1. `job.data.slug` if caller provided one
 *   2. `job.data.metadata.slug` if event metadata carried one
 *   3. Native intake: `inbox/native-<identity-hash>` from the admitted
 *      delivery identity, stable across worker restarts and UTC boundaries
 *   4. Legacy default: `inbox/YYYY-MM-DD-<hash6>` using the event's
 *      content_hash prefix
 *
 * The default slug deliberately lives under `inbox/` — that's the
 * triage convention the user will discover when reviewing recent
 * captures. A downstream skill (post-capture-triage) can promote inbox
 * pages to canonical homes later.
 */

import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent, NativeIntakeEnvelope } from '../../ingestion/types.ts';
import {
  deriveNativeIntakeOutputSlug,
  validateIngestionEvent,
  validateNativeIntakeEnvelope,
} from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';

export interface IngestCaptureResult {
  slug: string;
  /** Effective registered brain source that owns the imported page. */
  source_id: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  untrusted_payload: boolean;
  source_kind: string;
  source_uri: string;
}

/** Builds the default slug for an event when the caller didn't provide one. */
export function defaultSlugForEvent(event: IngestionEvent, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = event.content_hash.slice(0, 6);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

export function makeIngestCaptureHandler(engine: BrainEngine) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as { event?: unknown; slug?: unknown; sourceId?: unknown };
    const event = data.event as IngestionEvent | undefined;
    if (!event) {
      throw new UnrecoverableError('ingest_capture: job.data.event is required');
    }
    const possibleNativeEvent = event as Partial<NativeIntakeEnvelope>;
    const isNativeIntake =
      possibleNativeEvent.api_version !== undefined ||
      possibleNativeEvent.target_source_id !== undefined;
    const validationErr = isNativeIntake
      ? validateNativeIntakeEnvelope(event)
      : validateIngestionEvent(event);
    if (validationErr) {
      // Native validation errors intentionally omit the original event because
      // content and upstream identifiers can be sensitive.
      throw new UnrecoverableError(
        isNativeIntake
          ? `ingest_capture: invalid native event payload (${validationErr.field})`
          : `ingest_capture: invalid event payload: ${validationErr.message}`,
      );
    }

    // Slug resolution.
    let slug: string;
    if (typeof data.slug === 'string' && data.slug.length > 0) {
      slug = data.slug;
    } else if (
      event.metadata &&
      typeof (event.metadata as Record<string, unknown>).slug === 'string'
    ) {
      slug = (event.metadata as Record<string, unknown>).slug as string;
    } else if (isNativeIntake) {
      slug = deriveNativeIntakeOutputSlug(event as NativeIntakeEnvelope);
    } else {
      slug = defaultSlugForEvent(event);
    }

    // Untrusted-payload posture. For v1, the flag is propagated for audit
    // but not enforced at this layer (see file header). Future v2 wiring
    // through put_page will use this flag.
    const untrustedPayload = event.untrusted_payload === true;

    // For text-typed events, content is the inline markdown/text. For
    // binary types (image/audio/video/pdf), content is a path-or-URI that
    // the content-type processor pipeline transforms. The v1 wave lands
    // the text path; processors arrive in subsequent commits.
    const isText =
      event.content_type === 'text/markdown' ||
      event.content_type === 'text/plain' ||
      event.content_type === 'text/html' ||
      event.content_type === 'application/json' ||
      event.content_type === 'unknown';

    if (!isText) {
      // Binary content without a processor would land as a path-string
      // page, which isn't useful. Native admission treats this as unsupported
      // work and dead-letters immediately; legacy jobs preserve their existing
      // retryable error while the operator installs a processor.
      const message =
        `ingest_capture: content_type '${event.content_type}' requires a content-type ` +
          `processor that is not yet installed. Install a processor skillpack ` +
          `(e.g. gbrain-audio-transcribe, gbrain-image-ocr) or pre-extract the ` +
          `content to text/markdown before emitting.`;
      if (isNativeIntake) throw new UnrecoverableError(message);
      throw new Error(message);
    }

    // noEmbed defaults to true. Mirrors the sync handler's pattern:
    // embed runs as a separate Minion job (autopilot's embed phase OR an
    // explicit `gbrain embed --stale`). Callers can opt in to inline embed
    // by passing { noEmbed: false } in job.data.
    const noEmbed = (data as { noEmbed?: unknown }).noEmbed !== false;

    // #1522: thread the validated event's provenance into the page write
    // instead of dropping it on the floor. source_kind / source_uri are
    // pure provenance strings (no scoping power) and persist
    // unconditionally via importFromContent's putPage write-through.
    //
    // event.source_id is the emitter's IngestionSource instance id, NOT
    // necessarily a registered brain source (the webhook path fabricates
    // `webhook-<clientId>`, which pages.source_id's FK would reject). It
    // routes the page write only when BOTH hold:
    //   - the event is trusted (fail-closed: an untrusted webhook payload
    //     carries a caller-controlled x-gbrain-source-id header and must
    //     not get to choose its write source), AND
    //   - the id names a registered source row.
    // Otherwise the write keeps the pre-fix default-source routing.
    let sourceId: string | undefined;
    if (isNativeIntake) {
      const nativeEvent = event as NativeIntakeEnvelope;
      if (
        typeof data.sourceId !== 'string' ||
        data.sourceId !== nativeEvent.target_source_id
      ) {
        throw new UnrecoverableError('ingest_capture: native target mismatch');
      }
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = $1 AND archived = false`,
        [data.sourceId],
      );
      if (rows.length === 0) {
        throw new Error('ingest_capture: native target unavailable');
      }
      sourceId = rows[0].id;
    } else if (!untrustedPayload) {
      const rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = $1`,
        [event.source_id],
      );
      if (rows.length > 0) sourceId = event.source_id;
    }

    const result = await importFromContent(engine, slug, event.content, {
      noEmbed,
      sourceId,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
      ingested_via: 'ingest_capture',
    });

    return {
      slug,
      source_id: sourceId ?? 'default',
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
    };
  };
}
