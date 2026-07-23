/**
 * Regression proof for the Phase 0 help-path migration incident.
 *
 * A release is a compiled executable, so a source-only fresh-home test is not
 * enough. This test gives the compiled binary a real, configured, disposable
 * PGLite database whose schema is intentionally behind current migrations.
 * Every supported embed-help spelling must leave both the database and the
 * file/startup-hook planes byte-for-byte unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const repoRoot = process.cwd();
let root: string;
let home: string;
let dbPath: string;
let binaryPath: string;
let configPath: string;
let breadcrumbPath: string;
let cachePath: string;

interface Sentinel {
  version: string;
  tables: string[];
}

async function readSentinel(): Promise<Sentinel> {
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dbPath });
  try {
    const versionResult = await engine.db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'version'`,
    );
    const tableResult = await engine.db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    return {
      version: versionResult.rows[0]?.value ?? '',
      tables: tableResult.rows.map((row) => row.table_name),
    };
  } finally {
    await engine.disconnect();
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-compiled-help-'));
  home = join(root, 'home');
  dbPath = join(root, 'sentinel-pglite');
  binaryPath = join(root, 'gbrain');
  const gbrainDir = join(home, '.gbrain');
  configPath = join(gbrainDir, 'config.json');
  breadcrumbPath = join(gbrainDir, 'just-upgraded-from');
  cachePath = join(gbrainDir, 'last-update-check');
  mkdirSync(gbrainDir, { recursive: true });

  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dbPath });
  try {
    await engine.db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO config (key, value) VALUES ('version', '1');
    `);
  } finally {
    await engine.disconnect();
  }

  writeFileSync(configPath, JSON.stringify({
    engine: 'pglite',
    database_path: dbPath,
  }, null, 2) + '\n');
  writeFileSync(breadcrumbPath, '0.42.0\n');
  writeFileSync(cachePath, 'UPGRADE_AVAILABLE 0.42.0 0.99.0\n');

  const build = Bun.spawnSync(
    ['bun', 'build', 'src/cli.ts', '--compile', '--outfile', binaryPath],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(
    build.exitCode,
    `compiled CLI build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`,
  ).toBe(0);
  expect(existsSync(binaryPath)).toBe(true);
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('compiled embed help is observational', () => {
  const invocations = [
    ['embed', '--help'],
    ['embed', '-h'],
    ['--quiet', 'embed', '--help'],
    ['embed', '--help', '--quiet'],
    ['--progress-json', 'embed', '-h'],
  ];

  for (const argv of invocations) {
    test(argv.join(' '), async () => {
      const beforeDb = await readSentinel();
      const beforeConfig = readFileSync(configPath, 'utf8');
      const beforeBreadcrumb = readFileSync(breadcrumbPath, 'utf8');
      const beforeCache = readFileSync(cachePath, 'utf8');
      const env = { ...process.env } as Record<string, string>;
      delete env.DATABASE_URL;
      delete env.GBRAIN_DATABASE_URL;
      delete env.GBRAIN_SKIP_STARTUP_HOOKS;
      env.NODE_ENV = 'production';
      env.GBRAIN_HOME = home;
      env.GBRAIN_SELF_UPGRADE_MODE = 'notify';

      const run = Bun.spawnSync([binaryPath, ...argv], {
        cwd: repoRoot,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(run.stdout.toString()).toContain('Usage: gbrain embed');
      expect(run.stderr.toString()).not.toContain('UPGRADE_AVAILABLE');
      expect(run.stderr.toString()).not.toContain('JUST_UPGRADED');
      expect(await readSentinel()).toEqual(beforeDb);
      expect(readFileSync(configPath, 'utf8')).toBe(beforeConfig);
      expect(readFileSync(breadcrumbPath, 'utf8')).toBe(beforeBreadcrumb);
      expect(readFileSync(cachePath, 'utf8')).toBe(beforeCache);
    }, 60_000);
  }
});
