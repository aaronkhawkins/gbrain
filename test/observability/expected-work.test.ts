/**
 * Expected-work registry + cadence evaluation (U1).
 */
import { describe, test, expect } from 'bun:test';
import {
  buildExpectedWorkRegistry,
  evaluateWorkItem,
  assertExportableSnapshot,
  resolveEnabledDreamPhases,
  sourceWorkKey,
  dreamPhaseWorkKey,
  minionWorkKey,
} from '../../src/core/observability/expected-work.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../../src/core/observability/types.ts';

const NOW = new Date('2026-07-23T12:00:00.000Z');

function entry(partial: Partial<ExpectedWorkEntry> & Pick<ExpectedWorkEntry, 'key'>): ExpectedWorkEntry {
  return {
    kind: 'minion',
    enabled: true,
    required: true,
    criticality: 'required',
    cadence_seconds: 3600,
    grace_seconds: 600,
    evidence_adapter: 'minion_job',
    selector: partial.key,
    ...partial,
  };
}

describe('buildExpectedWorkRegistry', () => {
  test('discovers source-scoped Dream/Minion work and global phases from scheduler registrations', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: ['wiki', 'notes'],
      enabledDreamPhases: ['sync', 'extract_atoms', 'embed'],
    });
    const keys = reg.map((e) => e.key);
    expect(keys).toContain(sourceWorkKey('wiki'));
    expect(keys).toContain(sourceWorkKey('notes'));
    expect(keys).toContain(dreamPhaseWorkKey('extract_atoms', 'wiki'));
    expect(keys).toContain(dreamPhaseWorkKey('extract_atoms', 'notes'));
    expect(keys).toContain(dreamPhaseWorkKey('embed'));
    expect(keys).toContain(minionWorkKey('autopilot-cycle', 'wiki'));
    expect(keys).toContain(minionWorkKey('autopilot-cycle', 'notes'));
    expect(keys).toContain(minionWorkKey('autopilot-global-maintenance'));
    expect(keys).not.toContain(minionWorkKey('embed-backfill'));
    expect(keys).toContain('embedding.coverage');
    expect(keys).toContain('retrieval.identity');
    expect(keys).toContain('runtime.supervisor');
  });

  test('adds generic fact/link evidence for each source', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });
    expect(reg).toContainEqual(expect.objectContaining({
      key: 'facts.pending.wiki',
      evidence_adapter: 'facts',
      selector: 'wiki',
    }));
    expect(reg).toContainEqual(expect.objectContaining({
      key: 'links.extraction.wiki',
      evidence_adapter: 'links',
      selector: 'wiki',
    }));
  });

  test('discovery failures remain visible as partial unknown axes', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: false,
      discoveryFailures: ['sources'],
    });
    const discovery = reg.find((e) => e.key === 'discovery.sources');
    expect(discovery).toBeDefined();
    expect(discovery!.evidence_adapter).toBe('discovery');
    const obs = evaluateWorkItem(discovery!, {
      last_attempt_at: null,
      last_success_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    }, NOW);
    expect(obs.state).toBe('unknown');
    expect(obs.reason).toBe('evidence_unavailable');
  });

  test('external_work without adapter is instrumentation_missing path', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: false,
      observability: {
        external_work: [{ key: 'transcript_processor', required: true }],
      },
    });
    const ext = reg.find((e) => e.key.includes('transcript'));
    expect(ext).toBeDefined();
    expect(ext!.evidence_adapter).toBe('none');
    const obs = evaluateWorkItem(ext!, null, NOW);
    expect(obs.state).toBe('unknown');
    expect(obs.reason).toBe('instrumentation_missing');
  });

  test('external processor reuses an existing durable Minion registration', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: false,
      observability: {
        external_work: [{
          key: 'transcript_processor',
          required: true,
          evidence: { adapter: 'minion_job', selector: 'process-transcript' },
        }],
      },
    });
    const ext = reg.find((e) => e.key.includes('transcript'))!;
    expect(ext.evidence_adapter).toBe('minion_job');
    expect(ext.selector).toBe('process-transcript');
  });

  test('policy override can disable a required item', () => {
    const key = sourceWorkKey('wiki');
    const reg = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
      observability: {
        work: { [key]: { enabled: false } },
      },
    });
    const e = reg.find((x) => x.key === key)!;
    expect(e.enabled).toBe(false);
    const obs = evaluateWorkItem(e, null, NOW);
    expect(obs.state).toBe('disabled');
  });
});

