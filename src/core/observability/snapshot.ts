/**
 * Build a content-free operational snapshot for one brain.
 *
 * Orchestrates registry discovery → collectors → evaluation → rollup.
 * Never mutates state. Exported observer/agent callers enter through
 * buildReadOnlyOperationalSnapshot, which enforces the database boundary.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { createHash } from 'node:crypto';
import { currentBrainId } from '../minions/worker-registry.ts';
import { getBuildIdentity } from '../build-identity.ts';
import { loadAllSources } from '../sources-load.ts';
import {
  assertExportableSnapshot,
  buildExpectedWorkRegistry,
  evaluateWorkItem,
  resolveEnabledDreamPhases,
  type RegistryInput,
} from './expected-work.ts';
import { rollupBrainState } from './rollup.ts';
import type {
  ExpectedWorkEntry,
  ObservabilityWarningCode,
  OperationalSnapshot,
  WorkEvidence,
  WorkObservation,
} from './types.ts';
import { OPERATIONAL_SNAPSHOT_SCHEMA_VERSION } from './types.ts';
import { collectAllEvidence } from './collectors/index.ts';
import {
  AUTOPILOT_GLOBAL_FLOOR_CONFIG_KEY,
  AUTOPILOT_GLOBAL_FLOOR_MINUTES,
  getAutopilotRecurringRegistrations,
} from '../minions/recurring-work.ts';
import { withObserverReadOnlyEngine } from './read-only-engine.ts';
import { LATEST_VERSION } from '../migrate.ts';
import { listProcessingRegistrations } from '../processing-receipts.ts';
import { parseNativeIntakeTargetPolicy } from '../ingestion/native-intake.ts';

export interface BuildOperationalSnapshotOpts {
  engine: BrainEngine | null;
  config?: GBrainConfig | null;
  now?: Date;
  /**
   * Optional pre-built registry (tests). When omitted, discovery runs against
   * the engine + config.
   */
  registry?: ExpectedWorkEntry[];
  /** Pre-seeded evidence map (tests). Keys = work keys. */
  evidenceByKey?: Map<string, WorkEvidence | null>;
  /** Collect timeout for live collectors (ms). */
  collectTimeoutMs?: number;
  /** Opaque brain id override. */
  brainId?: string;
  /** Canonical source grant resolved by sourceScopeOpts(ctx). */
  sourceId?: string;
  sourceIds?: string[];
  /** When true, skip live collectors and use empty evidence (status partial path). */
  skipCollectors?: boolean;
  /** False means DB-backed work must report unknown/schema_incompatible. */
  schemaCompatible?: boolean;
  /** Receives raw collector details for local logging only. */
  onCollectorError?: (adapterId: string, error: unknown) => void;
}

/**
 * Resolve opaque brain identity. Prefer explicit observability.brain_id,
 * then a hash of the config DB key. Never emit a URL or path.
 */
export function resolveBrainId(
  config?: GBrainConfig | null,
  override?: string,
): string {
  const obs = config?.observability;
  const candidate = override ?? obs?.brain_id;
  if (candidate && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) return candidate;
  return currentBrainId();
}

function readObservability(config?: GBrainConfig | null): NonNullable<GBrainConfig['observability']> {
  const raw = config?.observability;
  return raw && typeof raw === 'object' ? raw : {};
}

/** Derive per-brain HMAC material without ever exporting the DB locator. */
export function deriveSourceLabelKey(config?: GBrainConfig | null): string | null {
  const configuredBrainId = config?.observability?.brain_id;
  let identity: string | null = null;
  if (configuredBrainId && /^[A-Za-z0-9._-]{1,64}$/.test(configuredBrainId)) {
    identity = `brain:${configuredBrainId}`;
  } else if (config?.database_path) {
    identity = `pglite:${config.database_path}`;
  } else if (config?.database_url) {
    try {
      const locator = new URL(config.database_url);
      identity = [
        'postgres',
        locator.hostname.toLowerCase(),
        locator.port,
        locator.pathname,
      ].join(':');
    } catch {
      return null;
    }
  }
  if (!identity) return null;
  return createHash('sha256')
    .update('gbrain-observability-label-key-v1\0')
    .update(identity)
    .digest('hex');
}

function allowedSourceSet(scope: {
  sourceId?: string;
  sourceIds?: string[];
}): Set<string> | null {
  if (scope.sourceIds !== undefined) return new Set(scope.sourceIds);
  if (scope.sourceId !== undefined) return new Set([scope.sourceId]);
  return null;
}

function parseDbBoolean(raw: string | null): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * Discover registry inputs from a live engine. Best-effort: missing pack or
 * sources yields an empty list for that axis, never throws past the boundary.
 */
