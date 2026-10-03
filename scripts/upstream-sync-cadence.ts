#!/usr/bin/env bun
/**
 * Upstream sync + compatibility cadence policy for the managed fork.
 *
 * Pure, content-free operator tooling. Inputs are refs, versions, dates, and
 * disposition labels — never brain content, credentials, or personal data.
 *
 * Contract (issue #24):
 * - Review upstream only at phase boundaries or on a fixed cadence.
 * - Ledger records adopted / deferred / conflicting (and blocking) changes.
 * - No mid-slice sync unless blocking.
 * - Verification is memory-bounded and change-focused.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CADENCE_LEDGER_SCHEMA = 1 as const;

export type CadenceDisposition =
  | 'adopted'
  | 'deferred'
  | 'conflicting'
  | 'blocking'
  | 'no-op';

export type ReviewTrigger = 'phase-boundary' | 'fixed-cadence' | 'blocking-exception';

export type DriftStatus = 'ok' | 'review_due' | 'pause_feature_work';

export interface CadenceBounds {
  /** Unreviewed upstream releases allowed before feature work pauses. Default 2. */
  maxUnreviewedReleases: number;
  /** Calendar days of unreviewed upstream drift before pause. Default 30. */
  maxUnreviewedDays: number;
  /** Fixed cadence target in days (weekly). Default 7. */
  reviewIntervalDays: number;
}

export const DEFAULT_CADENCE_BOUNDS: CadenceBounds = {
  maxUnreviewedReleases: 2,
  maxUnreviewedDays: 30,
  reviewIntervalDays: 7,
};

export interface ChangeDisposition {
  /** Opaque change id: short sha, PR number, or path family — no content. */
  change_id: string;
  disposition: CadenceDisposition;
  /** Optional content-free operator note. */
  note?: string;
}

export interface MemoryBoundedVerification {
  typecheck: boolean;
  verify: boolean;
  /** Focused test file paths only. Full E2E is out of band. */
  focused_tests: string[];
  /** True when only memory-bounded suites ran (the required default). */
  memory_bounded: boolean;
}

export interface CadenceReview {
  id: string;
  reviewed_at: string; // YYYY-MM-DD or ISO
  trigger: ReviewTrigger;
  fork_head: string;
  upstream_pin: string;
  upstream_head: string;
  dispositions: ChangeDisposition[];
  verification: MemoryBoundedVerification;
  /** Explicit exception for mid-slice sync; requires blocking disposition. */
  mid_slice_exception?: boolean;
  blocking_reason?: string;
}

export interface CadenceLedger {
  schema_version: typeof CADENCE_LEDGER_SCHEMA;
  bounds: CadenceBounds;
  /** Active feature slice label, or null when between slices. */
  active_feature_slice: string | null;
  /** Upstream object last intentionally absorbed into the fork. */
  upstream_pin: string;
  /** Four-part upstream version at pin when known. */
  upstream_version_at_pin?: string;
  last_reviewed_at: string;
  reviews: CadenceReview[];
}

export interface DriftAssessment {
  status: DriftStatus;
  reasons: string[];
  days_since_review: number;
  unreviewed_releases: number | null;
  allow_mid_slice_sync: boolean;
  next_actions: string[];
}

