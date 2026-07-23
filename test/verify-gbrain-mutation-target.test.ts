import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeMutationTargetId,
  mutationCommandSha256,
  signMutationAllowToken,
  verifyMutationTarget,
  type DatabaseProbeResult,
  type MutationAllowToken,
  type MutationExecution,
  type MutationTargetDescriptor,
  type VerifyDependencies,
} from '../scripts/verify-gbrain-mutation-target.ts';

const roots: string[] = [];
const approvalSecret = 'test-only-independent-approval-secret-material-0001';
const now = new Date('2029-01-01T00:00:00.000Z');
const command = ['gbrain', 'embed', '--all'];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const probeResult: DatabaseProbeResult = {
  engine: 'postgres',
  database: 'gbrain_test',
  current_schema: 'public',
  schema_version: '124',
  transaction_read_only: true,
  aggregates: {
    pages: 100,
    sources: 2,
    content_chunks: 250,
    facts: 10,
    minion_jobs: 20,
  },
};

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-mutation-target-'));
  roots.push(root);
  const cwd = join(root, 'cwd');
  const gbrainHome = join(root, 'brain-home');
  const configDir = join(gbrainHome, '.gbrain');
  mkdirSync(cwd);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, 'config.json');
  const descriptorPath = join(root, 'descriptor.json');
  const tokenPath = join(root, 'token.json');
  const databaseUrl = 'postgresql://user:secret@db.example.test:5432/gbrain_test';
  privateJson(configPath, { engine: 'postgres', database_url: databaseUrl });
  const targetId = computeMutationTargetId(
    approvalSecret,
    { host: 'db.example.test', port: 5432, database: 'gbrain_test' },
    probeResult,
  );
  const descriptor: MutationTargetDescriptor = {
    schema_version: 2,
    deployment_id: 'deployment-test-0001',
    operation: 'rebuild-embeddings',
    config_path: configPath,
    runtime_cwd: cwd,
    expected_engine: 'postgres',
    expected_target_id: targetId,
    expected_aggregates: {
      pages: { min: 90, max: 110 },
      sources: { min: 2, max: 2 },
      content_chunks: { min: 240, max: 260 },
      facts: { min: 10, max: 10 },
      minion_jobs: { min: 0, max: 30 },
    },
  };
  const unsignedToken: Omit<MutationAllowToken, 'mac'> = {
    schema_version: 2,
    token_id: 'allow-token-0001',
    deployment_id: descriptor.deployment_id,
    operation: descriptor.operation,
    target_id: targetId,
    command_sha256: mutationCommandSha256(command),
    expires_at: '2030-01-01T00:00:00.000Z',
    nonce: 'nonce-value-0001',
  };
  const token = signMutationAllowToken(unsignedToken, approvalSecret);
  privateJson(descriptorPath, descriptor);
  privateJson(tokenPath, token);
  const env = { GBRAIN_HOME: gbrainHome };
  const dependencies: VerifyDependencies = {
    env,
    runtimeCwd: cwd,
    approvalSecret,
    now,
    probe: async () => probeResult,
  };
  return {
    root,
    cwd,
    gbrainHome,
    configPath,
    databaseUrl,
    descriptorPath,
    tokenPath,
    descriptor,
    token,
    env,
    dependencies,
  };
}

