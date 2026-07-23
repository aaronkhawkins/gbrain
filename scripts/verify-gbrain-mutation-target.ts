#!/usr/bin/env bun
/**
 * Fail-closed target verifier and executor for approved GBrain mutations.
 *
 * The verifier never initializes a GBrain engine. It probes PostgreSQL inside
 * one read-only transaction, consumes a signed one-time approval from a fixed
 * per-brain ledger, then directly execs the approved argv under the verified
 * cwd and a frozen GBRAIN_DATABASE_URL. There is no shell and no gap where an
 * operator must copy a successful fingerprint into a separate command.
 *
 * Descriptor, token, active config, and approval-secret files must be regular,
 * non-symlink, mode-0600 files. CLI output owned by this verifier contains only
 * opaque IDs and check names; the explicitly approved child retains its normal
 * stdout/stderr.
 */
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import postgres from 'postgres';

const OPAQUE = /^[A-Za-z0-9._-]{8,128}$/;
const OPERATION = /^[a-z][a-z0-9-]{2,63}$/;
const TARGET_ID = /^target_[0-9a-f]{64}$/;
const TOKEN_MAC = /^[0-9a-f]{64}$/;
const AGGREGATE_NAMES = ['pages', 'sources', 'content_chunks', 'facts', 'minion_jobs'] as const;
type AggregateName = typeof AGGREGATE_NAMES[number];
type AggregateBounds = Record<AggregateName, { min: number; max: number }>;
type Secret = string | Uint8Array;

export interface MutationTargetDescriptor {
  schema_version: 2;
  deployment_id: string;
  operation: string;
  config_path: string;
  runtime_cwd: string;
  expected_engine: 'postgres';
  expected_target_id: string;
  expected_aggregates: AggregateBounds;
}

export interface MutationAllowToken {
  schema_version: 2;
  token_id: string;
  deployment_id: string;
  operation: string;
  target_id: string;
  command_sha256: string;
  expires_at: string;
  nonce: string;
  mac: string;
}

export interface DatabaseProbeResult {
  engine: 'postgres';
  database: string;
  current_schema: string;
  schema_version: string;
  transaction_read_only: boolean;
  aggregates: Record<AggregateName, number>;
}

export interface MutationTargetResult {
  schema_version: 2;
  deployment_id: string;
  target_id?: string;
  authorized: boolean;
  executed: boolean;
  command_exit_code?: number;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean }>;
}

export interface MutationExecution {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface VerifyDependencies {
  env?: Record<string, string | undefined>;
  now?: Date;
  operation?: string;
  runtimeCwd?: string;
  approvalSecret?: Secret;
  probe?: (databaseUrl: string) => Promise<DatabaseProbeResult>;
  consume?: (
    descriptor: MutationTargetDescriptor,
    token: MutationAllowToken,
    approvalSecret: Secret,
  ) => void;
  execute?: (execution: MutationExecution) => Promise<number>;
}

interface ConnectionIdentity {
  host: string;
  port: number;
  database: string;
}

interface PrivateFile {
  bytes: Buffer;
  digest: string;
}

interface EffectiveTarget {
  databaseUrl: string;
  identity: ConnectionIdentity;
  configDigest: string;
}

function fail(): never {
  throw new Error('mutation target verification failed');
}

function secretBytes(secret: Secret): Uint8Array {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (bytes.byteLength < 32) fail();
  return bytes;
}

/**
 * Read exactly one already-opened regular file. O_NOFOLLOW plus fstat closes
 * the symlink and check-then-open races that stat(path) + readFile(path) leaves.
 */
function readPrivateFile(path: string): PrivateFile {
  if (!isAbsolute(path)) fail();
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) fail();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail();
    const bytes = readFileSync(fd);
    return {
      bytes,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    fail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fail();
}

function readPrivateJson<T>(path: string): T {
  try {
    return JSON.parse(readPrivateFile(path).bytes.toString('utf8')) as T;
  } catch {
    fail();
  }
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value);
}

function parseDescriptor(path: string): MutationTargetDescriptor {
  const value = readPrivateJson<MutationTargetDescriptor>(path);
  if (
    value.schema_version !== 2 ||
    !OPAQUE.test(value.deployment_id) ||
    !OPERATION.test(value.operation) ||
    !validAbsolutePath(value.config_path) ||
    !validAbsolutePath(value.runtime_cwd) ||
    value.expected_engine !== 'postgres' ||
    !TARGET_ID.test(value.expected_target_id) ||
    !value.expected_aggregates
  ) fail();
  for (const name of AGGREGATE_NAMES) {
    const bounds = value.expected_aggregates[name];
    if (
      !bounds ||
      !Number.isSafeInteger(bounds.min) ||
      !Number.isSafeInteger(bounds.max) ||
      bounds.min < 0 ||
      bounds.max < bounds.min
    ) fail();
  }
  if (Object.keys(value.expected_aggregates).some(
    (name) => !AGGREGATE_NAMES.includes(name as AggregateName),
  )) fail();
  return value;
}