export interface SyncDecision {
  allowed: boolean;
  reason: string;
  mode: 'phase-boundary' | 'fixed-cadence' | 'blocking-exception' | 'denied';
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;
const DISPOSITIONS = new Set<CadenceDisposition>([
  'adopted',
  'deferred',
  'conflicting',
  'blocking',
  'no-op',
]);
const TRIGGERS = new Set<ReviewTrigger>([
  'phase-boundary',
  'fixed-cadence',
  'blocking-exception',
]);

/** Parse YYYY-MM-DD or ISO timestamps into a UTC-midnight Date for day math. */
export function parseReviewDate(value: string, label = 'date'): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  const m = DATE_ONLY.exec(value.trim());
  if (!m) throw new Error(`${label} must start with YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return dt;
}

export function daysBetween(earlier: Date, later: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Compare dotted numeric versions (3 or 4 segments). Returns null when either
 * side is missing or unparseable — callers treat that as "unknown count".
 */
export function countVersionSteps(
  fromVersion: string | undefined,
  toVersion: string | undefined,
): number | null {
  if (!fromVersion || !toVersion) return null;
  const a = parseVersion(fromVersion);
  const b = parseVersion(toVersion);
  if (!a || !b) return null;
  // Count whole release steps as max coordinate distance on MAJOR.MINOR.PATCH,
  // ignoring MICRO so patch-series noise does not inflate the gate.
  const major = Math.abs(b[0] - a[0]);
  const minor = Math.abs(b[1] - a[1]);
  const patch = Math.abs(b[2] - a[2]);
  if (major > 0) return major * 100 + minor; // coarse but monotone
  if (minor > 0) return minor;
  return patch;
}

function parseVersion(v: string): [number, number, number, number] | null {
  const parts = v.trim().replace(/^v/, '').split('.');
  if (parts.length < 3 || parts.length > 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3] ?? 0];
}

export function normalizeBounds(
  partial?: Partial<CadenceBounds> | null,
): CadenceBounds {
  const b = { ...DEFAULT_CADENCE_BOUNDS, ...(partial ?? {}) };
  for (const [k, v] of Object.entries(b) as Array<[keyof CadenceBounds, number]>) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`bounds.${k} must be a non-negative integer`);
    }
  }
  if (b.reviewIntervalDays < 1) {
    throw new Error('bounds.reviewIntervalDays must be >= 1');
  }
  return b;
}

/**
 * Assess unreviewed upstream drift against the standing cadence contract.
 *
 * `blockingException` is the only path that allows mid-slice sync while a
 * feature slice is active.
 */
export function assessDrift(input: {
  lastReviewedAt: string | Date;
  now?: string | Date;
  bounds?: Partial<CadenceBounds>;
  activeFeatureSlice: string | null;
  upstreamVersionAtPin?: string;
  currentUpstreamVersion?: string;
  blockingException?: boolean;
}): DriftAssessment {
  const bounds = normalizeBounds(input.bounds);
  const last =
    input.lastReviewedAt instanceof Date
      ? input.lastReviewedAt
      : parseReviewDate(input.lastReviewedAt, 'lastReviewedAt');
  const now =
    input.now instanceof Date
      ? input.now
      : input.now
        ? parseReviewDate(input.now, 'now')
        : parseReviewDate(new Date().toISOString().slice(0, 10), 'now');

  const days = daysBetween(last, now);
  const releases = countVersionSteps(
    input.upstreamVersionAtPin,
    input.currentUpstreamVersion,
  );
  const reasons: string[] = [];
  const next: string[] = [];

  const pastInterval = days >= bounds.reviewIntervalDays;
  const pastDayCap = days > bounds.maxUnreviewedDays;
  const pastReleaseCap =
    releases !== null && releases > bounds.maxUnreviewedReleases;

  if (pastInterval) {
    reasons.push(
      `last review was ${days}d ago (cadence interval ${bounds.reviewIntervalDays}d)`,
    );
  }
  if (pastDayCap) {
    reasons.push(
      `unreviewed drift ${days}d exceeds max ${bounds.maxUnreviewedDays}d`,
    );
  }
  if (pastReleaseCap) {
    reasons.push(
      `unreviewed releases ${releases} exceed max ${bounds.maxUnreviewedReleases}`,
    );
  }

  let status: DriftStatus = 'ok';
  if (pastDayCap || pastReleaseCap) {
    status = 'pause_feature_work';
    next.push(
      'Pause active feature slices and open a phase-boundary or fixed-cadence reconciliation',
    );
  } else if (pastInterval) {
    status = 'review_due';
    next.push(
      'Schedule a fixed-cadence upstream review; do not merge mid-slice unless blocking',
    );
  } else {
    next.push('Continue feature work; no cadence breach');
  }

  const inSlice =
    typeof input.activeFeatureSlice === 'string' &&
    input.activeFeatureSlice.trim() !== '';
  const allowMid =
    Boolean(input.blockingException) && (inSlice || status !== 'ok');

  if (inSlice && status === 'pause_feature_work' && !input.blockingException) {
    next.push(
      `Active slice "${input.activeFeatureSlice}" must not absorb non-blocking upstream until review closes`,
    );
  }

  return {
    status,
    reasons,
    days_since_review: days,
    unreviewed_releases: releases,
    allow_mid_slice_sync: allowMid,
    next_actions: next,
  };
}

/**
 * Decide whether an upstream merge/sync is permitted right now.
 */
export function decideSync(input: {
  activeFeatureSlice: string | null;
  trigger: ReviewTrigger;
  drift: DriftAssessment;
  hasBlockingDisposition: boolean;
  blockingReason?: string;
}): SyncDecision {
  const inSlice =
    typeof input.activeFeatureSlice === 'string' &&
    input.activeFeatureSlice.trim() !== '';

  if (input.trigger === 'blocking-exception') {
    if (!input.hasBlockingDisposition) {
      return {
        allowed: false,
        reason:
          'blocking-exception requires at least one disposition=blocking change',
        mode: 'denied',
      };
    }
    if (!input.blockingReason || input.blockingReason.trim() === '') {
      return {
        allowed: false,
        reason: 'blocking-exception requires an explicit blocking_reason',
        mode: 'denied',
      };
    }
    return {
      allowed: true,
      reason: `blocking exception: ${input.blockingReason}`,
      mode: 'blocking-exception',
    };
  }

  if (inSlice && input.trigger !== 'phase-boundary') {
    // Fixed-cadence review may still *record* deferred rows while a slice is
    // active, but it must not merge upstream into the slice branch.
    if (input.trigger === 'fixed-cadence') {
      return {
        allowed: false,
        reason:
          'fixed-cadence review during an active feature slice may update the ledger only; merge is deferred to the phase boundary unless blocking',
        mode: 'denied',
      };
    }
  }

  if (input.trigger === 'phase-boundary') {
    return {
      allowed: true,
      reason: 'phase-boundary review may absorb adopted upstream changes',
      mode: 'phase-boundary',
    };
  }

  if (input.trigger === 'fixed-cadence') {
    // Outside an active feature slice (checked above), fixed-cadence may absorb.
    return {
      allowed: true,
      reason:
        'fixed-cadence review outside an active feature slice may absorb adopted changes',
      mode: 'fixed-cadence',
    };
  }

  return {
    allowed: false,
    reason: 'sync denied by cadence policy',
    mode: 'denied',
  };
}

export function validateMemoryBoundedVerification(
  v: MemoryBoundedVerification,
): string[] {
  const errors: string[] = [];
  if (!v || typeof v !== 'object') return ['verification is required'];
  if (v.typecheck !== true) errors.push('verification.typecheck must be true');
  if (v.verify !== true) errors.push('verification.verify must be true');
  if (v.memory_bounded !== true) {
    errors.push('verification.memory_bounded must be true (no all-files claim)');
  }
  if (!Array.isArray(v.focused_tests) || v.focused_tests.length === 0) {
    errors.push('verification.focused_tests must list at least one path');
  } else {
    for (const p of v.focused_tests) {
      if (typeof p !== 'string' || p.trim() === '') {
        errors.push('verification.focused_tests entries must be non-empty paths');
        break;
      }
      if (p.includes('\0') || p.includes('://')) {
        errors.push('verification.focused_tests must be local paths only');
        break;
      }
    }
  }
  return errors;
}

export function validateReview(review: CadenceReview): string[] {
  const errors: string[] = [];
  if (!review || typeof review !== 'object') return ['review is required'];
  if (typeof review.id !== 'string' || review.id.trim() === '') {
    errors.push('review.id is required');
  }
  try {
    parseReviewDate(review.reviewed_at, 'review.reviewed_at');
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (!TRIGGERS.has(review.trigger)) {
    errors.push(`review.trigger must be one of ${[...TRIGGERS].join(', ')}`);
  }
  for (const field of ['fork_head', 'upstream_pin', 'upstream_head'] as const) {
    if (typeof review[field] !== 'string' || review[field].trim() === '') {
      errors.push(`review.${field} is required`);
    }
  }
  if (!Array.isArray(review.dispositions) || review.dispositions.length === 0) {
    errors.push('review.dispositions must include at least one row');
  } else {
    for (const [i, row] of review.dispositions.entries()) {
      if (!row || typeof row.change_id !== 'string' || row.change_id.trim() === '') {
        errors.push(`review.dispositions[${i}].change_id is required`);
      }
      if (!DISPOSITIONS.has(row.disposition)) {
        errors.push(
          `review.dispositions[${i}].disposition must be one of ${[...DISPOSITIONS].join(', ')}`,
        );
      }
    }
  }
  errors.push(...validateMemoryBoundedVerification(review.verification));

  if (review.trigger === 'blocking-exception') {
    const hasBlocking = review.dispositions?.some((d) => d.disposition === 'blocking');
    if (!hasBlocking) {
      errors.push('blocking-exception reviews require a disposition=blocking row');
    }
    if (!review.blocking_reason || review.blocking_reason.trim() === '') {
      errors.push('blocking-exception reviews require blocking_reason');
    }
    if (review.mid_slice_exception !== true) {
      errors.push('blocking-exception reviews must set mid_slice_exception=true');
    }
  } else if (review.mid_slice_exception === true) {
    errors.push('mid_slice_exception is only valid with trigger=blocking-exception');
  }

  return errors;
}

export function validateLedger(ledger: CadenceLedger): string[] {
  const errors: string[] = [];
  if (!ledger || typeof ledger !== 'object') return ['ledger is required'];
  if (ledger.schema_version !== CADENCE_LEDGER_SCHEMA) {
    errors.push(`schema_version must be ${CADENCE_LEDGER_SCHEMA}`);
  }
  try {
    normalizeBounds(ledger.bounds);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (ledger.active_feature_slice !== null) {
    if (
      typeof ledger.active_feature_slice !== 'string' ||
      ledger.active_feature_slice.trim() === ''
    ) {
      errors.push('active_feature_slice must be null or a non-empty string');
    }
  }
  if (typeof ledger.upstream_pin !== 'string' || ledger.upstream_pin.trim() === '') {
    errors.push('upstream_pin is required');
  }
  try {
    parseReviewDate(ledger.last_reviewed_at, 'last_reviewed_at');
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (!Array.isArray(ledger.reviews)) {
    errors.push('reviews must be an array');
  } else {
    for (const [i, review] of ledger.reviews.entries()) {
      for (const err of validateReview(review)) {
        errors.push(`reviews[${i}]: ${err}`);
      }
    }
  }
  return errors;
}

/** Extract the first ```json cadence machine block from a markdown ledger. */
export function extractLedgerJsonFromMarkdown(markdown: string): string {
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const body = match[1]!.trim();
    if (body.includes('"schema_version"') && body.includes('"reviews"')) {
      return body;
    }
  }
  throw new Error('no cadence ledger JSON block found in markdown');
}

export function loadLedgerFromMarkdown(markdown: string): CadenceLedger {
  const raw = JSON.parse(extractLedgerJsonFromMarkdown(markdown)) as CadenceLedger;
  const errors = validateLedger(raw);
  if (errors.length > 0) {
    throw new Error(`invalid cadence ledger:\n- ${errors.join('\n- ')}`);
  }
  return raw;
}

export function loadLedgerFromPath(path: string): CadenceLedger {
  const abs = resolve(path);
  const text = readFileSync(abs, 'utf8');
  if (abs.endsWith('.json')) {
    const raw = JSON.parse(text) as CadenceLedger;
    const errors = validateLedger(raw);
    if (errors.length > 0) {
      throw new Error(`invalid cadence ledger:\n- ${errors.join('\n- ')}`);
    }
    return raw;
  }
  return loadLedgerFromMarkdown(text);
}

export function assessLedger(
  ledger: CadenceLedger,
  opts: {
    now?: string | Date;
    currentUpstreamVersion?: string;
    blockingException?: boolean;
  } = {},
): DriftAssessment {
  return assessDrift({
    lastReviewedAt: ledger.last_reviewed_at,
    now: opts.now,
    bounds: ledger.bounds,
    activeFeatureSlice: ledger.active_feature_slice,
    upstreamVersionAtPin: ledger.upstream_version_at_pin,
    currentUpstreamVersion: opts.currentUpstreamVersion,
    blockingException: opts.blockingException,
  });
}

// --- CLI (content-free) ----------------------------------------------------

function printHelp(): void {
  console.log(`Usage:
  bun scripts/upstream-sync-cadence.ts validate --ledger <path>
  bun scripts/upstream-sync-cadence.ts assess --ledger <path> [--now YYYY-MM-DD] [--upstream-version X.Y.Z.W] [--blocking]
  bun scripts/upstream-sync-cadence.ts decide --ledger <path> --trigger <phase-boundary|fixed-cadence|blocking-exception> [--blocking-reason TEXT] [--now YYYY-MM-DD] [--upstream-version X.Y.Z.W]

Outputs JSON only. Never prints brain content or credentials.`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { _: argv[0] ?? '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--blocking') {
      out.blocking = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function main(argv: string[]): number {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    printHelp();
    return 0;
  }
  const cmd = argv[0]!;
  const args = parseArgs(argv);
  const ledgerPath = String(args.ledger ?? 'docs/operations/upstream-sync-ledger.md');

  try {
    if (cmd === 'validate') {
      const ledger = loadLedgerFromPath(ledgerPath);
      console.log(
        JSON.stringify(
          {
            ok: true,
            schema_version: ledger.schema_version,
            review_count: ledger.reviews.length,
            last_reviewed_at: ledger.last_reviewed_at,
            active_feature_slice: ledger.active_feature_slice,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (cmd === 'assess') {
      const ledger = loadLedgerFromPath(ledgerPath);
      const assessment = assessLedger(ledger, {
        now: typeof args.now === 'string' ? args.now : undefined,
        currentUpstreamVersion:
          typeof args['upstream-version'] === 'string'
            ? args['upstream-version']
            : undefined,
        blockingException: args.blocking === true,
      });
      console.log(JSON.stringify({ ok: true, assessment }, null, 2));
      return assessment.status === 'pause_feature_work' ? 2 : 0;
    }

    if (cmd === 'decide') {
      const ledger = loadLedgerFromPath(ledgerPath);
      const trigger = String(args.trigger ?? '') as ReviewTrigger;
      if (!TRIGGERS.has(trigger)) {
        throw new Error(
          `--trigger must be one of ${[...TRIGGERS].join(', ')}`,
        );
      }
      const assessment = assessLedger(ledger, {
        now: typeof args.now === 'string' ? args.now : undefined,
        currentUpstreamVersion:
          typeof args['upstream-version'] === 'string'
            ? args['upstream-version']
            : undefined,
        blockingException: trigger === 'blocking-exception',
      });
      const hasBlocking =
        trigger === 'blocking-exception' ||
        ledger.reviews.some((r) =>
          r.dispositions.some((d) => d.disposition === 'blocking'),
        );
      const decision = decideSync({
        activeFeatureSlice: ledger.active_feature_slice,
        trigger,
        drift: assessment,
        hasBlockingDisposition: hasBlocking,
        blockingReason:
          typeof args['blocking-reason'] === 'string'
            ? args['blocking-reason']
            : undefined,
      });
      console.log(JSON.stringify({ ok: decision.allowed, decision, assessment }, null, 2));
      return decision.allowed ? 0 : 1;
    }

    printHelp();
    return 1;
  } catch (e) {
    console.log(
      JSON.stringify(
        { ok: false, error: (e as Error).message },
        null,
        2,
      ),
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
