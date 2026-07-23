/**
 * Build a content-free operational snapshot for one brain.
 *
 * Orchestrates registry discovery → collectors → evaluation → rollup.
 * Never mutates state. Exported observer/agent callers enter through
 * buildReadOnlyOperationalSnapshot, which enforces the database boundary.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
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
  ObservabilityConfig,
  ObservabilityWarningCode,
  OperationalSnapshot,
  WorkEvidence,
  WorkObservation,
} from './types.ts';
import { OPERATIONAL_SNAPSHOT_SCHEMA_VERSION } from './types.ts';
import { collectAllEvidence } from './collectors/index.ts';
import { withObserverReadOnlyEngine } from './read-only-engine.ts';
import { hasPendingMigrations } from '../migrate.ts';

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
  const obs = (config as { observability?: ObservabilityConfig } | null | undefined)?.observability;
  const candidate = override ?? obs?.brain_id;
  if (candidate && /^[A-Za-z0-9._-]{1,64}$/.test(candidate)) return candidate;
  return currentBrainId();
}

function readObservability(config?: GBrainConfig | null): ObservabilityConfig {
  const raw = (config as { observability?: ObservabilityConfig } | null | undefined)?.observability;
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * Discover registry inputs from a live engine. Best-effort: missing pack or
 * sources yields an empty list for that axis, never throws past the boundary.
 */
export async function discoverRegistryInput(
  engine: BrainEngine | null,
  config?: GBrainConfig | null,
): Promise<RegistryInput> {
  const observability = readObservability(config);
  const sourceIds: string[] = [];
  if (engine) {
    try {
      const sources = await loadAllSources(engine, { includeArchived: false });
      for (const s of sources) sourceIds.push(s.id);
    } catch {
      /* empty source list — collectors will mark evidence unknown */
    }
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
    }
  }

  // Opt-in phase flags from config (DB or file plane).
  const phaseEnabled: Record<string, boolean | undefined> = {};
  const cfgAny = config as Record<string, unknown> | null | undefined;
  if (cfgAny) {
    // Nested dream / cycle config if present.
    const dream = cfgAny.dream as Record<string, unknown> | undefined;
    const cycle = cfgAny.cycle as Record<string, unknown> | undefined;
    for (const root of [dream, cycle]) {
      if (!root || typeof root !== 'object') continue;
      for (const [k, v] of Object.entries(root)) {
        if (v && typeof v === 'object' && 'enabled' in (v as object)) {
          phaseEnabled[k] = (v as { enabled?: boolean }).enabled;
        }
      }
    }
  }

  const enabledDreamPhases = resolveEnabledDreamPhases({ packPhases, phaseEnabled });

  return {
    sourceIds,
    enabledDreamPhases,
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
    const input = await discoverRegistryInput(opts.engine, config);
    registry = buildExpectedWorkRegistry(input);
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
  return withObserverReadOnlyEngine(opts.engine, async (engine) => {
    const schemaCompatible = engine
      ? !(await hasPendingMigrations(engine))
      : undefined;
    return buildOperationalSnapshot({
      ...opts,
      engine,
      schemaCompatible,
    });
  });
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
    })),
  };
  if (snapshot.build) clean.build = snapshot.build;
  if (snapshot.observer) clean.observer = snapshot.observer;
  if (snapshot.warnings) clean.warnings = snapshot.warnings;
  if (snapshot.partial) clean.partial = true;
  return JSON.stringify(clean);
}
