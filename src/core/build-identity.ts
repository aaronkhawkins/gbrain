/**
 * Build identity embedded by the managed-fork release builder.
 *
 * Release builds pass these names through Bun's `--define` option. Source
 * checkouts and ordinary upstream builds intentionally fall back to a small,
 * non-secret identity rather than inspecting git or the filesystem at runtime.
 */
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
  };
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
