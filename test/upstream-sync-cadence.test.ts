/**
 * Focused tests for the managed-fork upstream sync cadence policy (#24).
 * Pure policy + ledger parse — no engines, credentials, or brain content.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessDrift,
  assessLedger,
  countVersionSteps,
  daysBetween,
  decideSync,
  DEFAULT_CADENCE_BOUNDS,
  loadLedgerFromMarkdown,
  loadLedgerFromPath,
  parseReviewDate,
  validateLedger,
  validateReview,
  type CadenceLedger,
  type CadenceReview,
} from '../scripts/upstream-sync-cadence.ts';

const repoRoot = join(import.meta.dir, '..');
const ledgerPath = join(repoRoot, 'docs/operations/upstream-sync-ledger.md');

function sampleReview(
  overrides: Partial<CadenceReview> = {},
): CadenceReview {
  return {
    id: 'r1',
    reviewed_at: '2026-07-23',
    trigger: 'phase-boundary',
    fork_head: '0.42.64.1',
    upstream_pin: 'origin/master@bb5a6694',
    upstream_head: 'origin/master@bb5a6694',
    dispositions: [
      { change_id: 'baseline', disposition: 'adopted' },
      { change_id: 'later', disposition: 'deferred' },
    ],
    verification: {
      typecheck: true,
      verify: true,
      memory_bounded: true,
      focused_tests: ['test/upstream-sync-cadence.test.ts'],
    },
    ...overrides,
  };
}

function sampleLedger(overrides: Partial<CadenceLedger> = {}): CadenceLedger {
  return {
    schema_version: 1,
    bounds: { ...DEFAULT_CADENCE_BOUNDS },
    active_feature_slice: 'phase-2a',
    upstream_pin: 'origin/master@bb5a6694',
    upstream_version_at_pin: '0.42.64.0',
    last_reviewed_at: '2026-07-23',
    reviews: [sampleReview()],
    ...overrides,
  };
}

describe('upstream-sync-cadence dates and versions', () => {
  test('parseReviewDate accepts YYYY-MM-DD and rejects garbage', () => {
    const d = parseReviewDate('2026-07-23');
    expect(d.toISOString().startsWith('2026-07-23')).toBe(true);
    expect(() => parseReviewDate('07/23/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => parseReviewDate('2026-13-01')).toThrow(/valid calendar/);
  });

  test('daysBetween is whole UTC days', () => {
    const a = parseReviewDate('2026-07-23');
    const b = parseReviewDate('2026-08-02');
    expect(daysBetween(a, b)).toBe(10);
  });

  test('countVersionSteps measures patch/minor distance and ignores noise', () => {
    expect(countVersionSteps('0.42.64.0', '0.42.66.0')).toBe(2);
    expect(countVersionSteps('0.42.64.0', '0.42.64.1')).toBe(0);
    expect(countVersionSteps('0.42.64.0', '0.43.0.0')).toBe(1);
    expect(countVersionSteps(undefined, '0.42.66.0')).toBeNull();
    expect(countVersionSteps('not-a-version', '0.42.66.0')).toBeNull();
  });
});

describe('upstream-sync-cadence assessDrift', () => {
  test('ok inside the weekly window', () => {
    const a = assessDrift({
      lastReviewedAt: '2026-07-23',
      now: '2026-07-25',
      activeFeatureSlice: 'phase-2a',
      upstreamVersionAtPin: '0.42.64.0',
      currentUpstreamVersion: '0.42.64.0',
    });
    expect(a.status).toBe('ok');
    expect(a.allow_mid_slice_sync).toBe(false);
    expect(a.days_since_review).toBe(2);
  });

  test('review_due after the cadence interval but under hard caps', () => {
    const a = assessDrift({
      lastReviewedAt: '2026-07-23',
      now: '2026-07-31',
      activeFeatureSlice: 'phase-2a',
      upstreamVersionAtPin: '0.42.64.0',
      currentUpstreamVersion: '0.42.65.0',
    });
    expect(a.status).toBe('review_due');
    expect(a.unreviewed_releases).toBe(1);
    expect(a.allow_mid_slice_sync).toBe(false);
  });

  test('pause_feature_work when release or day caps are exceeded', () => {
    const byRelease = assessDrift({
      lastReviewedAt: '2026-07-23',
      now: '2026-07-28',
      activeFeatureSlice: 'phase-2a',
      upstreamVersionAtPin: '0.42.64.0',
      currentUpstreamVersion: '0.42.67.0',
    });
    expect(byRelease.status).toBe('pause_feature_work');
    expect(byRelease.unreviewed_releases).toBe(3);

    const byDays = assessDrift({
      lastReviewedAt: '2026-07-23',
      now: '2026-08-25',
      activeFeatureSlice: null,
      upstreamVersionAtPin: '0.42.64.0',
      currentUpstreamVersion: '0.42.64.0',
    });
    expect(byDays.status).toBe('pause_feature_work');
    expect(byDays.days_since_review).toBe(33);
  });

  test('blocking exception is the only mid-slice allow path', () => {
    const a = assessDrift({
      lastReviewedAt: '2026-07-23',
      now: '2026-07-25',
      activeFeatureSlice: 'phase-2a',
      blockingException: true,
    });
    expect(a.allow_mid_slice_sync).toBe(true);
  });
});

describe('upstream-sync-cadence decideSync', () => {
  const idleDrift = assessDrift({
    lastReviewedAt: '2026-07-23',
    now: '2026-07-25',
    activeFeatureSlice: null,
  });

  test('phase-boundary may absorb even during an active slice', () => {
    const d = decideSync({
      activeFeatureSlice: 'phase-2a',
      trigger: 'phase-boundary',
      drift: idleDrift,
      hasBlockingDisposition: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.mode).toBe('phase-boundary');
  });

  test('fixed-cadence merge is denied while a feature slice is active', () => {
    const d = decideSync({
      activeFeatureSlice: 'phase-2a',
      trigger: 'fixed-cadence',
      drift: idleDrift,
      hasBlockingDisposition: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe('denied');
    expect(d.reason).toMatch(/ledger only/i);
  });

  test('fixed-cadence merge is allowed when no slice is active', () => {
    const d = decideSync({
      activeFeatureSlice: null,
      trigger: 'fixed-cadence',
      drift: idleDrift,
      hasBlockingDisposition: false,
    });
    expect(d.allowed).toBe(true);
    expect(d.mode).toBe('fixed-cadence');
  });

  test('blocking-exception requires disposition + reason', () => {
    const missing = decideSync({
      activeFeatureSlice: 'phase-2a',
      trigger: 'blocking-exception',
      drift: idleDrift,
      hasBlockingDisposition: false,
      blockingReason: 'urgent',
    });
    expect(missing.allowed).toBe(false);

    const noReason = decideSync({
      activeFeatureSlice: 'phase-2a',
      trigger: 'blocking-exception',
      drift: idleDrift,
      hasBlockingDisposition: true,
    });
    expect(noReason.allowed).toBe(false);

    const ok = decideSync({
      activeFeatureSlice: 'phase-2a',
      trigger: 'blocking-exception',
      drift: idleDrift,
      hasBlockingDisposition: true,
      blockingReason: 'security fix required before slice ship',
    });
    expect(ok.allowed).toBe(true);
    expect(ok.mode).toBe('blocking-exception');
  });
});

describe('upstream-sync-cadence ledger validation', () => {
  test('valid sample ledger passes', () => {
    expect(validateLedger(sampleLedger())).toEqual([]);
  });

  test('review must record memory-bounded verification and dispositions', () => {
    const bad = sampleReview({
      dispositions: [],
      verification: {
        typecheck: false,
        verify: true,
        memory_bounded: false,
        focused_tests: [],
      },
    });
    const errors = validateReview(bad);
    expect(errors.some((e) => e.includes('dispositions'))).toBe(true);
    expect(errors.some((e) => e.includes('typecheck'))).toBe(true);
    expect(errors.some((e) => e.includes('memory_bounded'))).toBe(true);
    expect(errors.some((e) => e.includes('focused_tests'))).toBe(true);
  });

  test('blocking-exception review shape is fail-closed', () => {
    const errors = validateReview(
      sampleReview({
        trigger: 'blocking-exception',
        mid_slice_exception: true,
        dispositions: [{ change_id: 'cve', disposition: 'adopted' }],
      }),
    );
    expect(errors.some((e) => e.includes('disposition=blocking'))).toBe(true);
    expect(errors.some((e) => e.includes('blocking_reason'))).toBe(true);
  });

  test('mid_slice_exception is invalid outside blocking-exception', () => {
    const errors = validateReview(
      sampleReview({ mid_slice_exception: true }),
    );
    expect(errors.some((e) => e.includes('mid_slice_exception'))).toBe(true);
  });
});

describe('upstream-sync-cadence standing ledger fixture', () => {
  test('docs/operations/upstream-sync-ledger.md machine block validates', () => {
    const md = readFileSync(ledgerPath, 'utf8');
    const ledger = loadLedgerFromMarkdown(md);
    expect(ledger.schema_version).toBe(1);
    expect(ledger.bounds).toEqual(DEFAULT_CADENCE_BOUNDS);
    expect(ledger.reviews.length).toBeGreaterThanOrEqual(1);
    expect(ledger.reviews[0]!.dispositions.some((d) => d.disposition === 'adopted')).toBe(true);
    expect(ledger.reviews[0]!.dispositions.some((d) => d.disposition === 'deferred')).toBe(true);
    expect(validateLedger(ledger)).toEqual([]);
  });

  test('loadLedgerFromPath and assessLedger work on the standing file', () => {
    const ledger = loadLedgerFromPath(ledgerPath);
    const assessment = assessLedger(ledger, {
      now: '2026-07-25',
      currentUpstreamVersion: '0.42.64.0',
    });
    expect(assessment.status).toBe('ok');
    expect(assessment.allow_mid_slice_sync).toBe(false);
  });

  test('active phase-2a slice denies fixed-cadence merge via decide policy', () => {
    const ledger = loadLedgerFromPath(ledgerPath);
    const drift = assessLedger(ledger, { now: '2026-07-25' });
    const decision = decideSync({
      activeFeatureSlice: ledger.active_feature_slice,
      trigger: 'fixed-cadence',
      drift,
      hasBlockingDisposition: false,
    });
    expect(ledger.active_feature_slice).toBe('phase-2a');
    expect(decision.allowed).toBe(false);
  });
});

describe('upstream-sync-cadence CLI smoke', () => {
  test('validate exits 0 on the standing ledger', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        join(repoRoot, 'scripts/upstream-sync-cadence.ts'),
        'validate',
        '--ledger',
        ledgerPath,
      ],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout.toString());
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe(1);
  });

  test('assess exit 2 when pause_feature_work', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        join(repoRoot, 'scripts/upstream-sync-cadence.ts'),
        'assess',
        '--ledger',
        ledgerPath,
        '--now',
        '2026-09-01',
        '--upstream-version',
        '0.42.70.0',
      ],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout.toString());
    expect(body.assessment.status).toBe('pause_feature_work');
  });

  test('decide fixed-cadence while slice active exits 1', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        join(repoRoot, 'scripts/upstream-sync-cadence.ts'),
        'decide',
        '--ledger',
        ledgerPath,
        '--trigger',
        'fixed-cadence',
        '--now',
        '2026-07-25',
      ],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout.toString());
    expect(body.ok).toBe(false);
    expect(body.decision.mode).toBe('denied');
  });
});
