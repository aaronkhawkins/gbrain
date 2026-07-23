import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const projectRoot = new URL('..', import.meta.url).pathname;
const releaseScript = join(projectRoot, 'scripts', 'build-fork-release.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function makeRepo(tag = 'research-v1'): { root: string; repo: string; prefix: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-fork-release-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const prefix = join(root, 'prefix');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(releaseScript, join(repo, 'scripts', 'build-fork-release.sh'));
  chmodSync(join(repo, 'scripts', 'build-fork-release.sh'), 0o755);
  writeFileSync(join(repo, 'src', 'cli.ts'), `
declare const __GBRAIN_BUILD_CHANNEL__: string;
declare const __GBRAIN_BUILD_TAG__: string;
declare const __GBRAIN_BUILD_SHA__: string;
declare const __GBRAIN_UPSTREAM_BASE__: string;
declare const __GBRAIN_BUILD_CLEAN__: boolean;
if (process.argv[2] === 'version' && process.argv.includes('--json')) {
  console.log(JSON.stringify({ version: 'test', build: {
    channel: __GBRAIN_BUILD_CHANNEL__, tag: __GBRAIN_BUILD_TAG__,
    sha: __GBRAIN_BUILD_SHA__, upstream_base: __GBRAIN_UPSTREAM_BASE__,
    clean: __GBRAIN_BUILD_CLEAN__, artifact: 'compiled', managed_fork: true,
    upgrade_posture: 'fork-managed',
    target: {
      os: process.platform, arch: process.arch,
      executable_format: process.platform === 'darwin' ? 'mach-o' : process.platform === 'linux' ? 'elf' : 'unknown',
      runtime_abi: \`bun-\${Bun.version}\`,
    },
  }}));
} else process.exit(2);
`);
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Release Test');
  git(repo, 'config', 'user.email', 'release-test@example.invalid');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'branch', 'upstream-base');
  git(repo, 'tag', tag);
  return { root, repo, prefix, script: join(repo, 'scripts', 'build-fork-release.sh') };
}

function run(
  repo: string,
  script: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bash', script, ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function buildArgs(prefix: string, tag: string): string[] {
  return [
    'build', '--prefix', prefix, '--tag', tag, '--upstream-ref', 'upstream-base',
    '--schema-min', '122', '--schema-max', '124',
  ];
}

function builtReleaseId(stdout: string): string {
  const match = stdout.match(/(?:^|\n)built ([A-Za-z0-9._-]+)\s*$/);
  if (!match) throw new Error(`missing built release id in output: ${stdout}`);
  return match[1];
}