export async function discoverRegistryInput(
  engine: BrainEngine | null,
  config?: GBrainConfig | null,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<RegistryInput> {
  const observability = readObservability(config);
  const sourceIds: string[] = [];
  const nativeIntakeTargetIds: string[] = [];
  const scheduledSourceIds: string[] = [];
  const discoveryFailures: RegistryInput['discoveryFailures'] = [];
  const allowedSources = allowedSourceSet(scope);
  if (engine) {
    try {
      const sources = await loadAllSources(engine, {
        includeArchived: false,
        sourceIds: scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined),
      });
      for (const s of sources) {
        if (allowedSources && !allowedSources.has(s.id)) continue;
        sourceIds.push(s.id);
        if (parseNativeIntakeTargetPolicy(s.config)) {
          nativeIntakeTargetIds.push(s.id);
        }
        if (s.local_path) scheduledSourceIds.push(s.id);
      }
    } catch {
      discoveryFailures.push('sources');
    }
  } else {
    discoveryFailures.push('sources');
  }

  let packPhases: string[] = [];
  if (engine) {
    try {
      const { loadActivePack } = await import('../schema-pack/load-active.ts');
      const resolved = await loadActivePack({
        cfg: config ?? null,
        remote: false,
      });
      const phases = resolved?.manifest?.phases;
      if (Array.isArray(phases)) packPhases = phases.filter((p): p is string => typeof p === 'string');
    } catch {
      packPhases = [];
      discoveryFailures.push('dream_phases');
    }
  } else {
    discoveryFailures.push('dream_phases');
  }

  // Runtime phase gates are DB-plane values read by the phase implementations.
  const phaseEnabled: Record<string, boolean | undefined> = {};
  let synthesizeCorpusConfigured = false;
  if (engine) {
    try {
      const [
        synthEnabled,
        synthCorpus,
        patternsEnabled,
        conversationFactsEnabled,
        enrichThinEnabled,
        skilloptEnabled,
      ] = await Promise.all([
        engine.getConfig('dream.synthesize.enabled'),
        engine.getConfig('dream.synthesize.session_corpus_dir'),
        engine.getConfig('dream.patterns.enabled'),
        engine.getConfig('cycle.conversation_facts_backfill.enabled'),
        engine.getConfig('cycle.enrich_thin.enabled'),
        engine.getConfig('cycle.skillopt.enabled'),
      ]);
      phaseEnabled.synthesize = parseDbBoolean(synthEnabled);
      phaseEnabled.patterns = parseDbBoolean(patternsEnabled);
      phaseEnabled.conversation_facts_backfill = parseDbBoolean(conversationFactsEnabled);
      phaseEnabled.enrich_thin = parseDbBoolean(enrichThinEnabled);
      phaseEnabled.skillopt = parseDbBoolean(skilloptEnabled);
      synthesizeCorpusConfigured = Boolean(synthCorpus?.trim());
    } catch {
      discoveryFailures.push('dream_phases');
    }
  }

  const enabledDreamPhases = resolveEnabledDreamPhases({
    packPhases,
    phaseEnabled,
    synthesizeCorpusConfigured,
  });
  let globalFloorMinutes = AUTOPILOT_GLOBAL_FLOOR_MINUTES;
  let registeredProcessors: RegistryInput['registeredProcessors'] = [];
  if (engine) {
    const [floorResult, processorsResult] = await Promise.allSettled([
      engine.getConfig(AUTOPILOT_GLOBAL_FLOOR_CONFIG_KEY),
      listProcessingRegistrations(engine),
    ]);
    if (floorResult.status === 'fulfilled') {
      const raw = floorResult.value;
      const parsed = Number.parseInt(raw ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 1) globalFloorMinutes = parsed;
    } else {
      // The scheduler registration still exists; use its native default.
    }
    if (processorsResult.status === 'fulfilled') {
      registeredProcessors = processorsResult.value.map((row) => ({
        key: row.processor_key,
        version: row.processor_version,
        enabled: row.enabled,
        required: row.required,
        cadence_seconds: row.cadence_seconds,
        grace_seconds: row.grace_seconds,
        backlog_warn: row.backlog_warn,
        backlog_fail: row.backlog_fail,
        runbook: row.runbook,
      }));
    } else {
      discoveryFailures.push('processors');
    }
  }

  return {
    sourceIds,
    nativeIntakeTargetIds,
    ...(sourceIds.length > 0
      ? { sourceLabelKey: deriveSourceLabelKey(config) ?? undefined }
      : {}),
    scheduledSourceIds,
    enabledDreamPhases,
    recurringMinions: getAutopilotRecurringRegistrations({
      scheduledSourceIds,
      globalFloorMinutes,
    }),
    registeredProcessors,
    discoveryFailures,
    observability,
    includeInfrastructure: true,
  };
}

