/**
 * Shared host-local process and autopilot lock evidence.
 *
 * Both the human status command and the operational observer must report the
 * same PID as live or stale. Keep the signal-0/EPERM policy in one place.
 */

import { existsSync, readFileSync } from 'node:fs';
import { gbrainPath } from './config.ts';

export interface AutopilotLockStatus {
  lockfile_present: boolean;
  pid: number | null;
  running: boolean;
}

/** Probe process existence without sending a signal. EPERM still means live. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the current brain's autopilot lock status.
 *
 * The optional path/probe seams keep this deterministic in focused tests.
 */
export function readAutopilotLockStatus(
  lockPath = gbrainPath('autopilot.lock'),
  probe: (pid: number) => boolean = isProcessRunning,
): AutopilotLockStatus {
  if (!existsSync(lockPath)) {
    return { lockfile_present: false, pid: null, running: false };
  }

  try {
    const parsed = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { lockfile_present: true, pid: null, running: false };
    }
    return {
      lockfile_present: true,
      pid: parsed,
      running: probe(parsed),
    };
  } catch {
    return { lockfile_present: true, pid: null, running: false };
  }
}