describe('managed fork release builder', () => {
  test('dirty and tag-mismatched checkouts never create a selectable release', () => {
    const dirty = makeRepo();
    writeFileSync(join(dirty.repo, 'dirty.txt'), 'not committed\n');
    const dirtyResult = run(dirty.repo, dirty.script, buildArgs(dirty.prefix, 'research-v1'));
    expect(dirtyResult.exitCode).not.toBe(0);
    expect(dirtyResult.stderr).toContain('source checkout is dirty');
    expect(existsSync(join(dirty.prefix, 'current'))).toBe(false);

    const mismatch = makeRepo();
    writeFileSync(join(mismatch.repo, 'next.txt'), 'next\n');
    git(mismatch.repo, 'add', '.');
    git(mismatch.repo, 'commit', '-qm', 'next');
    const mismatchResult = run(
      mismatch.repo,
      mismatch.script,
      buildArgs(mismatch.prefix, 'research-v1'),
    );
    expect(mismatchResult.exitCode).not.toBe(0);
    expect(mismatchResult.stderr).toContain('tag/SHA mismatch');
    expect(existsSync(join(mismatch.prefix, 'current'))).toBe(false);
  });

  test('build or smoke failure leaves no release selectable', () => {
    const failedBuild = makeRepo();
    const buildResult = run(failedBuild.repo, failedBuild.script, [
      ...buildArgs(failedBuild.prefix, 'research-v1'), '--bun', '/usr/bin/false',
    ]);
    expect(buildResult.exitCode).not.toBe(0);
    expect(existsSync(join(failedBuild.prefix, 'current'))).toBe(false);

    const failedSmoke = makeRepo();
    const smokeResult = run(failedSmoke.repo, failedSmoke.script, [
      ...buildArgs(failedSmoke.prefix, 'research-v1'), '--smoke-command', '/usr/bin/false',
    ]);
    expect(smokeResult.exitCode).not.toBe(0);
    expect(smokeResult.stderr).toContain('release smoke command failed');
    expect(existsSync(join(failedSmoke.prefix, 'current'))).toBe(false);
    const entries = existsSync(join(failedSmoke.prefix, 'releases'))
      ? Array.from(new Bun.Glob('*').scanSync(join(failedSmoke.prefix, 'releases')))
      : [];
    expect(entries).toEqual([]);
  });

  test('successful releases preserve identity and support verified rollback', () => {
    const fixture = makeRepo();
    const first = run(fixture.repo, fixture.script, buildArgs(fixture.prefix, 'research-v1'));
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(fixture.prefix, 'current'))).toBe(false);
    const firstId = builtReleaseId(first.stdout);
    const firstDir = join(fixture.prefix, 'releases', firstId);
    const firstManifest = JSON.parse(readFileSync(join(firstDir, 'release-manifest.json'), 'utf8'));
    expect(firstManifest.schema_version).toBe(2);
    expect(firstManifest.version).toBe('test');
    expect(firstManifest.channel).toBe('private-research-fork');
    expect(firstManifest.tag).toBe('research-v1');
    expect(firstManifest.clean).toBe(true);
    expect(firstManifest.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(firstManifest.upstream_ref).toBe('upstream-base');
    expect(firstManifest.upstream_base).toMatch(/^upstream-base@[0-9a-f]{40}$/);
    expect(firstManifest.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(firstManifest.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstManifest.schema_compatibility).toEqual({ min: 122, max: 124 });
    expect(firstManifest.required_runtime_assets).toEqual([]);
    expect(firstManifest.target.os).toBe(process.platform);
    const selectFirst = run(fixture.repo, fixture.script, [
      'select', '--prefix', fixture.prefix, '--release-id', firstId,
    ]);
    expect(selectFirst.exitCode).toBe(0);
    const firstTarget = readlinkSync(join(fixture.prefix, 'current'));
    const identity = JSON.parse(Bun.spawnSync(
      [join(firstDir, 'gbrain'), 'version', '--json'],
      { stdout: 'pipe' },
    ).stdout.toString());
    expect(identity.build.tag).toBe(firstManifest.tag);
    expect(identity.build.sha).toBe(firstManifest.sha);
    expect(identity.build.upgrade_posture).toBe('fork-managed');

    const installedPrefix = join(fixture.root, 'installed-prefix');
    const install = run(fixture.repo, fixture.script, [
      'install', '--prefix', installedPrefix, '--from-release', firstDir,
    ]);
    expect(install.exitCode).toBe(0);
    const installedDir = join(installedPrefix, 'releases', firstId);
    expect(readFileSync(join(installedDir, 'gbrain')).equals(readFileSync(join(firstDir, 'gbrain')))).toBe(true);
    expect(readFileSync(join(installedDir, 'release-manifest.json')).equals(
      readFileSync(join(firstDir, 'release-manifest.json')),
    )).toBe(true);
    expect(existsSync(join(installedPrefix, 'current'))).toBe(false);

    // A previous release built by the manifest-v1 tool remains rollbackable,
    // while new selection still requires a v2 candidate.
    const legacyManifest = { ...firstManifest, schema_version: 1 };
    delete legacyManifest.version;
    delete legacyManifest.target;
    delete legacyManifest.schema_compatibility;
    delete legacyManifest.required_runtime_assets;
    const legacyManifestPath = join(firstDir, 'release-manifest.json');
    writeFileSync(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    const legacyHash = new Bun.CryptoHasher('sha256')
      .update(readFileSync(legacyManifestPath))
      .digest('hex');
    writeFileSync(
      join(firstDir, 'release-manifest.sha256'),
      `${legacyHash}  release-manifest.json\n`,
    );

    writeFileSync(join(fixture.repo, 'release-2.txt'), 'second release\n');
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-qm', 'release 2');
    git(fixture.repo, 'tag', 'research-v2');
    const second = run(fixture.repo, fixture.script, buildArgs(fixture.prefix, 'research-v2'));
    expect(second.exitCode).toBe(0);
    const secondId = builtReleaseId(second.stdout);
    const selectSecond = run(fixture.repo, fixture.script, [
      'select', '--prefix', fixture.prefix, '--release-id', secondId,
    ]);
    expect(selectSecond.exitCode).toBe(0);
    const secondTarget = readlinkSync(join(fixture.prefix, 'current'));
    expect(secondTarget).not.toBe(firstTarget);
    expect(readlinkSync(join(fixture.prefix, 'previous'))).toBe(firstTarget);

    const rollback = run(fixture.repo, fixture.script, ['rollback', '--prefix', fixture.prefix]);
    expect(rollback.exitCode).toBe(0);
    expect(readlinkSync(join(fixture.prefix, 'current'))).toBe(firstTarget);
    expect(readlinkSync(join(fixture.prefix, 'previous'))).toBe(secondTarget);
    expect(existsSync(join(fixture.prefix, firstTarget, 'release-manifest.json'))).toBe(true);
    expect(existsSync(join(fixture.prefix, secondTarget, 'release-manifest.json'))).toBe(true);
  }, 30_000);
});
