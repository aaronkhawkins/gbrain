/**
 * Collector evaluation isolation (U3 scenarios that do not need a live DB).
 */
import { describe, test, expect } from 'bun:test';
import {
  buildExpectedWorkRegistry,
  evaluateWorkItem,
  dreamPhaseWorkKey,
} from '../../../src/core/observability/expected-work.ts';
import { rollupBrainState } from '../../../src/core/observability/rollup.ts';
import type { WorkEvidence } from '../../../src/core/observability/types.ts';

const NOW = new Date('2026-07-23T12:00:00.000Z');

describe('phase isolation', () => {
  test('healthy source + late extract_atoms fails only that enhancement', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: ['wiki'],
      enabledDreamPhases: ['sync', 'extract_atoms'],
      includeInfrastructure: false,
    });
    const byKey = new Map(reg.map((e) => [e.key, e]));

    const sourceEv: WorkEvidence = {
      last_attempt_at: NOW.toISOString(),
      last_success_at: NOW.toISOString(),
      backlog_items: 0,
      oldest_pending_age_seconds: 0,
      recent_failures: 0,
      force_state: 'healthy',
      force_reason: 'ok',
    };
    const latePhase: WorkEvidence = {
      last_attempt_at: '2026-07-20T12:00:00.000Z',
      last_success_at: '2026-07-20T12:00:00.000Z',
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    };

    const items = reg.map((e) => {
      if (e.kind === 'source') return evaluateWorkItem(e, sourceEv, NOW);
      if (e.key === dreamPhaseWorkKey('extract_atoms')) return evaluateWorkItem(e, latePhase, NOW);
      if (e.key === dreamPhaseWorkKey('sync')) return evaluateWorkItem(e, sourceEv, NOW);
      return evaluateWorkItem(e, null, NOW);
    });

    const source = items.find((i) => i.key === 'source.wiki')!;
    const atoms = items.find((i) => i.key === dreamPhaseWorkKey('extract_atoms'))!;
    expect(source.state).toBe('healthy');
    expect(atoms.state).toBe('failed');
    expect(rollupBrainState(items)).toBe('failed');
    void byKey;
  });

  test('dead job forces failed for that minion only', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });
    const cycle = reg.find((e) => e.key === 'minion.autopilot-cycle')!;
    const global = reg.find((e) => e.key === 'minion.autopilot-global-maintenance')!;

    const dead: WorkEvidence = {
      last_attempt_at: NOW.toISOString(),
      last_success_at: '2026-07-23T11:00:00.000Z',
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 1,
      force_state: 'failed',
      force_reason: 'dead',
    };
    const ok: WorkEvidence = {
      last_attempt_at: NOW.toISOString(),
      last_success_at: NOW.toISOString(),
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
    };

    const a = evaluateWorkItem(cycle, dead, NOW);
    const b = evaluateWorkItem(global, ok, NOW);
    expect(a.state).toBe('failed');
    expect(a.reason).toBe('dead');
    expect(b.state).toBe('healthy');
  });

  test('embedding identity mismatch fails even with zero backlog', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: true,
    });
    const emb = reg.find((e) => e.key === 'retrieval.identity')!;
    const obs = evaluateWorkItem(emb, {
      last_attempt_at: NOW.toISOString(),
      last_success_at: null,
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 1,
      force_state: 'failed',
      force_reason: 'embedding_mismatch',
    }, NOW);
    expect(obs.state).toBe('failed');
    expect(obs.reason).toBe('embedding_mismatch');
  });

  test('missing local supervisor evidence is unknown not healthy', () => {
    const reg = buildExpectedWorkRegistry({
      sourceIds: [],
      enabledDreamPhases: [],
      includeInfrastructure: true,
    });
    const sup = reg.find((e) => e.key === 'runtime.supervisor')!;
    const obs = evaluateWorkItem(sup, {
      last_attempt_at: null,
      last_success_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    }, NOW);
    expect(obs.state).toBe('unknown');
    expect(obs.state).not.toBe('healthy');
  });
});
