import { createHash } from 'node:crypto';
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
const BRAIN_RE = /^(?:host|[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/;
const READINESS_ASSESSMENT_VERSION = 'delivery-v1';

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
}

interface RequiredProcessorEvidence {
  processor_key: string;
  processor_version: string;
  receipt_id: number | null;
  attempt: number | null;
  outcome: string | null;
  reason_code: string | null;
}

interface DeliveryEvidence {
  receipt_id: number;
  delivery_key: string;
  source_id: string;
  page_slug: string;
  content_digest: string;
  delivered_at: string;
  searchable: boolean;
}

async function loadLatestReadiness(
  engine: BrainEngine,
  receiptId: number,
): Promise<ReadinessAssessment | null> {
  const rows = await engine.executeRaw<ReadinessAssessment>(
    `SELECT d.id::int AS receipt_id, d.delivery_key, d.source_id, d.page_slug,
            d.content_digest, d.delivered_at, a.status,
            (a.status = 'ready') AS knowledge_ready, a.assessment_version,
            a.reason_code, a.assessed_at
       FROM delivery_receipts d
       JOIN readiness_assessments a ON a.delivery_receipt_id = d.id
      WHERE d.id = $1
      ORDER BY a.assessed_at DESC, a.id DESC
      LIMIT 1`,
    [receiptId],
  );
  return rows[0] ?? null;
}

async function reconcileReadiness(
  engine: BrainEngine,
  receiptId: number,
): Promise<ReadinessAssessment> {
  await engine.executeRaw(
    'SELECT id FROM delivery_receipts WHERE id = $1 FOR UPDATE',
    [receiptId],
  );
  const latest = await loadLatestReadiness(engine, receiptId);
  if (latest?.status === 'ready') return latest;

  const deliveries = await engine.executeRaw<DeliveryEvidence>(
    `SELECT d.id::int AS receipt_id, d.delivery_key, d.source_id, d.page_slug,
            d.content_digest, d.delivered_at,
            EXISTS (
              SELECT 1 FROM content_chunks c
               WHERE c.page_id = d.page_id
                 AND length(trim(c.chunk_text)) > 0
            ) AS searchable
       FROM delivery_receipts d
      WHERE d.id = $1`,
    [receiptId],
  );
  const delivery = deliveries[0];
  if (!delivery) {
    throw new DeliveryContractError('missing_delivery', 'delivery receipt does not exist');
  }

  const processors = await engine.executeRaw<RequiredProcessorEvidence>(
    `SELECT r.processor_key, r.processor_version,
            p.id::int AS receipt_id, p.attempt, p.outcome, p.reason_code
       FROM processing_registrations r
       LEFT JOIN processing_receipts p ON p.id = (
         SELECT p2.id
           FROM processing_receipts p2
          WHERE p2.processor_key = r.processor_key
            AND p2.processor_version = r.processor_version
            AND p2.scope_id = $1
          ORDER BY COALESCE(p2.finished_at, p2.started_at) DESC, p2.id DESC
          LIMIT 1
       )
      WHERE r.enabled = TRUE AND r.required = TRUE
      ORDER BY r.processor_key`,
    [delivery.delivery_key],
  );

  const failure = processors.find(
    processor => processor.outcome === 'failed' || processor.outcome === 'partial',
  );
  const incomplete = processors.some(
    processor => processor.outcome == null || processor.outcome === 'running',
  );
  const status: ReadinessAssessment['status'] = failure
    ? 'failed'
    : (!delivery.searchable || incomplete ? 'pending' : 'ready');
  const reasonCode = failure
    ? (failure.reason_code ?? 'required_processing_failed')
    : null;
  const assessmentKey = createHash('sha256').update(JSON.stringify({
    version: READINESS_ASSESSMENT_VERSION,
    content_digest: delivery.content_digest,
    searchable: delivery.searchable,
    processors,
  })).digest('hex');

  await engine.executeRaw(
    `INSERT INTO readiness_assessments (
       delivery_receipt_id, assessment_key, assessment_version, status, reason_code
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (delivery_receipt_id, assessment_key) DO NOTHING`,
    [receiptId, assessmentKey, READINESS_ASSESSMENT_VERSION, status, reasonCode],
  );
  return (await loadLatestReadiness(engine, receiptId))!;
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

    await reconcileReadiness(tx, receipt.receipt_id);
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
  const rows = await engine.executeRaw<{ receipt_id: number }>(
    `SELECT id::int AS receipt_id
       FROM delivery_receipts
      WHERE delivery_key = $1 AND source_id = $2`,
    [deliveryKey, opts.sourceId],
  );
  if (!rows[0]) return null;
  return engine.transaction(tx => reconcileReadiness(tx, rows[0]!.receipt_id));
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
