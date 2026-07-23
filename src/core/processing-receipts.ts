import type { BrainEngine } from './engine.ts';
import { randomUUID } from 'node:crypto';

export const PROCESSING_OUTCOMES = ['running', 'completed', 'partial', 'failed', 'skipped'] as const;
export type ProcessingOutcome = (typeof PROCESSING_OUTCOMES)[number];
export const PROCESSING_TERMINAL_OUTCOMES = ['completed', 'partial', 'failed', 'skipped'] as const;
export type ProcessingTerminalOutcome = (typeof PROCESSING_TERMINAL_OUTCOMES)[number];

const KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,47}$/;

export interface ProcessingRegistrationInput {
  key: string;
  version: string;
  enabled?: boolean;
  required?: boolean;
  cadenceSeconds: number;
  graceSeconds?: number;
  backlogWarn?: number | null;
  backlogFail?: number | null;
  runbook: string;
  repairJobName?: string | null;
}

export interface ProcessingRegistrationRow {
  processor_key: string;
  processor_version: string;
  enabled: boolean;
  required: boolean;
  cadence_seconds: number;
  grace_seconds: number;
  backlog_warn: number | null;
  backlog_fail: number | null;
  runbook: string;
  repair_job_name: string | null;
}

export interface ProcessingReceiptIdentity {
  processorKey: string;
  processorVersion: string;
  scopeId: string;
  inputFingerprint: string;
}

export interface FinishProcessingReceiptInput extends ProcessingReceiptIdentity {
  attemptToken: string;
  outcome: ProcessingTerminalOutcome;
  inputCount?: number;
  outputCount?: number;
  backlogCount?: number | null;
  reasonCode?: string | null;
  lineageKind?: string | null;
  lineageId?: string | null;
}

export interface ProcessingReceiptRow {
  id: number;
  processor_key: string;
  processor_version: string;
  scope_id: string;
  input_fingerprint: string;
  attempt: number;
  attempt_token: string;
  outcome: ProcessingOutcome;
  started_at: string;
  finished_at: string | null;
  input_count: number;
  output_count: number;
  backlog_count: number | null;
  reason_code: string | null;
  lineage_kind: string | null;
  lineage_id: string | null;
  repair_job_id: number | null;
}

function boundedInt(name: string, value: number | null | undefined, nullable = false): number | null {
  if (value == null && nullable) return null;
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 1_000_000_000) {
    throw new Error(`${name} must be an integer from 0 to 1000000000`);
  }
  return normalized;
}

function assertMatch(name: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`invalid ${name}`);
}

export function validateProcessingIdentity(input: ProcessingReceiptIdentity): void {
  assertMatch('processor key', input.processorKey, KEY_RE);
  assertMatch('processor version', input.processorVersion, VERSION_RE);
  assertMatch('scope id', input.scopeId, OPAQUE_RE);
  assertMatch('input fingerprint', input.inputFingerprint, FINGERPRINT_RE);
}

export function parseProcessingTerminalOutcome(raw: string): ProcessingTerminalOutcome {
  if (!PROCESSING_TERMINAL_OUTCOMES.includes(raw as ProcessingTerminalOutcome)) {
    throw new Error('invalid processing outcome');
  }
  return raw as ProcessingTerminalOutcome;
}

export async function registerProcessor(
  engine: BrainEngine,
  input: ProcessingRegistrationInput,
): Promise<ProcessingRegistrationRow> {
  assertMatch('processor key', input.key, KEY_RE);
  assertMatch('processor version', input.version, VERSION_RE);
  assertMatch('runbook', input.runbook, KEY_RE);
  if (input.repairJobName != null) assertMatch('repair job name', input.repairJobName, KEY_RE);
  const cadence = boundedInt('cadenceSeconds', input.cadenceSeconds)!;
  if (cadence < 60) throw new Error('cadenceSeconds must be at least 60');
  const grace = boundedInt('graceSeconds', input.graceSeconds ?? 0)!;
  const warn = boundedInt('backlogWarn', input.backlogWarn, true);
  const fail = boundedInt('backlogFail', input.backlogFail, true);
  if (warn != null && fail != null && warn > fail) {
    throw new Error('backlogWarn must be less than or equal to backlogFail');
  }

  const rows = await engine.executeRaw<ProcessingRegistrationRow>(
    `INSERT INTO processing_registrations (
       processor_key, processor_version, enabled, required, cadence_seconds,
       grace_seconds, backlog_warn, backlog_fail, runbook, repair_job_name, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)
     ON CONFLICT (processor_key) DO UPDATE SET
       processor_version = EXCLUDED.processor_version,
       enabled = EXCLUDED.enabled,
       required = EXCLUDED.required,
       cadence_seconds = EXCLUDED.cadence_seconds,
       grace_seconds = EXCLUDED.grace_seconds,
       backlog_warn = EXCLUDED.backlog_warn,
       backlog_fail = EXCLUDED.backlog_fail,
       runbook = EXCLUDED.runbook,
       repair_job_name = EXCLUDED.repair_job_name,
       updated_at = CURRENT_TIMESTAMP
     RETURNING processor_key, processor_version, enabled, required,
       cadence_seconds, grace_seconds, backlog_warn, backlog_fail, runbook,
       repair_job_name`,
    [
      input.key, input.version, input.enabled !== false, input.required === true,
      cadence, grace, warn, fail, input.runbook, input.repairJobName ?? null,
    ],
  );
  return rows[0]!;
}