function canonicalConfigPath(env: Record<string, string | undefined>): string {
  const override = env.GBRAIN_HOME?.trim();
  if (override) {
    if (!isAbsolute(override) || override.split(/[\\/]/).includes('..')) fail();
    return join(override, '.gbrain', 'config.json');
  }
  return join(homedir(), '.gbrain', 'config.json');
}

function assertRuntimeBinding(
  descriptor: MutationTargetDescriptor,
  env: Record<string, string | undefined>,
  runtimeCwd: string,
): void {
  if (
    realpathSync(descriptor.runtime_cwd) !== realpathSync(runtimeCwd) ||
    resolve(descriptor.config_path) !== resolve(canonicalConfigPath(env))
  ) fail();
}

function dotenvDatabaseUrls(dir: string): Set<string> {
  const result = new Set<string>();
  const names = ['.env', '.env.local', '.env.development', '.env.production', '.env.test'];
  const assignment = /^(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/;
  for (const name of names) {
    let contents: string;
    try {
      contents = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const raw of contents.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(assignment);
      if (!match) continue;
      let candidate = match[1].trim();
      if (
        candidate.length >= 2 &&
        ((candidate.startsWith('"') && candidate.endsWith('"')) ||
          (candidate.startsWith("'") && candidate.endsWith("'")))
      ) {
        candidate = candidate.slice(1, -1);
      } else {
        const comment = candidate.indexOf(' #');
        if (comment >= 0) candidate = candidate.slice(0, comment).trim();
      }
      if (candidate) result.add(candidate);
    }
  }
  return result;
}

function connectionIdentity(databaseUrl: string): ConnectionIdentity {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    fail();
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail();
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!url.hostname || !database || database.includes('/')) fail();
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail();
  return {
    host: url.hostname.toLowerCase().replace(/\.$/, ''),
    port,
    database,
  };
}