export async function buildOperationalSnapshot(
  opts: BuildOperationalSnapshotOpts,
): Promise<OperationalSnapshot> {
  const now = opts.now ?? new Date();
  const config = opts.config ?? null;
  const observability = readObservability(config);
  const brain = resolveBrainId(config, opts.brainId);
  const warnings: ObservabilityWarningCode[] = [];
  let partial = false;

  let registry = opts.registry;
  if (!registry) {
    const input = await discoverRegistryInput(opts.engine, config, {
      sourceId: opts.sourceId,
      sourceIds: opts.sourceIds,
    });
    if (input.sourceIds.length > 0 && !input.sourceLabelKey) {
      input.sourceIds = [];
      input.scheduledSourceIds = [];
      input.discoveryFailures = [
        ...new Set([...(input.discoveryFailures ?? []), 'sources' as const]),
      ];
    }
    registry = buildExpectedWorkRegistry(input);
    if ((input.discoveryFailures?.length ?? 0) > 0) partial = true;
  }

  let evidenceByKey = opts.evidenceByKey;
  if (!evidenceByKey && !opts.skipCollectors) {
    try {
      const collected = await collectAllEvidence({
        engine: opts.engine,
        registry,
        config,
        now,
        timeoutMs: opts.collectTimeoutMs ?? observability.observer?.collect_timeout_ms ?? 15_000,
        sourceId: opts.sourceId,
        sourceIds: opts.sourceIds,
        onCollectorError: opts.onCollectorError,
      });
      evidenceByKey = collected.evidence;
      if (collected.warnings.length) warnings.push(...collected.warnings);
      if (collected.partial) partial = true;
    } catch (err) {
      opts.onCollectorError?.('collector_fanout', err);
      warnings.push('collector_failed');
      partial = true;
      evidenceByKey = new Map();
    }
  }
  evidenceByKey ??= new Map();

  const items: WorkObservation[] = registry.map((entry) => {
    let evidence = evidenceByKey!.has(entry.key)
      ? evidenceByKey!.get(entry.key)
      : evidenceByKey!.get(entry.selector);
    if (opts.schemaCompatible === false && isDatabaseBacked(entry)) {
      evidence = {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: null,
        force_state: 'unknown',
        force_reason: 'schema_incompatible',
      };
    }
    return evaluateWorkItem(entry, evidence ?? null, now);
  });

  const build = getBuildIdentity();
  const snapshot: OperationalSnapshot = {
    schema_version: OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
    brain,
    generated_at: now.toISOString(),
    state: rollupBrainState(items),
    items,
    build: {
      channel: build.channel,
      tag: build.tag,
      sha: build.sha,
      managed_fork: build.managed_fork,
    },
  };
  if (partial) snapshot.partial = true;
  if (warnings.length) snapshot.warnings = warnings;

  assertExportableSnapshot(snapshot);

  return snapshot;
}

function isDatabaseBacked(entry: ExpectedWorkEntry): boolean {
  return entry.evidence_adapter !== 'local_runtime' &&
    entry.evidence_adapter !== 'none';
}

/**
 * Authoritative observer builder. Every exported observer/agent surface uses
 * this wrapper so schema probing and collection share one read-only boundary.
 */
export async function buildReadOnlyOperationalSnapshot(
  opts: Omit<BuildOperationalSnapshotOpts, 'schemaCompatible'>,
): Promise<OperationalSnapshot> {
  const collectTimeoutMs = opts.collectTimeoutMs ??
    readObservability(opts.config ?? null).observer?.collect_timeout_ms ??
    15_000;
  return withObserverReadOnlyEngine(opts.engine, async (engine) => {
    const schemaCompatible = engine
      ? await observerSchemaCompatible(engine)
      : undefined;
    return buildOperationalSnapshot({
      ...opts,
      engine,
      schemaCompatible,
    });
  }, { statementTimeoutMs: collectTimeoutMs });
}

export async function observerSchemaCompatible(engine: BrainEngine): Promise<boolean> {
  try {
    const raw = await engine.getConfig('version');
    if (raw == null || !/^[0-9]+$/.test(raw.trim())) return false;
    const observed = Number(raw);
    return Number.isSafeInteger(observed) && observed === LATEST_VERSION;
  } catch {
    return false;
  }
}

/**
 * Strip any accidental private fields before JSON export.
 * Defense-in-depth for status --json /metrics paths.
 */
export function serializeOperationalSnapshot(snapshot: OperationalSnapshot): string {
  assertExportableSnapshot(snapshot);
  // Rebuild from known fields only.
  const clean: OperationalSnapshot = {
    schema_version: 1,
    brain: snapshot.brain,
    generated_at: snapshot.generated_at,
    state: snapshot.state,
    items: snapshot.items.map((i) => ({
      key: i.key,
      kind: i.kind,
      state: i.state,
      last_attempt_at: i.last_attempt_at,
      last_success_at: i.last_success_at,
      next_due_at: i.next_due_at,
      backlog_items: i.backlog_items,
      oldest_pending_age_seconds: i.oldest_pending_age_seconds,
      recent_failures: i.recent_failures,
      reason: i.reason,
      repair_runbook: i.repair_runbook,
      required: i.required,
      enabled: i.enabled,
      ...(i.version ? { version: i.version } : {}),
    })),
  };
  if (snapshot.build) clean.build = snapshot.build;
  if (snapshot.observer) clean.observer = snapshot.observer;
  if (snapshot.warnings) clean.warnings = snapshot.warnings;
  if (snapshot.partial) clean.partial = true;
  return JSON.stringify(clean);
}
