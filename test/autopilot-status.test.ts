import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAutopilotLockStatus } from '../src/core/autopilot-status.ts';

const dirs: string[] = [];

function tempLock(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-status-'));
  dirs.push(dir);
  const path = join(dir, 'autopilot.lock');
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readAutopilotLockStatus', () => {
  test('reports a missing lock without probing a process', () => {
    const path = tempLock();
    let probed = false;

    expect(readAutopilotLockStatus(path, () => {
      probed = true;
      return true;
    })).toEqual({
      lockfile_present: false,
      pid: null,
      running: false,
    });
    expect(probed).toBe(false);
  });

  test('uses the shared liveness probe for a valid pid', () => {
    const path = tempLock('4242\n');
    expect(readAutopilotLockStatus(path, (pid) => pid === 4242)).toEqual({
      lockfile_present: true,
      pid: 4242,
      running: true,
    });
  });

  test('preserves stale/corrupt lock evidence without inventing a pid', () => {
    const path = tempLock('not-a-pid\n');
    expect(readAutopilotLockStatus(path)).toEqual({
      lockfile_present: true,
      pid: null,
      running: false,
    });
  });
});
