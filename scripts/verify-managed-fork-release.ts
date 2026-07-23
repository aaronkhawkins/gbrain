#!/usr/bin/env bun
/**
 * Read-only verifier for one explicit private deployment descriptor.
 *
 * The descriptor contains private paths and stays outside the repository.
 * Output contains only its opaque deployment ID and pass/fail check names.
 */
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProcessBuildReceipt } from '../src/core/build-identity.ts';

type Role = ProcessBuildReceipt['role'];

export interface DeploymentDescriptor {
  schema_version: 1;
  deployment_id: string;
  release_prefix: string;
  release_id: string;
  brain_home: string;
  config_path: string;
  expected_engine: 'postgres' | 'pglite';
  require_selected: boolean;
  expected: {
    version: string;
    channel: string;
    tag: string;
    sha: string;
    upstream_base: string;
    target: {
      os: string;
      arch: string;
      executable_format: string;
      runtime_abi: string;
    };
    deployment_receipt_id: string;
    brain_receipt_id: string;
    config_receipt_id: string;
  };
  process_receipts: Partial<Record<Role, string>>;
}

export interface VerificationResult {
  schema_version: 1;
  deployment_id: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; reason?: string }>;
}

const OPAQUE = /^[A-Za-z0-9._-]{8,128}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function fail(message: string): never {
  throw new Error(message);
}

function assertPrivateDescriptor(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) fail('descriptor must not be group/world accessible');
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`${name} must be an absolute path`);
  return value;
}

function parseDescriptor(path: string): DeploymentDescriptor {
  assertPrivateDescriptor(path);
  const value = JSON.parse(readFileSync(path, 'utf8')) as DeploymentDescriptor;
  if (value.schema_version !== 1) fail('unsupported descriptor schema');
  if (!OPAQUE.test(value.deployment_id)) fail('deployment_id must be opaque');
  for (const [name, candidate] of [
    ['release_prefix', value.release_prefix],
    ['brain_home', value.brain_home],
    ['config_path', value.config_path],
  ] as const) absolutePath(candidate, name);
  if (!OPAQUE.test(value.release_id)) fail('release_id must be opaque');
  if (!['postgres', 'pglite'].includes(value.expected_engine)) fail('invalid expected_engine');
  if (typeof value.require_selected !== 'boolean') fail('require_selected must be boolean');
  if (!OPAQUE.test(value.expected.channel) || !OPAQUE.test(value.expected.tag)) {
    fail('expected channel and tag must be opaque');
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value.expected.version)) {
    fail('expected version must have four numeric parts');
  }
  if (!HEX40.test(value.expected.sha)) fail('expected sha must be a full commit id');
  for (const key of ['deployment_receipt_id', 'brain_receipt_id', 'config_receipt_id'] as const) {
    if (!OPAQUE.test(value.expected[key])) fail(`${key} must be opaque`);
  }
  for (const pathValue of Object.values(value.process_receipts ?? {})) {
    absolutePath(pathValue, 'process receipt');
  }
  return value;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function checkedSpawn(binary: string, args: string[]): any {
  const result = Bun.spawnSync([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '' },
  });
  if (result.exitCode !== 0) fail('compiled identity command failed');
  return JSON.parse(result.stdout.toString());
}

