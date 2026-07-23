/**
 * Operational truth contracts (Phase 1A).
 *
 * GBrain owns expected-work discovery, evidence evaluation, and state rollup.
 * External systems (Prometheus, Grafana) consume the resulting snapshot only.
 * No knowledge content, credentials, URLs, payloads, or raw errors live here.
 */

/** Exhaustive operational states — dashboards must not invent others. */
export const OPERATIONAL_STATES = [
  'healthy',
  'degraded',
  'failed',
  'unknown',
  'disabled',
] as const;

export type OperationalState = (typeof OPERATIONAL_STATES)[number];

export const WORK_KINDS = [
  'source',
  'dream_phase',
  'minion',
  'embedding',
  'retrieval',
  'local_runtime',
  'content_processor',
  'infrastructure',
] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

export type Criticality = 'required' | 'optional';

/** Adapter ids registered in collectors/index.ts. */
export const EVIDENCE_ADAPTERS = [
  'ingestion_source',
  'minion_job',
  'dream_phase',
  'embedding',
  'retrieval',
  'local_runtime',
  'none',
] as const;

export type EvidenceAdapterId = (typeof EVIDENCE_ADAPTERS)[number];

/**
 * Registry entry: what SHOULD run. Discovered from GBrain registrations first;
 * per-brain config may override policy fields without duplicating registrations.
 */
export interface ExpectedWorkEntry {
  /** Stable opaque key used as the OpenMetrics `work` label. */
  key: string;
  kind: WorkKind;
  /** Human operator label is intentionally omitted from export surfaces. */
  enabled: boolean;
  required: boolean;
  criticality: Criticality;
  /** Expected success cadence in seconds; null when cadence is not applicable. */
  cadence_seconds: number | null;
  /** Extra seconds after cadence before failed. */
  grace_seconds: number;
  evidence_adapter: EvidenceAdapterId;
  /** Adapter-specific opaque selector (job name, phase, source id, etc.). */
  selector: string;
  backlog_warn?: number;
  backlog_fail?: number;
  /** Bounded runbook id, not free-form prose in metrics. */
  repair_runbook?: string;
}

/**
 * Raw evidence produced by a collector. Free of knowledge content.
 * Collectors never invent healthy when evidence is missing.
 */
export interface WorkEvidence {
  last_attempt_at: string | null;
  last_success_at: string | null;
  backlog_items: number | null;
  oldest_pending_age_seconds: number | null;
  recent_failures: number | null;
  /**
   * Hard state override from the adapter (e.g. embedding identity mismatch →
   * failed, supervisor missing → unknown). When set, cadence is not applied.
   */
  force_state?: OperationalState;
  force_reason?: import('./reason-codes.ts').ReasonCode;
}

export interface WorkObservation {
  key: string;
  kind: WorkKind;
  state: OperationalState;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_due_at: string | null;
  backlog_items: number | null;
  oldest_pending_age_seconds: number | null;
  recent_failures: number | null;
  reason: import('./reason-codes.ts').ReasonCode | null;
  repair_runbook: string | null;
  required: boolean;
  enabled: boolean;
}

export interface OperationalSnapshot {
  schema_version: 1;
  /** Opaque brain identity (hash of config path / DB key — never a URL). */
  brain: string;
  generated_at: string;
  /** Brain rollup over required items. */
  state: OperationalState;
  items: WorkObservation[];
  build?: {
    channel: string;
    tag: string | null;
    sha: string | null;
    managed_fork: boolean;
  };
  /** Observer process freshness (set by observe serve). */
  observer?: {
    bind: string;
    port: number;
    snapshot_age_ms: number;
  };
  warnings?: string[];
  partial?: boolean;
}

/** Per-brain file-plane overrides under `observability` in config.json. */
export interface ObservabilityConfig {
  /** Opaque label override for the `brain` metric label (must match [A-Za-z0-9_-]{1,64}). */
  brain_id?: string;
  observer?: {
    /** Tailscale / private bind address. Wildcard rejected by default. */
    bind?: string;
    port?: number;
    /** Snapshot refresh interval ms. Default 30000. */
    refresh_ms?: number;
    /** Collector wall budget ms. Default 15000. */
    collect_timeout_ms?: number;
    /** Explicit unsafe override to allow 0.0.0.0 / :: binding. */
    allow_public_bind?: boolean;
  };
  /** Policy overrides keyed by work key. */
  work?: Record<string, WorkPolicyOverride>;
  /**
   * Explicit legacy / external work that cannot yet register via GBrain
   * contracts. Reported as instrumentation_missing until Phase 1B receipts.
   */
  external_work?: ExternalWorkDeclaration[];
}

export interface WorkPolicyOverride {
  enabled?: boolean;
  required?: boolean;
  criticality?: Criticality;
  cadence_seconds?: number | null;
  grace_seconds?: number;
  backlog_warn?: number;
  backlog_fail?: number;
  repair_runbook?: string;
}

export interface ExternalWorkDeclaration {
  key: string;
  kind?: WorkKind;
  enabled?: boolean;
  required?: boolean;
  criticality?: Criticality;
  /** Always adapter `none` until a receipt contract exists. */
  note?: string;
}

export const OPERATIONAL_SNAPSHOT_SCHEMA_VERSION = 1 as const;