describe('mutation target verifier', () => {
  test('verifies read-only without consuming or executing by default', async () => {
    const f = fixture();
    let consumed = 0;
    let executed = 0;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      probe: async (url) => {
        expect(url).toBe(f.databaseUrl);
        return probeResult;
      },
      consume: () => { consumed++; },
      execute: async () => {
        executed++;
        return 0;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.authorized).toBe(false);
    expect(result.executed).toBe(false);
    expect(consumed).toBe(0);
    expect(executed).toBe(0);
    expect(result.checks.map((check) => check.name)).toEqual([
      'private-descriptor',
      'runtime-route-bound',
      'effective-target-agreement',
      'read-only-database-identity',
      'bounded-aggregate-expectations',
      'signed-operation-bound-token',
    ]);
  });

  test('authorize consumes then executes the exact command in the frozen route', async () => {
    const f = fixture();
    let execution: MutationExecution | undefined;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, true, command, {
      ...f.dependencies,
      env: {
        ...f.env,
        DATABASE_URL: f.databaseUrl,
        GBRAIN_MUTATION_APPROVAL_SECRET: approvalSecret,
      },
      execute: async (value) => {
        execution = value;
        return 0;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.executed).toBe(true);
    expect(execution?.command).toEqual(command);
    expect(execution?.cwd).toBe(f.cwd);
    expect(execution?.env.GBRAIN_HOME).toBe(f.gbrainHome);
    expect(execution?.env.GBRAIN_DATABASE_URL).toBe(f.databaseUrl);
    expect(execution?.env.DATABASE_URL).toBeUndefined();
    expect(execution?.env.GBRAIN_MUTATION_APPROVAL_SECRET).toBeUndefined();
  });

  test('refuses a descriptor cwd that differs from the actual execution cwd', async () => {
    const f = fixture();
    const otherCwd = join(f.root, 'other-cwd');
    mkdirSync(otherCwd);
    let probed = false;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      runtimeCwd: otherCwd,
      probe: async () => {
        probed = true;
        return probeResult;
      },
    });
    expect(result.ok).toBe(false);
    expect(probed).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'runtime-route-bound', ok: false });
  });

  test('refuses config_path that is not canonical for the active GBRAIN_HOME', async () => {
    const f = fixture();
    const otherHome = join(f.root, 'other-home');
    mkdirSync(join(otherHome, '.gbrain'), { recursive: true });
    let probed = false;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      env: { GBRAIN_HOME: otherHome },
      probe: async () => {
        probed = true;
        return probeResult;
      },
    });
    expect(result.ok).toBe(false);
    expect(probed).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'runtime-route-bound', ok: false });
  });

  test('refuses non-private and symlinked active config files', async () => {
    const f = fixture();
    chmodSync(f.configPath, 0o644);
    const broad = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      command,
      f.dependencies,
    );
    expect(broad.ok).toBe(false);
    expect(broad.checks.at(-1)).toEqual({ name: 'effective-target-agreement', ok: false });

    chmodSync(f.configPath, 0o600);
    const realConfig = join(f.root, 'real-config.json');
    copyFileSync(f.configPath, realConfig);
    chmodSync(realConfig, 0o600);
    rmSync(f.configPath);
    symlinkSync(realConfig, f.configPath);
    const linked = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      command,
      f.dependencies,
    );
    expect(linked.ok).toBe(false);
    expect(linked.checks.at(-1)).toEqual({ name: 'effective-target-agreement', ok: false });
  });

  test('refuses descriptors missing any required aggregate bound', async () => {
    const f = fixture();
    const invalid = {
      ...f.descriptor,
      expected_aggregates: {
        pages: f.descriptor.expected_aggregates.pages,
        sources: f.descriptor.expected_aggregates.sources,
      },
    };
    privateJson(f.descriptorPath, invalid);
    const result = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      command,
      f.dependencies,
    );
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([{ name: 'private-descriptor', ok: false }]);
  });

  test('refuses a database whose server identity disagrees with the URL', async () => {
    const f = fixture();
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      probe: async () => ({ ...probeResult, database: 'wrong_test' }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'read-only-database-identity', ok: false });
  });

  test('refuses env and file target disagreement before connecting', async () => {
    const f = fixture();
    let probed = false;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      env: {
        GBRAIN_HOME: f.gbrainHome,
        GBRAIN_DATABASE_URL: 'postgresql://u:p@other.example.test/other_test',
      },
      probe: async () => {
        probed = true;
        return probeResult;
      },
    });
    expect(result.ok).toBe(false);
    expect(probed).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'effective-target-agreement', ok: false });
  });

  test('ignores cwd-dotenv DATABASE_URL exactly as GBrain does', async () => {
    const f = fixture();
    const dotenvUrl = 'postgresql://u:p@wrong.example.test/wrong_test';
    writeFileSync(join(f.cwd, '.env'), `DATABASE_URL=${dotenvUrl}\n`);
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      env: { GBRAIN_HOME: f.gbrainHome, DATABASE_URL: dotenvUrl },
      probe: async (url) => {
        expect(url).toBe(f.databaseUrl);
        return probeResult;
      },
    });
    expect(result.ok).toBe(true);
  });

  test('refuses a caller operation that differs from the descriptor', async () => {
    const f = fixture();
    let probed = false;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      operation: 'apply-migrations',
      probe: async () => {
        probed = true;
        return probeResult;
      },
    });
    expect(result.ok).toBe(false);
    expect(probed).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'runtime-route-bound', ok: false });
  });

  test('refuses forged, wrong-command, and expired signed tokens', async () => {
    const f = fixture();
    privateJson(f.tokenPath, { ...f.token, operation: 'apply-migrations' });
    const forged = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      command,
      f.dependencies,
    );
    expect(forged.ok).toBe(false);
    expect(forged.checks.at(-1)).toEqual({ name: 'signed-operation-bound-token', ok: false });

    privateJson(f.tokenPath, f.token);
    const wrongCommand = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      ['gbrain', 'apply-migrations', '--yes'],
      f.dependencies,
    );
    expect(wrongCommand.ok).toBe(false);
    expect(wrongCommand.checks.at(-1)).toEqual({ name: 'signed-operation-bound-token', ok: false });

    const { mac: _priorMac, ...unsigned } = f.token;
    const expired = signMutationAllowToken(
      { ...unsigned, expires_at: '2028-01-01T00:00:00.000Z' },
      approvalSecret,
    );
    privateJson(f.tokenPath, expired);
    const stale = await verifyMutationTarget(
      f.descriptorPath,
      f.tokenPath,
      false,
      command,
      f.dependencies,
    );
    expect(stale.ok).toBe(false);
    expect(stale.checks.at(-1)).toEqual({ name: 'signed-operation-bound-token', ok: false });
  });

  test('copied token files cannot replay against the fixed brain ledger', async () => {
    const f = fixture();
    const copiedToken = join(f.root, 'copied-token.json');
    copyFileSync(f.tokenPath, copiedToken);
    chmodSync(copiedToken, 0o600);
    const execute = async () => 0;
    const first = await verifyMutationTarget(f.descriptorPath, f.tokenPath, true, command, {
      ...f.dependencies,
      execute,
    });
    const second = await verifyMutationTarget(f.descriptorPath, copiedToken, true, command, {
      ...f.dependencies,
      execute,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.checks.at(-1)).toEqual({ name: 'one-time-token-consumed', ok: false });
  });

  test('refuses aggregate drift outside declared bounds', async () => {
    const f = fixture();
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, false, command, {
      ...f.dependencies,
      probe: async () => ({
        ...probeResult,
        aggregates: { ...probeResult.aggregates, pages: 111 },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toEqual({ name: 'bounded-aggregate-expectations', ok: false });
  });

  test('config changes after verification burn no token and execute no command', async () => {
    const f = fixture();
    let consumed = 0;
    let executed = 0;
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, true, command, {
      ...f.dependencies,
      probe: async () => {
        privateJson(f.configPath, {
          engine: 'postgres',
          database_url: 'postgresql://u:p@other.example.test/other_test',
        });
        return probeResult;
      },
      consume: () => { consumed++; },
      execute: async () => {
        executed++;
        return 0;
      },
    });
    expect(result.ok).toBe(false);
    expect(consumed).toBe(0);
    expect(executed).toBe(0);
    expect(result.checks.at(-1)).toEqual({ name: 'config-unchanged-before-exec', ok: false });
  });

  test('nonzero child exit remains an executed, consumed authorization failure', async () => {
    const f = fixture();
    const result = await verifyMutationTarget(f.descriptorPath, f.tokenPath, true, command, {
      ...f.dependencies,
      execute: async () => 17,
    });
    expect(result.ok).toBe(false);
    expect(result.authorized).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.command_exit_code).toBe(17);
    expect(result.checks.at(-1)).toEqual({ name: 'verified-mutation-executed', ok: false });
  });
});