export function verifyDeploymentDescriptor(descriptorPath: string): VerificationResult {
  const descriptor = parseDescriptor(descriptorPath);
  const checks: VerificationResult['checks'] = [];
  const check = (name: string, action: () => void) => {
    try {
      action();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, reason: error instanceof Error ? error.message : 'failed' });
    }
  };

  const releaseDir = join(descriptor.release_prefix, 'releases', descriptor.release_id);
  const binary = join(releaseDir, 'gbrain');
  const manifestPath = join(releaseDir, 'release-manifest.json');
  const manifestChecksumPath = join(releaseDir, 'release-manifest.sha256');
  let manifest: any;
  let identity: any;

  check('descriptor-targets-explicit-installation', () => {
    statSync(descriptor.brain_home);
    statSync(descriptor.config_path);
    statSync(releaseDir);
    if (lstatSync(binary).isSymbolicLink()) fail('binary must not be a symlink');
  });
  check('manifest-and-checksums', () => {
    manifest = readJson(manifestPath);
    const expectedManifestHash = readFileSync(manifestChecksumPath, 'utf8').trim().split(/\s+/)[0];
    if (sha256(manifestPath) !== expectedManifestHash) fail('manifest checksum mismatch');
    if (sha256(binary) !== manifest.binary_sha256) fail('binary checksum mismatch');
    if (manifest.schema_version !== 2) fail('manifest schema must be v2');
    if (manifest.release_id !== descriptor.release_id) fail('manifest release id mismatch');
    if (!manifest.schema_compatibility ||
        !Number.isInteger(manifest.schema_compatibility.min) ||
        !Number.isInteger(manifest.schema_compatibility.max) ||
        manifest.schema_compatibility.min > manifest.schema_compatibility.max) {
      fail('manifest schema compatibility is invalid');
    }
    if (!Array.isArray(manifest.required_runtime_assets)) fail('manifest runtime assets are invalid');
  });
  check('compiled-build-identity', () => {
    const versionDocument = checkedSpawn(binary, ['version', '--json']);
    identity = versionDocument.build;
    const expected = descriptor.expected;
    if (versionDocument.version !== expected.version || manifest.version !== expected.version) {
      fail('version mismatch');
    }
    for (const key of ['channel', 'tag', 'sha', 'upstream_base'] as const) {
      if (identity[key] !== expected[key] || manifest[key] !== expected[key]) {
        fail(`${key} mismatch`);
      }
    }
    if (identity.artifact !== 'compiled' || identity.clean !== true || !identity.managed_fork) {
      fail('artifact is not a clean managed compiled build');
    }
    if (JSON.stringify(identity.target) !== JSON.stringify(expected.target) ||
        JSON.stringify(manifest.target) !== JSON.stringify(expected.target)) {
      fail('target tuple mismatch');
    }
  });
  check('selected-release', () => {
    if (!descriptor.require_selected) return;
    const current = join(descriptor.release_prefix, 'current');
    if (!lstatSync(current).isSymbolicLink()) fail('current is not a symlink');
    const selected = resolve(dirname(current), readlinkSync(current));
    if (realpathSync(selected) !== realpathSync(releaseDir)) fail('selected release mismatch');
  });
  check('engine-identity', () => {
    const config = readJson(descriptor.config_path);
    const actual = config.engine ?? (config.database_url ? 'postgres' : 'pglite');
    if (actual !== descriptor.expected_engine) fail('engine mismatch');
  });

  for (const role of ['cli', 'scheduler', 'supervisor', 'worker'] as const) {
    check(`process-receipt-${role}`, () => {
      const path = descriptor.process_receipts?.[role];
      if (!path) fail('receipt path missing');
      const receipt = readJson(path) as ProcessBuildReceipt;
      if (receipt.schema_version !== 1 || receipt.role !== role) fail('receipt role/schema mismatch');
      if (receipt.build.sha !== descriptor.expected.sha ||
          receipt.build.tag !== descriptor.expected.tag ||
          receipt.build.channel !== descriptor.expected.channel ||
          receipt.build.artifact !== 'compiled') {
        fail('receipt build mismatch');
      }
      for (const key of ['deployment_receipt_id', 'brain_receipt_id', 'config_receipt_id'] as const) {
        if (receipt[key] !== descriptor.expected[key]) fail(`${key} mismatch`);
      }
    });
  }

  return {
    schema_version: 1,
    deployment_id: descriptor.deployment_id,
    ok: checks.every((entry) => entry.ok),
    checks,
  };
}

function main(args: string[]): number {
  const index = args.indexOf('--descriptor');
  if (index < 0 || !args[index + 1]) {
    console.error('Usage: verify-managed-fork-release.ts --descriptor /absolute/private/descriptor.json [--json]');
    return 2;
  }
  try {
    const result = verifyDeploymentDescriptor(absolutePath(args[index + 1], 'descriptor'));
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      console.log(`${result.deployment_id}: ${result.ok ? 'PASS' : 'FAIL'}`);
      for (const entry of result.checks) {
        console.log(`${entry.ok ? 'ok' : 'not ok'} - ${entry.name}${entry.reason ? `: ${entry.reason}` : ''}`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'verification failed');
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
