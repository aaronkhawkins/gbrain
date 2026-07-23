/**
 * Expected-work registry + cadence evaluation.
 *
 * Discovery order (KTD4):
 *   1. Registered sources (IngestionSource / sources table)
 *   2. Active-pack Dream phases + core cycle phases that are enabled
 *   3. Scheduler-owned recurring Minion registrations
 *   4. Generic fact/link projections over existing durable evidence
 *   5. Infrastructure (embedding, retrieval, local runtime)
 *   6. Explicit external_work declarations
 *
 * Per-brain observability.work overrides adjust policy without re-declaring work.
 */

import type {
  ExpectedWorkEntry,
  ExternalWorkDeclaration,
  ObservabilityConfig,
  OperationalState,
  WorkEvidence,
  WorkObservation,
  WorkPolicyOverride,
  RegisteredProcessorWork,
} from './types.ts';
import { createHmac } from 'node:crypto';
import {
  OBSERVABILITY_WARNING_CODES,
  OPERATIONAL_STATES,
  WORK_KINDS,
} from './types.ts';
import {
  defaultRunbookForReason,
  REASON_CODES,
  type ReasonCode,
} from './reason-codes.ts';
import type { CyclePhase } from '../cycle.ts';
import { ALL_PHASES, PHASE_SCOPE } from '../cycle.ts';
import {
  getAutopilotRecurringRegistrations,
  type RecurringMinionRegistration,
} from '../minions/recurring-work.ts';
import { stateSeverity } from './rollup.ts';

/** Default cadences (seconds). Tuned for typical single-operator brains. */
export const DEFAULT_CADENCE = {
  /** Source sync — quiet sources stay healthy via commit-relative lag. */
  source: 24 * 60 * 60,
  /** Full dream / autopilot cycle. */
  dream_cycle: 60 * 60,
  /** Per-phase evidence rides the cycle cadence. */
  dream_phase: 60 * 60,
  /** Embedding catch-up is continuous; evaluate via backlog thresholds. */
  embedding: null as number | null,
  /** Retrieval identity is continuous. */
  retrieval: null as number | null,
  /** Supervisor/worker freshness. */
  local_runtime: 10 * 60,
} as const;

export const DEFAULT_GRACE = {
  source: 6 * 60 * 60,
  dream_phase: 30 * 60,
  minion: 30 * 60,
  local_runtime: 5 * 60,
  embedding: 0,
  retrieval: 0,
} as const;

/** Core phases that always participate when the cycle runs (not pack-gated). */
export const CORE_DREAM_PHASES: readonly CyclePhase[] = [
  'sync',
  'extract',
  'extract_facts',
  'embed',
  'orphans',
] as const;

/** Sanitize a bounded non-private id into a stable work-key segment. */
export function sanitizeWorkSegment(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return 'unnamed';
  return s.slice(0, 64);
}

/**
 * Derive a stable, privacy-safe source label for one brain.
 *
 * The raw source id remains available only in entry selectors/scopes. Exported
 * work keys use this keyed digest so Prometheus/Grafana labels cannot retain
 * client, project, or repository names.
 */
export function opaqueSourceSegment(sourceId: string, sourceLabelKey: string): string {
  if (!sourceLabelKey) {
    throw new Error('observability source label key is required');
  }
  return `s_${createHmac('sha256', sourceLabelKey)
    .update('gbrain-observability-source-v1\0')
    .update(sourceId)
    .digest('hex')
    .slice(0, 16)}`;
}

export function sourceWorkKey(sourceId: string, sourceLabelKey: string): string {
  return `source.${opaqueSourceSegment(sourceId, sourceLabelKey)}`;
}

export function dreamPhaseWorkKey(
  phase: string,
  sourceId?: string,
  sourceLabelKey?: string,
): string {
  const base = `dream.${sanitizeWorkSegment(phase)}`;
  return sourceId
    ? `${base}.${opaqueSourceSegment(sourceId, sourceLabelKey ?? '')}`
    : base;
}

export function minionWorkKey(
  jobName: string,
  sourceId?: string,
  sourceLabelKey?: string,
): string {
  const base = `minion.${sanitizeWorkSegment(jobName)}`;
  return sourceId
    ? `${base}.${opaqueSourceSegment(sourceId, sourceLabelKey ?? '')}`
    : base;
}