export async function startProcessingReceipt(
  engine: BrainEngine,
  input: ProcessingReceiptIdentity,
): Promise<ProcessingReceiptRow> {
  validateProcessingIdentity(input);
  const attemptToken = randomUUID();
  const rows = await engine.executeRaw<ProcessingReceiptRow>(
    `INSERT INTO processing_receipts (
       processor_key, processor_version, scope_id, input_fingerprint, attempt_token
     )
     SELECT processor_key, processor_version, $3, $4, $5
       FROM processing_registrations
      WHERE processor_key = $1 AND processor_version = $2 AND enabled = TRUE
     ON CONFLICT (processor_key, processor_version, scope_id, input_fingerprint)
     DO NOTHING
     RETURNING *`,
    [input.processorKey, input.processorVersion, input.scopeId, input.inputFingerprint, attemptToken],
  );
  if (rows[0]) return rows[0];
  const retried = await engine.executeRaw<ProcessingReceiptRow>(
    `WITH archived AS (
       INSERT INTO processing_receipt_attempts (
         receipt_id, attempt, attempt_token, outcome, started_at, finished_at,
         input_count, output_count, backlog_count, reason_code, lineage_kind, lineage_id
       )
       SELECT id, attempt, attempt_token, outcome, started_at, finished_at,
              input_count, output_count, backlog_count, reason_code, lineage_kind, lineage_id
         FROM processing_receipts
        WHERE processor_key = $1 AND processor_version = $2
          AND scope_id = $3 AND input_fingerprint = $4
          AND outcome IN ('failed','partial')
       ON CONFLICT (receipt_id, attempt) DO NOTHING
       RETURNING receipt_id, attempt
     )
     UPDATE processing_receipts p SET
       attempt = p.attempt + 1,
       attempt_token = $5,
       outcome = 'running',
       started_at = CURRENT_TIMESTAMP,
       finished_at = NULL,
       input_count = 0,
       output_count = 0,
       backlog_count = NULL,
       reason_code = NULL,
       lineage_kind = NULL,
       lineage_id = NULL,
       repair_job_id = NULL
      FROM archived a
     WHERE p.id = a.receipt_id AND p.attempt = a.attempt
     RETURNING p.*`,
    [input.processorKey, input.processorVersion, input.scopeId, input.inputFingerprint, attemptToken],
  );
  if (retried[0]) return retried[0];
  const existing = await engine.executeRaw<ProcessingReceiptRow>(
    `SELECT p.* FROM processing_receipts p
       JOIN processing_registrations r
         ON r.processor_key = p.processor_key
        AND r.processor_version = p.processor_version
        AND r.enabled = TRUE
      WHERE p.processor_key = $1 AND p.processor_version = $2
        AND p.scope_id = $3 AND p.input_fingerprint = $4`,
    [input.processorKey, input.processorVersion, input.scopeId, input.inputFingerprint],
  );
  if (!existing[0]) {
    throw new Error('processor registration/version is missing or disabled');
  }
  return existing[0];
}

export async function finishProcessingReceipt(
  engine: BrainEngine,
  input: FinishProcessingReceiptInput,
): Promise<ProcessingReceiptRow> {
  validateProcessingIdentity(input);
  assertMatch('attempt token', input.attemptToken, OPAQUE_RE);
  parseProcessingTerminalOutcome(input.outcome);
  if (input.reasonCode != null) assertMatch('reason code', input.reasonCode, REASON_RE);
  if (input.lineageKind != null) assertMatch('lineage kind', input.lineageKind, KEY_RE);
  if (input.lineageId != null) assertMatch('lineage id', input.lineageId, OPAQUE_RE);
  const rows = await engine.executeRaw<ProcessingReceiptRow>(
    `UPDATE processing_receipts SET
       outcome = $5, finished_at = CURRENT_TIMESTAMP,
       input_count = $6, output_count = $7, backlog_count = $8,
       reason_code = $9, lineage_kind = $10, lineage_id = $11
     WHERE processor_key = $1 AND processor_version = $2
       AND scope_id = $3 AND input_fingerprint = $4
       AND attempt_token = $12
       AND outcome = 'running'
     RETURNING *`,
    [
      input.processorKey, input.processorVersion, input.scopeId, input.inputFingerprint,
      input.outcome, boundedInt('inputCount', input.inputCount),
      boundedInt('outputCount', input.outputCount),
      boundedInt('backlogCount', input.backlogCount, true),
      input.reasonCode ?? null, input.lineageKind ?? null, input.lineageId ?? null,
      input.attemptToken,
    ],
  );
  if (rows[0]) return rows[0];
  const existing = await engine.executeRaw<ProcessingReceiptRow>(
    `SELECT * FROM processing_receipts
      WHERE processor_key = $1 AND processor_version = $2
        AND scope_id = $3 AND input_fingerprint = $4
        AND attempt_token = $5`,
    [
      input.processorKey, input.processorVersion, input.scopeId,
      input.inputFingerprint, input.attemptToken,
    ],
  );
  if (!existing[0]) throw new Error('processing receipt attempt is missing or stale');
  return existing[0];
}

export async function listProcessingRegistrations(
  engine: BrainEngine,
): Promise<ProcessingRegistrationRow[]> {
  return engine.executeRaw<ProcessingRegistrationRow>(
    `SELECT processor_key, processor_version, enabled, required,
            cadence_seconds, grace_seconds, backlog_warn, backlog_fail,
            runbook, repair_job_name
       FROM processing_registrations
      ORDER BY processor_key`,
  );
}
