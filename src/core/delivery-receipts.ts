import type {
  BrainEngine,
  DeliveryReceipt,
  PageSupersession,
  ReadinessAssessment,
  RecordDeliveryInput,
  SupersedePageInput,
} from './engine.ts';
import { isValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';

const DELIVERY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,47}$/;
const BRAIN_RE = /^(?:host|[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/;

export class DeliveryContractError extends Error {
  constructor(
    public readonly kind: 'invalid' | 'missing_page' | 'missing_delivery' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryContractError';
  }
}

function assertMatch(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new DeliveryContractError('invalid', `invalid ${label}`);
  }
}

function assertSourceId(value: string): void {
  if (!isValidSourceId(value)) {
    throw new DeliveryContractError('invalid', 'invalid source id');
  }
}

function normalizedSlug(value: string, label = 'page slug'): string {
  try {
    return validateSlug(value);
  } catch {
    throw new DeliveryContractError('invalid', `invalid ${label}`);
  }
}

function validateDelivery(input: RecordDeliveryInput): void {
  assertMatch('delivery key', input.deliveryKey, DELIVERY_KEY_RE);
  normalizedSlug(input.slug);
  assertSourceId(input.sourceId);
  assertMatch('content digest', input.contentDigest, DIGEST_RE);
  const status = input.readinessStatus ?? 'pending';
  if (!['pending', 'ready', 'failed'].includes(status)) {
    throw new DeliveryContractError('invalid', 'invalid readiness status');
  }
  const version = input.assessmentVersion ?? '1';
  assertMatch('assessment version', version, VERSION_RE);
  if (input.reasonCode != null) assertMatch('reason code', input.reasonCode, REASON_RE);
  if (status === 'failed' && input.reasonCode == null) {
    throw new DeliveryContractError('invalid', 'failed readiness requires a reason code');
  }
  if (status !== 'failed' && input.reasonCode != null) {
    throw new DeliveryContractError('invalid', 'reason code is only valid for failed readiness');
  }
}

export async function recordDelivery(
  engine: BrainEngine,
  input: RecordDeliveryInput,
): Promise<DeliveryReceipt> {
  validateDelivery(input);
  const slug = normalizedSlug(input.slug);
  return engine.transaction(async (tx) => {
    const inserted = await tx.executeRaw<DeliveryReceipt>(
      `INSERT INTO delivery_receipts (
         delivery_key, page_id, source_id, page_slug, content_digest
       )
       SELECT $1, p.id, $2, $3, $4
         FROM pages p
        WHERE p.source_id = $2 AND p.slug = $3 AND p.deleted_at IS NULL
       ON CONFLICT (delivery_key) DO NOTHING
       RETURNING id::int AS receipt_id, delivery_key, source_id, page_slug,
                 content_digest, delivered_at`,
      [input.deliveryKey, input.sourceId, slug, input.contentDigest],
    );
    const existing = inserted[0] ? [] : await tx.executeRaw<DeliveryReceipt>(
      `SELECT id::int AS receipt_id, delivery_key, source_id, page_slug,
              content_digest, delivered_at
         FROM delivery_receipts
        WHERE delivery_key = $1`,
      [input.deliveryKey],
    );
    const receipt = inserted[0] ?? existing[0];
    if (!receipt) {
      throw new DeliveryContractError('missing_page', 'delivery page does not exist');
    }
    if (
      receipt.source_id !== input.sourceId ||
      receipt.page_slug !== slug ||
      receipt.content_digest !== input.contentDigest
    ) {
      throw new DeliveryContractError(
        'conflict',
        'delivery key is already bound to a different page or digest',
      );
    }

    // Serialize assessment writers on the immutable receipt so a late failed
    // or pending assessment can never race a ready assessment and become the
    // newest visible state.
    await tx.executeRaw(
      'SELECT id FROM delivery_receipts WHERE id = $1 FOR UPDATE',
      [receipt.receipt_id],
    );
    const status = input.readinessStatus ?? 'pending';
    const version = input.assessmentVersion ?? '1';
    const latest = await tx.executeRaw<{ status: string }>(
      `SELECT status FROM readiness_assessments
        WHERE delivery_receipt_id = $1
        ORDER BY assessed_at DESC, id DESC
        LIMIT 1`,
      [receipt.receipt_id],
    );
    if (latest[0]?.status === 'ready' && status !== 'ready') return receipt;

    await tx.executeRaw(
      `INSERT INTO readiness_assessments (
         delivery_receipt_id, assessment_version, status, reason_code
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (
         delivery_receipt_id, assessment_version, status,
         (COALESCE(reason_code, ''))
       ) DO NOTHING`,
      [receipt.receipt_id, version, status, input.reasonCode ?? null],
    );
    return receipt;
  });
}

export async function getReadinessStatus(
  engine: BrainEngine,
  deliveryKey: string,
  opts: { sourceId: string },
): Promise<ReadinessAssessment | null> {
  assertMatch('delivery key', deliveryKey, DELIVERY_KEY_RE);
  assertSourceId(opts.sourceId);
  const rows = await engine.executeRaw<Omit<ReadinessAssessment, 'knowledge_ready'> & { status: ReadinessAssessment['status'] }>(
    `SELECT d.id::int AS receipt_id, d.delivery_key, d.source_id, d.page_slug,
            d.content_digest, d.delivered_at, a.status, a.assessment_version,
            a.reason_code, a.assessed_at
       FROM delivery_receipts d
       JOIN readiness_assessments a ON a.delivery_receipt_id = d.id
      WHERE d.delivery_key = $1 AND d.source_id = $2
      ORDER BY a.assessed_at DESC, a.id DESC
      LIMIT 1`,
    [deliveryKey, opts.sourceId],
  );
  if (!rows[0]) return null;
  return { ...rows[0], knowledge_ready: rows[0].status === 'ready' };
}

function validateSupersession(input: SupersedePageInput): void {
  normalizedSlug(input.slug);
  assertSourceId(input.sourceId);
  assertMatch('supersession key', input.supersessionKey, DELIVERY_KEY_RE);
  assertMatch('superseding brain', input.supersededByBrain, BRAIN_RE);
  assertSourceId(input.supersededBySourceId);
  normalizedSlug(input.supersededBySlug, 'superseding page slug');
  if (
    input.supersededByBrain === 'host' &&
    input.sourceId === input.supersededBySourceId &&
    input.slug === input.supersededBySlug
  ) {
    throw new DeliveryContractError('invalid', 'a page cannot supersede itself');
  }
}

export async function supersedePage(
  engine: BrainEngine,
  input: SupersedePageInput,
): Promise<PageSupersession> {
  validateSupersession(input);
  const slug = normalizedSlug(input.slug);
  const supersededBySlug = normalizedSlug(input.supersededBySlug, 'superseding page slug');
  const inserted = await engine.executeRaw<PageSupersession>(
    `INSERT INTO page_supersessions (
       supersession_key, page_id, source_id, page_slug,
       superseded_by_brain, superseded_by_source_id, superseded_by_slug
     )
     SELECT $1, p.id, $2, $3, $4, $5, $6
       FROM pages p
      WHERE p.source_id = $2 AND p.slug = $3 AND p.deleted_at IS NULL
     ON CONFLICT DO NOTHING
     RETURNING id::int AS supersession_id, supersession_key, source_id, page_slug,
               superseded_by_brain, superseded_by_source_id, superseded_by_slug,
               superseded_at`,
    [
      input.supersessionKey, input.sourceId, slug,
      input.supersededByBrain, input.supersededBySourceId, supersededBySlug,
    ],
  );
  const existing = inserted[0] ? [] : await engine.executeRaw<PageSupersession>(
    `SELECT id::int AS supersession_id, supersession_key, source_id, page_slug,
            superseded_by_brain, superseded_by_source_id, superseded_by_slug,
            superseded_at
       FROM page_supersessions
      WHERE supersession_key = $1
         OR (source_id = $2 AND page_slug = $3)
      ORDER BY (supersession_key = $1) DESC
      LIMIT 1`,
    [input.supersessionKey, input.sourceId, slug],
  );
  const marker = inserted[0] ?? existing[0];
  if (!marker) {
    throw new DeliveryContractError('missing_page', 'page to supersede does not exist');
  }
  if (
    marker.source_id !== input.sourceId ||
    marker.page_slug !== slug ||
    marker.superseded_by_brain !== input.supersededByBrain ||
    marker.superseded_by_source_id !== input.supersededBySourceId ||
    marker.superseded_by_slug !== supersededBySlug
  ) {
    throw new DeliveryContractError(
      'conflict',
      'supersession key is already bound to a different correction',
    );
  }
  return marker;
}