export type DiscoveryAxis = 'sources' | 'dream_phases' | 'processors';

export interface RegistryInput {
  /** Registered source ids from the brain DB. */
  sourceIds: string[];
  /** Per-brain secret material used only to HMAC exported source labels. */
  sourceLabelKey?: string;
  /**
   * Enabled dream phases for this brain. Callers pass pack-declared phases
   * unioned with core phases and config-enabled opt-in phases.
   */
  enabledDreamPhases: string[];
  /** Sources with scheduler-owned recurring cycles (normally local-path sources). */
  scheduledSourceIds?: string[];
  /** Scheduler registrations/cadence. Defaults to the native autopilot registry. */
  recurringMinions?: RecurringMinionRegistration[];
  registeredProcessors?: RegisteredProcessorWork[];
  /** Axes that could not be discovered and must stay visibly unknown. */
  discoveryFailures?: DiscoveryAxis[];
  /** Config-disabled phases (explicit off). */
  disabledDreamPhases?: string[];
  /** Observability config overrides. */
  observability?: ObservabilityConfig | null;
  /** When true, include embedding + retrieval infrastructure entries. */
  includeInfrastructure?: boolean;
}

/**
 * Build the expected-work registry. Pure — no DB. Callers supply discovered
 * sources and phases.
 */
