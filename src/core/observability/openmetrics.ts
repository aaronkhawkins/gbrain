/**
 * Render an OperationalSnapshot as OpenMetrics / Prometheus text exposition.
 *
 * Bounded label registries only. Rejects newlines, high-cardinality values,
 * and prohibited fields.
 */

import type { OperationalSnapshot, OperationalState } from './types.ts';
import { OPERATIONAL_STATES, WORK_KINDS } from './types.ts';
import { REASON_CODES, type ReasonCode } from './reason-codes.ts';

const STATE_INDEX: Record<OperationalState, number> = {
  healthy: 0,
  degraded: 1,
  failed: 2,
  unknown: 3,
  disabled: 4,
};

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function assertLabel(name: string, value: string, maxLen = 96): string {
  if (value.length === 0 || value.length > maxLen) {
    throw new Error(`openmetrics: invalid ${name} length`);
  }
  if (/[\n\r"]/.test(value) || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`openmetrics: invalid ${name} chars: ${JSON.stringify(value)}`);
  }
  return value;
}

function stateGaugeLines(
  metric: string,
  labels: Record<string, string>,
  state: OperationalState,
): string[] {
  const lines: string[] = [];
  for (const s of OPERATIONAL_STATES) {
    const all = { ...labels, state: s };
    const labelStr = Object.entries(all)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    lines.push(`${metric}{${labelStr}} ${s === state ? 1 : 0}`);
  }
  return lines;
}

function reasonGaugeLines(
  brain: string,
  work: string,
  reason: ReasonCode | null,
): string[] {
  const lines: string[] = [];
  for (const r of REASON_CODES) {
    const labelStr = `brain="${escapeLabel(brain)}",work="${escapeLabel(work)}",reason="${escapeLabel(r)}"`;
    lines.push(`gbrain_expected_work_reason{${labelStr}} ${reason === r ? 1 : 0}`);
  }
  return lines;
}

/**
 * Render OpenMetrics text. Throws if the snapshot contains unregistered
 * identifiers or prohibited label values.
 */
export function renderOpenMetrics(snapshot: OperationalSnapshot): string {
  const brain = assertLabel('brain', snapshot.brain, 64);
  const lines: string[] = [];

  lines.push('# HELP gbrain_observer_info GBrain observer process identity.');
  lines.push('# TYPE gbrain_observer_info gauge');
  const build = snapshot.build?.sha ?? snapshot.build?.tag ?? 'unknown';
  const buildLabel = assertLabel('build', sanitizeBuild(build), 64);
  lines.push(`gbrain_observer_info{brain="${escapeLabel(brain)}",build="${escapeLabel(buildLabel)}"} 1`);

  lines.push('# HELP gbrain_observer_snapshot_timestamp_seconds Unix time the snapshot was generated.');
  lines.push('# TYPE gbrain_observer_snapshot_timestamp_seconds gauge');
  const ts = Date.parse(snapshot.generated_at) / 1000;
  if (!Number.isFinite(ts)) throw new Error('openmetrics: invalid generated_at');
  lines.push(`gbrain_observer_snapshot_timestamp_seconds{brain="${escapeLabel(brain)}"} ${ts.toFixed(3)}`);

  lines.push('# HELP gbrain_brain_state One-hot brain operational state.');
  lines.push('# TYPE gbrain_brain_state gauge');
  lines.push(...stateGaugeLines('gbrain_brain_state', { brain }, snapshot.state));

  lines.push('# HELP gbrain_brain_state_code Numeric brain state (0=healthy…4=disabled).');
  lines.push('# TYPE gbrain_brain_state_code gauge');
  lines.push(`gbrain_brain_state_code{brain="${escapeLabel(brain)}"} ${STATE_INDEX[snapshot.state]}`);

  lines.push('# HELP gbrain_expected_work_state One-hot expected-work operational state.');
  lines.push('# TYPE gbrain_expected_work_state gauge');
  lines.push('# HELP gbrain_expected_work_info Bounded expected-work policy metadata.');
  lines.push('# TYPE gbrain_expected_work_info gauge');
  lines.push('# HELP gbrain_expected_work_last_attempt_timestamp_seconds Last attempt time.');
  lines.push('# TYPE gbrain_expected_work_last_attempt_timestamp_seconds gauge');
  lines.push('# HELP gbrain_expected_work_last_success_timestamp_seconds Last success time.');
  lines.push('# TYPE gbrain_expected_work_last_success_timestamp_seconds gauge');
  lines.push('# HELP gbrain_expected_work_next_due_timestamp_seconds Next due time.');
  lines.push('# TYPE gbrain_expected_work_next_due_timestamp_seconds gauge');
  lines.push('# HELP gbrain_expected_work_backlog_items Current backlog count.');
  lines.push('# TYPE gbrain_expected_work_backlog_items gauge');
  lines.push('# HELP gbrain_expected_work_oldest_pending_age_seconds Age of oldest pending item.');
  lines.push('# TYPE gbrain_expected_work_oldest_pending_age_seconds gauge');
  lines.push('# HELP gbrain_expected_work_recent_failures Recent failure count.');
  lines.push('# TYPE gbrain_expected_work_recent_failures gauge');
  lines.push('# HELP gbrain_expected_work_reason One-hot reason code for expected work.');
  lines.push('# TYPE gbrain_expected_work_reason gauge');

  for (const item of snapshot.items) {
    const work = assertLabel('work', item.key, 96);
    if (!WORK_KINDS.includes(item.kind)) {
      throw new Error(`openmetrics: invalid kind ${JSON.stringify(item.kind)}`);
    }
    const kind = assertLabel('kind', item.kind, 32);
    const runbook = assertLabel(
      'runbook',
      item.repair_runbook ?? 'none',
      64,
    );
    lines.push(
      `gbrain_expected_work_info{brain="${escapeLabel(brain)}",work="${escapeLabel(work)}",kind="${escapeLabel(kind)}",required="${item.required ? 'true' : 'false'}",enabled="${item.enabled ? 'true' : 'false'}",runbook="${escapeLabel(runbook)}"} 1`,
    );
    lines.push(...stateGaugeLines('gbrain_expected_work_state', { brain, work }, item.state));

    const base = `brain="${escapeLabel(brain)}",work="${escapeLabel(work)}"`;
    if (item.last_attempt_at) {
      const t = Date.parse(item.last_attempt_at) / 1000;
      if (Number.isFinite(t)) {
        lines.push(`gbrain_expected_work_last_attempt_timestamp_seconds{${base}} ${t.toFixed(3)}`);
      }
    }
    if (item.last_success_at) {
      const t = Date.parse(item.last_success_at) / 1000;
      if (Number.isFinite(t)) {
        lines.push(`gbrain_expected_work_last_success_timestamp_seconds{${base}} ${t.toFixed(3)}`);
      }
    }
    if (item.next_due_at) {
      const t = Date.parse(item.next_due_at) / 1000;
      if (Number.isFinite(t)) {
        lines.push(`gbrain_expected_work_next_due_timestamp_seconds{${base}} ${t.toFixed(3)}`);
      }
    }
    if (item.backlog_items != null) {
      lines.push(`gbrain_expected_work_backlog_items{${base}} ${item.backlog_items}`);
    }
    if (item.oldest_pending_age_seconds != null) {
      lines.push(`gbrain_expected_work_oldest_pending_age_seconds{${base}} ${item.oldest_pending_age_seconds}`);
    }
    if (item.recent_failures != null) {
      lines.push(`gbrain_expected_work_recent_failures{${base}} ${item.recent_failures}`);
    }
    lines.push(...reasonGaugeLines(brain, work, item.reason));
  }

  lines.push('# EOF');
  return lines.join('\n') + '\n';
}

function sanitizeBuild(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'unknown';
}

/** Content scan: ensure exposition has no prohibited substrings. */
export function scanOpenMetricsForProhibited(text: string): string[] {
  const hits: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/postgres(?:ql)?:\/\//i, 'database_url'],
    [/password=/i, 'password'],
    [/api[_-]?key/i, 'api_key'],
    [/BEGIN (RSA |OPENSSH )?PRIVATE KEY/, 'private_key'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'jwt_like'],
  ];
  for (const [re, name] of patterns) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}
