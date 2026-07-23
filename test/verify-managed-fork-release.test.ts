import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDeploymentDescriptor } from '../scripts/verify-managed-fork-release.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-release-verifier-'));
  roots.push(root);
  const prefix = join(root, 'prefix');
  const releaseId = 'candidate-0123456789ab';
  const releaseDir = join(prefix, 'releases', releaseId);
  const brainHome = join(root, 'brain-home');
  const configPath = join(brainHome, 'config.json');
  const descriptorPath = join(root, 'descriptor.json');
  const target = {
    os: process.platform,
    arch: process.arch,
    executable_format: process.platform === 'darwin' ? 'mach-o' : 'elf',
    runtime_abi: `bun-${Bun.version}`,
  };
  const expected = {
    version: '1.2.3.4',
    channel: 'private-managed-fork',
    tag: 'candidate-v1.2.3.4',
    sha: '1'.repeat(40),
    upstream_base: `origin-master@${'2'.repeat(40)}`,
    target,
    deployment_receipt_id: 'deployment-receipt-0001',
    brain_receipt_id: 'brain-receipt-0001',
    config_receipt_id: 'config-receipt-0001',
  };
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(brainHome, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ engine: 'postgres' }));
  const binary = join(releaseDir, 'gbrain');
  writeFileSync(binary, `#!/usr/bin/env bun
console.log(JSON.stringify({version:"1.2.3.4",build:${JSON.stringify({
    channel: expected.channel,
    tag: expected.tag,
    sha: expected.sha,
    upstream_base: expected.upstream_base,
    clean: true,
    artifact: 'compiled',
    managed_fork: true,
    upgrade_posture: 'fork-managed',
    target,
  })}}));
`);
  chmodSync(binary, 0o755);
  const manifest = {
    schema_version: 2,
    release_id: releaseId,
    version: expected.version,
    channel: expected.channel,
    tag: expected.tag,
    sha: expected.sha,
    upstream_base: expected.upstream_base,
    binary_sha256: hash(binary),
    target,
    schema_compatibility: { min: 122, max: 124 },
    required_runtime_assets: [],
  };
  const manifestPath = join(releaseDir, 'release-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    join(releaseDir, 'release-manifest.sha256'),
    `${hash(manifestPath)}  release-manifest.json\n`,
  );
  symlinkSync(`releases/${releaseId}`, join(prefix, 'current'));

  const processReceipts: Record<string, string> = {};
  for (const role of ['cli', 'scheduler', 'supervisor', 'worker']) {
    const receiptPath = join(root, `${role}.json`);
    writeFileSync(receiptPath, JSON.stringify({
      schema_version: 1,
      role,
      build: { ...manifest, artifact: 'compiled' },
      deployment_receipt_id: expected.deployment_receipt_id,
      brain_receipt_id: expected.brain_receipt_id,
      config_receipt_id: expected.config_receipt_id,
    }));
    processReceipts[role] = receiptPath;
  }
  const descriptor = {
    schema_version: 1,
    deployment_id: 'deployment-opaque-0001',
    release_prefix: prefix,
    release_id: releaseId,
    brain_home: brainHome,
    config_path: configPath,
    expected_engine: 'postgres',
    require_selected: true,
    expected,
    process_receipts: processReceipts,
  };
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  chmodSync(descriptorPath, 0o600);
  return { descriptor, descriptorPath, processReceipts };
}

describe('managed fork deployment verifier', () => {
  test('accepts matching artifact, target, engine, selection, and process receipts', () => {
    const setup = fixture();
    const result = verifyDeploymentDescriptor(setup.descriptorPath);
    expect(result.ok).toBe(true);
    expect(result.deployment_id).toBe('deployment-opaque-0001');
    expect(result.checks).toHaveLength(9);
  });

  test('fails closed when a daemon receipt identifies another artifact', () => {
    const setup = fixture();
    const receipt = JSON.parse(readFileSync(setup.processReceipts.worker, 'utf8'));
    receipt.build.sha = '3'.repeat(40);
    writeFileSync(setup.processReceipts.worker, JSON.stringify(receipt));
    const result = verifyDeploymentDescriptor(setup.descriptorPath);
    expect(result.ok).toBe(false);
    expect(result.checks.find((entry) => entry.name === 'process-receipt-worker')).toMatchObject({
      ok: false,
      reason: 'receipt build mismatch',
    });
  });

  test('refuses a descriptor readable by group or world', () => {
    const setup = fixture();
    chmodSync(setup.descriptorPath, 0o644);
    expect(() => verifyDeploymentDescriptor(setup.descriptorPath)).toThrow(
      'descriptor must not be group/world accessible',
    );
  });
});
