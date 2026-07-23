import { describe, expect, test } from 'bun:test';
import {
  getBuildIdentity,
  managedForkUpgradeGuard,
  type BuildIdentity,
} from '../src/core/build-identity.ts';
import { VERSION } from '../src/version.ts';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('build identity', () => {
  test('the pinned fork reports a four-part release version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(VERSION).toBe('0.42.64.1');
  });

  test('source/upstream fallback is explicit and safe', () => {
    const identity = getBuildIdentity();
    expect(identity.channel).toBe('upstream');
    expect(identity.managed_fork).toBe(false);
    expect(identity.upgrade_posture).toBe('upstream-managed');
    expect(identity.target.os).toBe(process.platform);
    expect(identity.target.runtime_abi).toStartWith('bun-');
    expect(identity).not.toHaveProperty('path');
  });

  test('managed fork guard blocks generic upstream replacement', () => {
    const fork: BuildIdentity = {
      channel: 'aaronkhawkins/gbrain',
      tag: 'research-v1',
      sha: '0123456789abcdef',
      upstream_base: 'v0.42.59.0',
      clean: true,
      artifact: 'compiled',
      managed_fork: true,
      upgrade_posture: 'fork-managed',
      target: {
        os: 'darwin',
        arch: 'arm64',
        executable_format: 'mach-o',
        runtime_abi: 'bun-test',
      },
    };
    const verdict = managedForkUpgradeGuard(fork);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('fork-managed');
    expect(verdict.reason).not.toContain('/Users/');
  });

  test('persists a role-specific private process receipt atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-build-receipt-'));
    const path = join(root, 'worker.json');
    try {
      const result = Bun.spawnSync([
        'bun',
        '-e',
        'import {getProcessBuildReceipt,persistProcessBuildReceipt} from "./src/core/build-identity.ts"; persistProcessBuildReceipt(getProcessBuildReceipt("worker"));',
      ], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          GBRAIN_WORKER_RECEIPT_FILE: path,
          GBRAIN_DEPLOYMENT_RECEIPT_ID: 'deployment-receipt-0001',
          GBRAIN_BRAIN_RECEIPT_ID: 'brain-receipt-0001',
          GBRAIN_CONFIG_RECEIPT_ID: 'config-receipt-0001',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        schema_version: 1,
        role: 'worker',
        deployment_receipt_id: 'deployment-receipt-0001',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
