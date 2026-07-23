/**
 * Host-local runtime evidence: supervisor audit + autopilot PID.
 * Missing evidence is unknown, never healthy (R25).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { gbrainPath } from '../../config.ts';
import { readWorkers } from '../../minions/worker-registry.ts';
import {
  readSupervisorEvents,
  summarizeCrashes,
} from '../../minions/handlers/supervisor-audit.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';

function probePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readAutopilotPid(): { pid: number | null; running: boolean; lockfile: boolean } {
  // Matches status.ts buildAutopilotStatus — lock lives at autopilot.lock.
  const lockPath = gbrainPath('autopilot.lock');
  if (!existsSync(lockPath)) {
    return { pid: null, running: false, lockfile: false };
  }
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { pid: null, running: false, lockfile: true };
    }
    return { pid, running: probePid(pid), lockfile: true };
  } catch {
    return { pid: null, running: false, lockfile: true };
  }
}

export async function collectLocalRuntimeEvidence(
  entries: ExpectedWorkEntry[],
  _engine: BrainEngine | null,
  opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  const nowIso = opts.now.toISOString();

  let supervisorEvidence: WorkEvidence;
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const events = readSupervisorEvents({ sinceMs: since });
    const lastEventTs = events.length > 0 ? events[events.length - 1]!.ts : null;
    const exitEvents = events.filter((e) => e.event === 'worker_exited');
    const summary = summarizeCrashes(exitEvents);
    const workers = readWorkers();
    const live = workers.filter((w) => probePid(w.pid));

    if (!lastEventTs && live.length === 0) {
      supervisorEvidence = {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: summary.total,
        force_state: 'unknown',
        force_reason: 'evidence_unavailable',
      };
    } else if (summary.total >= 5) {
      supervisorEvidence = {
        last_attempt_at: lastEventTs,
        last_success_at: live.length > 0 ? nowIso : null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: summary.total,
        force_state: 'degraded',
        force_reason: 'recent_failures',
      };
    } else if (live.length > 0) {
      supervisorEvidence = {
        last_attempt_at: lastEventTs ?? nowIso,
        last_success_at: nowIso,
        backlog_items: 0,
        oldest_pending_age_seconds: null,
        recent_failures: summary.total,
        force_state: 'healthy',
        force_reason: 'ok',
      };
    } else {
      supervisorEvidence = {
        last_attempt_at: lastEventTs,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: summary.total,
        force_state: 'unknown',
        force_reason: 'evidence_unavailable',
      };
    }
  } catch {
    supervisorEvidence = {
      last_attempt_at: null,
      last_success_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    };
  }

  const ap = readAutopilotPid();
  let autopilotEvidence: WorkEvidence;
  if (ap.running) {
    autopilotEvidence = {
      last_attempt_at: nowIso,
      last_success_at: nowIso,
      backlog_items: 0,
      oldest_pending_age_seconds: null,
      recent_failures: 0,
      force_state: 'healthy',
      force_reason: 'ok',
    };
  } else if (ap.lockfile) {
    autopilotEvidence = {
      last_attempt_at: nowIso,
      last_success_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: 1,
      force_state: 'failed',
      force_reason: 'dead',
    };
  } else {
    autopilotEvidence = {
      last_attempt_at: null,
      last_success_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: null,
      force_state: 'unknown',
      force_reason: 'evidence_unavailable',
    };
  }

  for (const entry of entries) {
    if (entry.selector === 'supervisor' || entry.key === 'runtime.supervisor') {
      out.set(entry.key, supervisorEvidence);
    } else if (entry.selector === 'autopilot' || entry.key === 'runtime.autopilot') {
      out.set(entry.key, autopilotEvidence);
    } else {
      out.set(entry.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: null,
        force_state: 'unknown',
        force_reason: 'instrumentation_missing',
      });
    }
  }

  return out;
}