function sameConnection(left: ConnectionIdentity, right: ConnectionIdentity): boolean {
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

function resolveEffectiveTarget(
  descriptor: MutationTargetDescriptor,
  env: Record<string, string | undefined>,
): EffectiveTarget {
  let file: { engine?: unknown; database_url?: unknown };
  const config = readPrivateFile(descriptor.config_path);
  try {
    file = JSON.parse(config.bytes.toString('utf8'));
  } catch {
    fail();
  }
  if (file.engine !== 'postgres' || typeof file.database_url !== 'string') fail();
  const fileIdentity = connectionIdentity(file.database_url);

  // Match GBrain precedence and its cwd-dotenv safety rule:
  // GBRAIN_DATABASE_URL > deliberate DATABASE_URL > config file.
  const genericCandidate = env.DATABASE_URL;
  const genericEnv = genericCandidate &&
    !dotenvDatabaseUrls(descriptor.runtime_cwd).has(genericCandidate)
    ? genericCandidate
    : undefined;
  const envUrl = env.GBRAIN_DATABASE_URL || genericEnv;
  let envIdentity: ConnectionIdentity | undefined;
  if (env.GBRAIN_DATABASE_URL && genericEnv) {
    const namespaced = connectionIdentity(env.GBRAIN_DATABASE_URL);
    const generic = connectionIdentity(genericEnv);
    if (!sameConnection(namespaced, generic)) fail();
  }
  if (envUrl) {
    envIdentity = connectionIdentity(envUrl);
    if (!sameConnection(envIdentity, fileIdentity)) fail();
  }
  return {
    databaseUrl: envUrl ?? file.database_url,
    identity: envIdentity ?? fileIdentity,
    configDigest: config.digest,
  };
}

export function computeMutationTargetId(
  approvalSecret: Secret,
  connection: ConnectionIdentity,
  probe: Pick<DatabaseProbeResult, 'engine' | 'database' | 'current_schema' | 'schema_version'>,
): string {
  const canonical = JSON.stringify({
    engine: probe.engine,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    server_database: probe.database,
    current_schema: probe.current_schema,
    schema_version: probe.schema_version,
  });
  return `target_${createHmac('sha256', secretBytes(approvalSecret)).update(canonical).digest('hex')}`;
}

export function mutationCommandSha256(command: string[]): string {
  if (command.length === 0 || command.some((part) => typeof part !== 'string' || part.length === 0)) fail();
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function unsignedTokenDocument(token: Omit<MutationAllowToken, 'mac'>): string {
  return JSON.stringify([
    token.schema_version,
    token.token_id,
    token.deployment_id,
    token.operation,
    token.target_id,
    token.command_sha256,
    token.expires_at,
    token.nonce,
  ]);
}

export function signMutationAllowToken(
  token: Omit<MutationAllowToken, 'mac'>,
  approvalSecret: Secret,
): MutationAllowToken {
  return {
    ...token,
    mac: createHmac('sha256', secretBytes(approvalSecret))
      .update(unsignedTokenDocument(token))
      .digest('hex'),
  };
}

async function productionProbe(databaseUrl: string): Promise<DatabaseProbeResult> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
    prepare: false,
    onnotice: () => {},
  });
  try {
    return await sql.begin('read only', async (tx) => {
      const rows = await tx<{
        database: string;
        current_schema: string;
        transaction_read_only: string;
        schema_version: string | null;
        pages: string;
        sources: string;
        content_chunks: string;
        facts: string;
        minion_jobs: string;
      }[]>`
        SELECT current_database() AS database,
               current_schema() AS current_schema,
               current_setting('transaction_read_only') AS transaction_read_only,
               (SELECT value FROM config WHERE key = 'version') AS schema_version,
               (SELECT count(*)::text FROM pages) AS pages,
               (SELECT count(*)::text FROM sources) AS sources,
               (SELECT count(*)::text FROM content_chunks) AS content_chunks,
               (SELECT count(*)::text FROM facts) AS facts,
               (SELECT count(*)::text FROM minion_jobs) AS minion_jobs
      `;
      const row = rows[0];
      if (!row || row.transaction_read_only !== 'on' || !row.schema_version) fail();
      const aggregates = Object.fromEntries(
        AGGREGATE_NAMES.map((name) => [name, Number(row[name])]),
      ) as Record<AggregateName, number>;
      if (Object.values(aggregates).some((value) => !Number.isSafeInteger(value) || value < 0)) fail();
      return {
        engine: 'postgres',
        database: row.database,
        current_schema: row.current_schema,
        schema_version: row.schema_version,
        transaction_read_only: true,
        aggregates,
      };
    });
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function parseAndVerifyToken(
  tokenPath: string,
  descriptor: MutationTargetDescriptor,
  targetId: string,
  command: string[],
  now: Date,
  approvalSecret: Secret,
): MutationAllowToken {
  const token = readPrivateJson<MutationAllowToken>(tokenPath);
  const expiry = Date.parse(token.expires_at);
  if (
    token.schema_version !== 2 ||
    !OPAQUE.test(token.token_id) ||
    !OPAQUE.test(token.nonce) ||
    token.deployment_id !== descriptor.deployment_id ||
    token.operation !== descriptor.operation ||
    token.target_id !== targetId ||
    token.command_sha256 !== mutationCommandSha256(command) ||
    !Number.isFinite(expiry) ||
    expiry <= now.getTime() ||
    !TOKEN_MAC.test(token.mac)
  ) fail();
  const expected = signMutationAllowToken(
    {
      schema_version: token.schema_version,
      token_id: token.token_id,
      deployment_id: token.deployment_id,
      operation: token.operation,
      target_id: token.target_id,
      command_sha256: token.command_sha256,
      expires_at: token.expires_at,
      nonce: token.nonce,
    },
    approvalSecret,
  ).mac;
  if (!timingSafeEqual(Buffer.from(token.mac, 'hex'), Buffer.from(expected, 'hex'))) fail();
  return token;
}

function ledgerDirectory(descriptor: MutationTargetDescriptor): string {
  return join(dirname(descriptor.config_path), 'mutation-authorization-ledger');
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail();
}

function consumeToken(
  descriptor: MutationTargetDescriptor,
  token: MutationAllowToken,
  approvalSecret: Secret,
): void {
  const ledger = ledgerDirectory(descriptor);
  mkdirSync(ledger, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(ledger);
  const markerId = createHmac('sha256', secretBytes(approvalSecret))
    .update(`${token.token_id}\0${token.nonce}`)
    .digest('hex');
  const marker = join(ledger, `consumed-${markerId}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      marker,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeSync(fd, `${token.token_id}\n`);
  } catch {
    fail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function frozenChildEnv(
  env: Record<string, string | undefined>,
  databaseUrl: string,
): Record<string, string> {
  const frozen = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete frozen.DATABASE_URL;
  delete frozen.GBRAIN_MUTATION_APPROVAL_SECRET;
  delete frozen.GBRAIN_MUTATION_APPROVAL_SECRET_FILE;
  frozen.GBRAIN_DATABASE_URL = databaseUrl;
  return frozen;
}

async function executeMutation(execution: MutationExecution): Promise<number> {
  const child = Bun.spawn(execution.command, {
    cwd: execution.cwd,
    env: execution.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

export async function verifyMutationTarget(
  descriptorPath: string,
  tokenPath: string,
  authorize: boolean,
  command: string[],
  dependencies: VerifyDependencies = {},
): Promise<MutationTargetResult> {
  const checks: MutationTargetResult['checks'] = [];
  let deploymentId = 'invalid-deployment';
  let targetId: string | undefined;
  let authorized = false;
  let executed = false;
  let commandExitCode: number | undefined;
  const check = async (name: string, action: () => void | Promise<void>) => {
    try {
      await action();
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false });
      throw new Error(name);
    }
  };

  try {
    const env = dependencies.env ?? process.env;
    const runtimeCwd = dependencies.runtimeCwd ?? process.cwd();
    const approvalSecret = dependencies.approvalSecret;
    if (!approvalSecret) fail();
    secretBytes(approvalSecret);
    let descriptor!: MutationTargetDescriptor;
    let effective!: EffectiveTarget;
    let probe!: DatabaseProbeResult;
    let token!: MutationAllowToken;
    await check('private-descriptor', () => {
      descriptor = parseDescriptor(resolve(descriptorPath));
      deploymentId = descriptor.deployment_id;
    });
    await check('runtime-route-bound', () => {
      assertRuntimeBinding(descriptor, env, runtimeCwd);
      if (dependencies.operation !== undefined && dependencies.operation !== descriptor.operation) fail();
    });
    await check('effective-target-agreement', () => {
      effective = resolveEffectiveTarget(descriptor, env);
    });
    await check('read-only-database-identity', async () => {
      probe = await (dependencies.probe ?? productionProbe)(effective.databaseUrl);
      if (
        probe.engine !== 'postgres' ||
        probe.transaction_read_only !== true ||
        probe.database !== effective.identity.database
      ) fail();
      targetId = computeMutationTargetId(approvalSecret, effective.identity, probe);
      if (targetId !== descriptor.expected_target_id) fail();
    });
    await check('bounded-aggregate-expectations', () => {
      for (const name of AGGREGATE_NAMES) {
        const value = probe.aggregates[name];
        const bounds = descriptor.expected_aggregates[name];
        if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) fail();
      }
    });
    await check('signed-operation-bound-token', () => {
      token = parseAndVerifyToken(
        resolve(tokenPath),
        descriptor,
        targetId!,
        command,
        dependencies.now ?? new Date(),
        approvalSecret,
      );
    });
    if (authorize) {
      await check('config-unchanged-before-exec', () => {
        if (readPrivateFile(descriptor.config_path).digest !== effective.configDigest) fail();
      });
      await check('one-time-token-consumed', () => {
        (dependencies.consume ?? consumeToken)(descriptor, token, approvalSecret);
        authorized = true;
      });
      await check('verified-mutation-executed', async () => {
        executed = true;
        commandExitCode = await (dependencies.execute ?? executeMutation)({
          command: [...command],
          cwd: descriptor.runtime_cwd,
          env: frozenChildEnv(env, effective.databaseUrl),
        });
        if (commandExitCode !== 0) fail();
      });
    }
    return {
      schema_version: 2,
      deployment_id: deploymentId,
      target_id: targetId,
      authorized,
      executed,
      command_exit_code: commandExitCode,
      ok: true,
      checks,
    };
  } catch {
    return {
      schema_version: 2,
      deployment_id: deploymentId,
      target_id: targetId,
      authorized,
      executed,
      command_exit_code: commandExitCode,
      ok: false,
      checks,
    };
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  const options = separator >= 0 ? args.slice(0, separator) : args;
  const descriptorPath = valueAfter(options, '--descriptor');
  const tokenPath = valueAfter(options, '--token');
  const secretPath = valueAfter(options, '--approval-secret-file');
  const operation = valueAfter(options, '--operation');
  const authorize = options.includes('--authorize');
  if (!descriptorPath || !tokenPath || !secretPath || !operation || command.length === 0) {
    console.error('mutation-target: FAIL');
    return 2;
  }

  let approvalSecret: Buffer;
  try {
    approvalSecret = readPrivateFile(resolve(secretPath)).bytes;
    secretBytes(approvalSecret);
  } catch {
    console.error('mutation-target: FAIL');
    return 1;
  }
  const result = await verifyMutationTarget(
    descriptorPath,
    tokenPath,
    authorize,
    command,
    { operation, approvalSecret },
  );
  console.log(`${result.deployment_id}: ${result.ok ? 'PASS' : 'FAIL'}`);
  if (result.target_id) console.log(result.target_id);
  for (const entry of result.checks) {
    console.log(`${entry.ok ? 'ok' : 'not ok'} - ${entry.name}`);
  }
  if (!authorize && result.ok) console.log('not ok - authorization-not-requested');
  return result.ok && result.authorized && result.executed ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
