/**
 * Build identity embedded by the managed-fork release builder.
 *
 * Release builds pass these names through Bun's `--define` option. Source
 * checkouts and ordinary upstream builds intentionally fall back to a small,
 * non-secret identity rather than inspecting git or the filesystem at runtime.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

declare const __GBRAIN_BUILD_CHANNEL__: string | undefined;
declare const __GBRAIN_BUILD_TAG__: string | undefined;
declare const __GBRAIN_BUILD_SHA__: string | undefined;
declare const __GBRAIN_UPSTREAM_BASE__: string | undefined;
declare const __GBRAIN_BUILD_CLEAN__: boolean | undefined;

export interface BuildIdentity {
  channel: string;
  tag: string | null;
  sha: string | null;
  upstream_base: string | null;
  clean: boolean | null;
  artifact: 'compiled' | 'source';
  managed_fork: boolean;
  upgrade_posture: 'upstream-managed' | 'fork-managed';
  target: BuildTarget;
}

export interface BuildTarget {
  os: string;
  arch: string;
  executable_format: 'mach-o' | 'elf' | 'pe' | 'unknown';
  runtime_abi: string;
}

export interface ProcessBuildReceipt {
  schema_version: 1;
  role: 'cli' | 'scheduler' | 'supervisor' | 'worker';
  build: BuildIdentity;
  deployment_receipt_id: string | null;
  brain_receipt_id: string | null;
  config_receipt_id: string | null;
}

function executableFormat(): BuildTarget['executable_format'] {
  if (process.platform === 'darwin') return 'mach-o';
  if (process.platform === 'linux') return 'elf';
  if (process.platform === 'win32') return 'pe';
  return 'unknown';
}

function opaqueReceiptId(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._-]{8,128}$/.test(normalized) ? normalized : null;
}

function compiledString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getBuildIdentity(): BuildIdentity {
  const channel = compiledString(
    typeof __GBRAIN_BUILD_CHANNEL__ !== 'undefined' ? __GBRAIN_BUILD_CHANNEL__ : undefined,
  ) ?? 'upstream';
  const tag = compiledString(
    typeof __GBRAIN_BUILD_TAG__ !== 'undefined' ? __GBRAIN_BUILD_TAG__ : undefined,
  );
  const sha = compiledString(
    typeof __GBRAIN_BUILD_SHA__ !== 'undefined' ? __GBRAIN_BUILD_SHA__ : undefined,
  );
  const upstreamBase = compiledString(
    typeof __GBRAIN_UPSTREAM_BASE__ !== 'undefined' ? __GBRAIN_UPSTREAM_BASE__ : undefined,
  );
  const clean = typeof __GBRAIN_BUILD_CLEAN__ !== 'undefined'
    ? __GBRAIN_BUILD_CLEAN__
    : null;
  const managedFork = channel !== 'upstream';

  return {
    channel,
    tag,
    sha,
    upstream_base: upstreamBase,
    clean,
    artifact: typeof Bun !== 'undefined' && Bun.main.endsWith('/src/cli.ts') ? 'source' : 'compiled',
    managed_fork: managedFork,
    upgrade_posture: managedFork ? 'fork-managed' : 'upstream-managed',
    target: {
      os: process.platform,
      arch: process.arch,
      executable_format: executableFormat(),
      runtime_abi: `bun-${Bun.version}`,
    },
  };
}

/** Content-free process identity for deployment receipts and daemon audit events. */
export function getProcessBuildReceipt(
  role: ProcessBuildReceipt['role'],
  identity: BuildIdentity = getBuildIdentity(),
): ProcessBuildReceipt {
  return {
    schema_version: 1,
    role,
    build: identity,
    deployment_receipt_id: opaqueReceiptId(process.env.GBRAIN_DEPLOYMENT_RECEIPT_ID),
    brain_receipt_id: opaqueReceiptId(process.env.GBRAIN_BRAIN_RECEIPT_ID),
    config_receipt_id: opaqueReceiptId(process.env.GBRAIN_CONFIG_RECEIPT_ID),
  };
}

/**
 * Persist a private process receipt only when the service explicitly supplies
 * an absolute role-specific path. The deployment descriptor owns that path.
 */
export function persistProcessBuildReceipt(receipt: ProcessBuildReceipt): void {
  const key = `GBRAIN_${receipt.role.toUpperCase()}_RECEIPT_FILE`;
  const path = process.env[key]?.trim();
  if (!path) return;
  if (!isAbsolute(path)) throw new Error(`${key} must be absolute`);
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export interface UpgradeGuard {
  allowed: boolean;
  reason: string | null;
  identity: BuildIdentity;
}

/** One policy shared by manual, universal and autopilot self-upgrade paths. */
export function managedForkUpgradeGuard(identity: BuildIdentity = getBuildIdentity()): UpgradeGuard {
  if (!identity.managed_fork) return { allowed: true, reason: null, identity };
  return {
    allowed: false,
    reason: `This ${identity.channel} build is fork-managed; install a verified fork release instead of an upstream self-upgrade.`,
    identity,
  };
}