describe('evaluateWorkItem cadence', () => {
  test('required daily item with fresh success is healthy and reports next due', () => {
    const e = entry({
      key: 'minion.autopilot-cycle',
      cadence_seconds: 24 * 3600,
      grace_seconds: 3600,
    });
    const evidence: WorkEvidence = {
      last_attempt_at: '2026-07-23T10:00:00.000Z',
      last_success_at: '2026-07-23T10:00:00.000Z',
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    };
    const obs = evaluateWorkItem(e, evidence, NOW);
    expect(obs.state).toBe('healthy');
    expect(obs.reason).toBe('ok');
    expect(obs.next_due_at).toBe('2026-07-24T10:00:00.000Z');
  });

  test('missing success inside grace is degraded; after grace it is failed', () => {
    const e = entry({
      key: 'minion.job',
      cadence_seconds: 3600,
      grace_seconds: 600,
    });
    // 3700s old → past cadence (3600) but inside grace (600)
    const insideGrace: WorkEvidence = {
      last_attempt_at: '2026-07-23T10:58:00.000Z',
      last_success_at: '2026-07-23T10:58:00.000Z',
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    };
    // NOW is 12:00; success at 10:58 → age 3720s → cadence 3600 + grace 600 = 4200 → degraded
    expect(evaluateWorkItem(e, insideGrace, NOW).state).toBe('degraded');
    expect(evaluateWorkItem(e, insideGrace, NOW).reason).toBe('within_grace');

    // 5000s old → failed
    const pastGrace: WorkEvidence = {
      last_attempt_at: '2026-07-23T10:30:00.000Z',
      last_success_at: '2026-07-23T10:30:00.000Z',
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    };
    expect(evaluateWorkItem(e, pastGrace, NOW).state).toBe('failed');
    expect(evaluateWorkItem(e, pastGrace, NOW).reason).toBe('missed_cadence');
  });

  test('enabled item with no adapter is unknown with instrumentation_missing', () => {
    const e = entry({
      key: 'external.foo',
      evidence_adapter: 'none',
    });
    const obs = evaluateWorkItem(e, null, NOW);
    expect(obs.state).toBe('unknown');
    expect(obs.reason).toBe('instrumentation_missing');
  });

  test('explicitly disabled item does not degrade evaluation', () => {
    const e = entry({ key: 'minion.x', enabled: false });
    const obs = evaluateWorkItem(e, null, NOW);
    expect(obs.state).toBe('disabled');
  });
});

describe('assertExportableSnapshot', () => {
  test('rejects private-looking brain ids and unregistered states', () => {
    expect(() =>
      assertExportableSnapshot({
        brain: 'not a valid id!!!',
        state: 'healthy',
        items: [],
      }),
    ).toThrow(/invalid brain/);

    expect(() =>
      assertExportableSnapshot({
        brain: 'personal',
        state: 'totally_fine',
        items: [],
      }),
    ).toThrow(/unregistered brain state/);

    expect(() =>
      assertExportableSnapshot({
        brain: 'personal',
        state: 'healthy',
        items: [{ key: 'minion.x', state: 'healthy', reason: 'ok' }],
      }),
    ).not.toThrow();
  });
});

describe('resolveEnabledDreamPhases', () => {
  test('includes core + pack + opt-in when enabled', () => {
    const phases = resolveEnabledDreamPhases({
      packPhases: ['extract_atoms'],
      phaseEnabled: { skillopt: true, enrich_thin: false },
    });
    expect(phases).toContain('sync');
    expect(phases).toContain('extract_atoms');
    expect(phases).toContain('skillopt');
    expect(phases).not.toContain('enrich_thin');
  });
});