export function buildExpectedWorkRegistry(input: RegistryInput): ExpectedWorkEntry[] {
  const entries: ExpectedWorkEntry[] = [];
  const obs = input.observability ?? {};
  const includeInfra = input.includeInfrastructure !== false;
  if (input.sourceIds.length > 0 && !input.sourceLabelKey) {
    throw new Error('observability source label key is required for source-scoped work');
  }

  for (const sourceId of input.sourceIds) {
    const key = sourceWorkKey(sourceId, input.sourceLabelKey!);
    entries.push(applyOverride({
      key,
      kind: 'source',
      enabled: true,
      required: true,
      criticality: 'required',
      cadence_seconds: DEFAULT_CADENCE.source,
      grace_seconds: DEFAULT_GRACE.source,
      evidence_adapter: 'ingestion_source',
      selector: sourceId,
      backlog_warn: 50,
      backlog_fail: 500,
      repair_runbook: 'missed-work',
    }, obs.work?.[key]));
  }

  const disabledPhases = new Set(input.disabledDreamPhases ?? []);
  for (const phase of input.enabledDreamPhases) {
    if (disabledPhases.has(phase)) continue;
    const phaseScope = PHASE_SCOPE[phase as CyclePhase] ?? 'global';
    const dreamSourceIds = input.scheduledSourceIds ?? input.sourceIds;
    const sourceScoped = phaseScope !== 'global' && dreamSourceIds.length > 0;
    const scopes: Array<{ type: 'global' } | { type: 'source'; source_id: string }> =
      sourceScoped
        ? dreamSourceIds.map((sourceId) => ({ type: 'source', source_id: sourceId }))
        : [{ type: 'global' }];
    for (const scope of scopes) {
      const sourceId = scope.type === 'source' ? scope.source_id : undefined;
      const key = dreamPhaseWorkKey(phase, sourceId, input.sourceLabelKey);
      entries.push(applyOverride({
        key,
        kind: 'dream_phase',
        enabled: true,
        required: true,
        criticality: 'required',
        cadence_seconds: DEFAULT_CADENCE.dream_phase,
        grace_seconds: DEFAULT_GRACE.dream_phase,
        evidence_adapter: 'dream_phase',
        selector: phase,
        scope,
        repair_runbook: 'missed-work',
      }, obs.work?.[key]));
    }
  }

  const recurringMinions = input.recurringMinions ?? getAutopilotRecurringRegistrations({
    scheduledSourceIds: input.scheduledSourceIds ?? input.sourceIds,
  });
  for (const job of recurringMinions) {
    const sourceId = job.scope.type === 'source' ? job.scope.source_id : undefined;
    const key = minionWorkKey(job.name, sourceId, input.sourceLabelKey);
    entries.push(applyOverride({
      key,
      kind: 'minion',
      enabled: true,
      required: job.required,
      criticality: job.required ? 'required' : 'optional',
      cadence_seconds: job.cadence_seconds,
      grace_seconds: job.grace_seconds,
      evidence_adapter: 'minion_job',
      selector: job.name,
      scope: job.scope,
      repair_runbook: 'missed-work',
    }, obs.work?.[key]));
  }

  for (const sourceId of input.sourceIds) {
    const segment = opaqueSourceSegment(sourceId, input.sourceLabelKey!);
    const factKey = `facts.pending.${segment}`;
    entries.push(applyOverride({
      key: factKey,
      kind: 'fact',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: null,
      grace_seconds: 0,
      evidence_adapter: 'facts',
      selector: sourceId,
      scope: { type: 'source', source_id: sourceId },
      backlog_warn: 100,
      backlog_fail: 1_000,
      repair_runbook: 'backlog',
    }, obs.work?.[factKey]));

    const linkKey = `links.extraction.${segment}`;
    entries.push(applyOverride({
      key: linkKey,
      kind: 'link',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: null,
      grace_seconds: 0,
      evidence_adapter: 'links',
      selector: sourceId,
      scope: { type: 'source', source_id: sourceId },
      backlog_warn: 1,
      backlog_fail: 500,
      repair_runbook: 'backlog',
    }, obs.work?.[linkKey]));
  }

  if (includeInfra) {
    entries.push(applyOverride({
      key: 'embedding.coverage',
      kind: 'embedding',
      enabled: true,
      required: true,
      criticality: 'required',
      cadence_seconds: DEFAULT_CADENCE.embedding,
      grace_seconds: DEFAULT_GRACE.embedding,
      evidence_adapter: 'embedding',
      selector: 'coverage',
      backlog_warn: 100,
      backlog_fail: 5000,
      repair_runbook: 'embedding',
    }, obs.work?.['embedding.coverage']));

    entries.push(applyOverride({
      key: 'retrieval.identity',
      kind: 'retrieval',
      enabled: true,
      required: true,
      criticality: 'required',
      cadence_seconds: DEFAULT_CADENCE.retrieval,
      grace_seconds: DEFAULT_GRACE.retrieval,
      evidence_adapter: 'retrieval',
      selector: 'identity',
      repair_runbook: 'embedding',
    }, obs.work?.['retrieval.identity']));

    entries.push(applyOverride({
      key: 'runtime.supervisor',
      kind: 'local_runtime',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: DEFAULT_CADENCE.local_runtime,
      grace_seconds: DEFAULT_GRACE.local_runtime,
      evidence_adapter: 'local_runtime',
      selector: 'supervisor',
      repair_runbook: 'observer-missing',
    }, obs.work?.['runtime.supervisor']));

    entries.push(applyOverride({
      key: 'runtime.autopilot',
      kind: 'local_runtime',
      enabled: true,
      required: false,
      criticality: 'optional',
      cadence_seconds: DEFAULT_CADENCE.local_runtime,
      grace_seconds: DEFAULT_GRACE.local_runtime,
      evidence_adapter: 'local_runtime',
      selector: 'autopilot',
      repair_runbook: 'observer-missing',
    }, obs.work?.['runtime.autopilot']));
  }

  for (const processor of input.registeredProcessors ?? []) {
    const key = `processor.${sanitizeWorkSegment(processor.key)}`;
    entries.push(applyOverride({
      key,
      kind: 'content_processor',
      enabled: processor.enabled,
      required: processor.required,
      criticality: processor.required ? 'required' : 'optional',
      cadence_seconds: processor.cadence_seconds,
      grace_seconds: processor.grace_seconds,
      evidence_adapter: 'processing_receipt',
      selector: processor.key,
      backlog_warn: processor.backlog_warn ?? undefined,
      backlog_fail: processor.backlog_fail ?? undefined,
      repair_runbook: processor.runbook,
      version: processor.version,
    }, obs.work?.[key]));
  }

  for (const ext of obs.external_work ?? []) {
    if (
      ext.evidence?.source_id &&
      !input.sourceIds.includes(ext.evidence.source_id)
    ) {
      continue;
    }
    entries.push(externalToEntry(ext));
  }

  for (const axis of new Set(input.discoveryFailures ?? [])) {
    const key = `discovery.${axis}`;
    entries.push({
      key,
      kind: 'infrastructure',
      enabled: true,
      required: true,
      criticality: 'required',
      cadence_seconds: null,
      grace_seconds: 0,
      evidence_adapter: 'discovery',
      selector: axis,
      scope: { type: 'global' },
      repair_runbook: 'observer-missing',
    });
  }

  // Stable order for golden snapshots.
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

function applyOverride(base: ExpectedWorkEntry, override?: WorkPolicyOverride): ExpectedWorkEntry {
  if (!override) return base;
  return {
    ...base,
    enabled: override.enabled ?? base.enabled,
    required: override.required ?? base.required,
    criticality: override.criticality ?? base.criticality,
    cadence_seconds: override.cadence_seconds !== undefined ? override.cadence_seconds : base.cadence_seconds,
    grace_seconds: override.grace_seconds ?? base.grace_seconds,
    backlog_warn: override.backlog_warn ?? base.backlog_warn,
    backlog_fail: override.backlog_fail ?? base.backlog_fail,
    repair_runbook: override.repair_runbook ?? base.repair_runbook,
  };
}

function externalToEntry(ext: ExternalWorkDeclaration): ExpectedWorkEntry {
  const key = sanitizeWorkSegment(ext.key).includes('.')
    ? ext.key
    : `external.${sanitizeWorkSegment(ext.key)}`;
  return {
    key,
    kind: ext.kind ?? 'content_processor',
    enabled: ext.enabled !== false,
    required: ext.required === true,
    criticality: ext.criticality ?? (ext.required ? 'required' : 'optional'),
    cadence_seconds: ext.cadence_seconds ?? null,
    grace_seconds: ext.grace_seconds ?? 0,
    evidence_adapter: ext.evidence?.adapter ?? 'none',
    selector: ext.evidence?.selector ?? ext.key,
    ...(ext.evidence?.source_id
      ? { scope: { type: 'source' as const, source_id: ext.evidence.source_id } }
      : { scope: { type: 'global' as const } }),
    repair_runbook: 'missed-work',
  };
}

/**
 * Resolve which dream phases are expected for a brain given the pack list
 * and opt-in config flags.
 */
export function resolveEnabledDreamPhases(opts: {
  packPhases?: readonly string[] | null;
  /** Config map cycle.<phase>.enabled / dream.<phase>.enabled. */
  phaseEnabled?: Record<string, boolean | undefined>;
  /** Runtime synthesis defaults on only when a corpus is configured. */
  synthesizeCorpusConfigured?: boolean;
}): string[] {
  const pack = new Set(opts.packPhases ?? []);
  const out = new Set<string>();

  for (const p of CORE_DREAM_PHASES) out.add(p);

  // Pack-declared phases (extract_atoms, synthesize_concepts, …).
  for (const p of pack) {
    // Synthesis has an additional runtime prerequisite handled below.
    if (p === 'synthesize') continue;
    if ((ALL_PHASES as string[]).includes(p)) out.add(p);
  }

  // Opt-in phases only when config explicitly enables them.
  const OPT_IN: CyclePhase[] = [
    'conversation_facts_backfill',
    'enrich_thin',
    'skillopt',
  ];
  for (const p of OPT_IN) {
    const flag = opts.phaseEnabled?.[p];
    if (flag === true) out.add(p);
  }

  const synthesizeFlag = opts.phaseEnabled?.synthesize;
  if (
    synthesizeFlag !== false &&
    opts.synthesizeCorpusConfigured === true
  ) {
    out.add('synthesize');
  }

  // Always-on non-core phases that run in a full cycle when not gated.
  for (const p of [
    'lint',
    'backlinks',
    'patterns',
    'recompute_emotional_weight',
    'consolidate',
    'resolve_symbol_edges',
    'propose_takes',
    'grade_takes',
    'calibration_profile',
    'schema-suggest',
    'purge',
  ] as CyclePhase[]) {
    const flag = opts.phaseEnabled?.[p];
    if (flag === false) continue;
    out.add(p);
  }

  return [...out].sort();
}

/**
 * Evaluate one registry entry against collected evidence.
 */
export function evaluateWorkItem(
  entry: ExpectedWorkEntry,
  evidence: WorkEvidence | null | undefined,
  now: Date = new Date(),
): WorkObservation {
  const evaluated = evaluateWorkItemPolicy(entry, evidence, now);
  if (!entry.enabled || !evidence?.force_state) return evaluated;

  const forcedState = evidence.force_state;
  const forcedReason = evidence.force_reason ?? reasonForForcedState(forcedState);
  if (
    forcedState === 'failed' ||
    forcedState === 'unknown' ||
    forcedState === 'disabled' ||
    stateSeverity(forcedState) > stateSeverity(evaluated.state)
  ) {
    return {
      ...evaluated,
      state: forcedState,
      reason: forcedReason,
      repair_runbook: forcedState === 'disabled'
        ? null
        : entry.repair_runbook ?? defaultRunbookForReason(forcedReason),
      next_due_at: computeNextDue(entry, evidence, now),
    };
  }
  return evaluated;
}

function evaluateWorkItemPolicy(
  entry: ExpectedWorkEntry,
  evidence: WorkEvidence | null | undefined,
  now: Date,
): WorkObservation {
  const base: WorkObservation = {
    key: entry.key,
    kind: entry.kind,
    state: 'unknown',
    last_attempt_at: evidence?.last_attempt_at ?? null,
    last_success_at: evidence?.last_success_at ?? null,
    next_due_at: null,
    backlog_items: evidence?.backlog_items ?? null,
    oldest_pending_age_seconds: evidence?.oldest_pending_age_seconds ?? null,
    recent_failures: evidence?.recent_failures ?? null,
    reason: null,
    repair_runbook: entry.repair_runbook ?? null,
    required: entry.required,
    enabled: entry.enabled,
    ...(entry.version ? { version: entry.version } : {}),
  };

  if (!entry.enabled) {
    return {
      ...base,
      state: 'disabled',
      reason: 'disabled',
      repair_runbook: null,
    };
  }

  if (entry.evidence_adapter === 'none') {
    return {
      ...base,
      state: 'unknown',
      reason: 'instrumentation_missing',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('instrumentation_missing'),
    };
  }

  if (!evidence) {
    return {
      ...base,
      state: 'unknown',
      reason: 'evidence_unavailable',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('evidence_unavailable'),
    };
  }

  // Backlog thresholds take precedence when exceeded.
  if (
    entry.backlog_fail != null &&
    evidence.backlog_items != null &&
    evidence.backlog_items >= entry.backlog_fail
  ) {
    return {
      ...base,
      state: 'failed',
      reason: 'backlog_fail',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('backlog_fail'),
      next_due_at: computeNextDue(entry, evidence, now),
    };
  }

  // Cadence evaluation when a success timestamp exists.
  const cadence = entry.cadence_seconds;
  if (cadence != null && cadence > 0) {
    const successMs = parseIsoMs(evidence.last_success_at);
    const nowMs = now.getTime();
    if (successMs == null) {
      // Never succeeded — if we have attempts, treat as failed for required work.
      if (evidence.last_attempt_at) {
        return {
          ...base,
          state: entry.required ? 'failed' : 'degraded',
          reason: 'missed_cadence',
          repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('missed_cadence'),
          next_due_at: now.toISOString(),
        };
      }
      return {
        ...base,
        state: 'unknown',
        reason: 'evidence_unavailable',
        repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('evidence_unavailable'),
      };
    }

    const ageSec = Math.max(0, (nowMs - successMs) / 1000);
    const nextDue = new Date(successMs + cadence * 1000).toISOString();
    base.next_due_at = nextDue;

    if (ageSec <= cadence) {
      // Healthy path — still surface backlog warn / recent failures as degraded.
      if (
        entry.backlog_warn != null &&
        evidence.backlog_items != null &&
        evidence.backlog_items >= entry.backlog_warn
      ) {
        return {
          ...base,
          state: 'degraded',
          reason: 'backlog_warn',
          repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('backlog_warn'),
        };
      }
      if ((evidence.recent_failures ?? 0) >= 3) {
        return {
          ...base,
          state: 'degraded',
          reason: 'recent_failures',
          repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('recent_failures'),
        };
      }
      return { ...base, state: 'healthy', reason: 'ok' };
    }

    if (ageSec <= cadence + entry.grace_seconds) {
      return {
        ...base,
        state: 'degraded',
        reason: 'within_grace',
        repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('within_grace'),
      };
    }

    return {
      ...base,
      state: 'failed',
      reason: 'missed_cadence',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('missed_cadence'),
    };
  }

  // No cadence (continuous work): healthy if no force and backlog ok.
  if (
    entry.backlog_warn != null &&
    evidence.backlog_items != null &&
    evidence.backlog_items >= entry.backlog_warn
  ) {
    return {
      ...base,
      state: 'degraded',
      reason: 'backlog_warn',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('backlog_warn'),
    };
  }

  if ((evidence.recent_failures ?? 0) >= 3) {
    return {
      ...base,
      state: 'degraded',
      reason: 'recent_failures',
      repair_runbook: entry.repair_runbook ?? defaultRunbookForReason('recent_failures'),
    };
  }

  // Continuous healthy when evidence was supplied without force_state.
  return { ...base, state: 'healthy', reason: 'ok' };
}

function reasonForForcedState(state: OperationalState): ReasonCode {
  switch (state) {
    case 'failed': return 'missed_cadence';
    case 'degraded': return 'within_grace';
    case 'unknown': return 'evidence_unavailable';
    case 'disabled': return 'disabled';
    case 'healthy': return 'ok';
  }
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function computeNextDue(
  entry: ExpectedWorkEntry,
  evidence: WorkEvidence | null | undefined,
  now: Date,
): string | null {
  if (entry.cadence_seconds == null || entry.cadence_seconds <= 0) return null;
  const successMs = parseIsoMs(evidence?.last_success_at);
  if (successMs == null) return now.toISOString();
  return new Date(successMs + entry.cadence_seconds * 1000).toISOString();
}

/**
 * Reject private/prohibited fields and unregistered identifiers before export.
 * Validation is side-effect free: successful validation returns void.
 */
export function assertExportableSnapshot(snapshot: {
  brain: string;
  state: string;
  items: Array<{
    key: string;
    state: string;
    reason: string | null;
    kind?: string;
    repair_runbook?: string | null;
    version?: string;
  }>;
  warnings?: string[];
}): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(snapshot.brain)) {
    throw new Error(`operational snapshot: invalid brain id ${JSON.stringify(snapshot.brain)}`);
  }
  if (!STATE_SET_LOCAL.has(snapshot.state)) {
    throw new Error(`operational snapshot: unregistered brain state ${snapshot.state}`);
  }
  for (const item of snapshot.items) {
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(item.key)) {
      throw new Error(`operational snapshot: invalid work key ${JSON.stringify(item.key)}`);
    }
    if (!STATE_SET_LOCAL.has(item.state)) {
      throw new Error(`operational snapshot: unregistered item state ${item.state}`);
    }
    if (item.reason != null && !REASON_SET_LOCAL.has(item.reason)) {
      throw new Error(`operational snapshot: unregistered reason ${item.reason}`);
    }
    if (item.kind != null && !WORK_KINDS.includes(item.kind as never)) {
      throw new Error(`operational snapshot: unregistered work kind ${item.kind}`);
    }
    if (
      item.repair_runbook != null &&
      !/^[A-Za-z0-9._-]{1,64}$/.test(item.repair_runbook)
    ) {
      throw new Error(
        `operational snapshot: invalid repair runbook ${JSON.stringify(item.repair_runbook)}`,
      );
    }
    if (item.version != null && !/^[A-Za-z0-9._-]{1,32}$/.test(item.version)) {
      throw new Error(
        `operational snapshot: invalid work version ${JSON.stringify(item.version)}`,
      );
    }
  }
  for (const warning of snapshot.warnings ?? []) {
    if (!OBSERVABILITY_WARNING_CODES.includes(warning as never)) {
      throw new Error(`operational snapshot: unregistered warning ${warning}`);
    }
  }
}

const STATE_SET_LOCAL: ReadonlySet<string> = new Set(OPERATIONAL_STATES);
const REASON_SET_LOCAL: ReadonlySet<string> = new Set(REASON_CODES);
