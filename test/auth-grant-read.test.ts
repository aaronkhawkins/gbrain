import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { grantReadCore, listOAuthClientsCore, sanitizeForTerminal } from '../src/commands/auth.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedSource(id: string): Promise<void> {
  const sql = sqlQueryForEngine(engine);
  await sql`INSERT INTO sources (id, name) VALUES (${id}, ${id}) ON CONFLICT (id) DO NOTHING`;
}

async function seedClient(
  name: string,
  federatedRead = ['default'],
  scopes = 'read write',
): Promise<string> {
  await seedSource('default');
  const sql = sqlQueryForEngine(engine);
  const provider = new GBrainOAuthProvider({ sql });
  const { clientId } = await provider.registerClientManual(
    name,
    ['authorization_code'],
    scopes,
    [],
    'default',
    federatedRead,
  );
  return clientId;
}

async function federatedRead(clientId: string): Promise<string[]> {
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`SELECT federated_read FROM oauth_clients WHERE client_id = ${clientId}`;
  return rows[0].federated_read as string[];
}

describe('grantReadCore', () => {
  test('adds a source without changing the write source', async () => {
    await seedSource('collector');
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    const result = await grantReadCore(sql, clientId, 'collector');

    expect(result.kind).toBe('updated');
    expect(await federatedRead(clientId)).toEqual(['default', 'collector']);
    const rows = await sql`SELECT source_id FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(rows[0].source_id).toBe('default');
  });

  test('is idempotent', async () => {
    await seedSource('collector');
    const clientId = await seedClient('owner', ['default', 'collector']);
    const sql = sqlQueryForEngine(engine);

    const result = await grantReadCore(sql, clientId, 'collector');

    expect(result.kind).toBe('noop');
    expect(await federatedRead(clientId)).toEqual(['default', 'collector']);
  });

  test('rejects unknown sources without mutating the client', async () => {
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    await expect(grantReadCore(sql, clientId, 'missing')).rejects.toThrow(/does not exist/);
    expect(await federatedRead(clientId)).toEqual(['default']);
  });

  test('requires a client id when names are duplicated', async () => {
    await seedSource('collector');
    await seedClient('owner');
    await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    await expect(grantReadCore(sql, 'owner', 'collector')).rejects.toThrow(/Multiple active OAuth clients/);
  });

  test('resolves a unique client name', async () => {
    await seedSource('collector');
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    await grantReadCore(sql, 'owner', 'collector');

    expect(await federatedRead(clientId)).toEqual(['default', 'collector']);
  });

  test('rejects clients without a read-capable scope', async () => {
    await seedSource('collector');
    const clientId = await seedClient('worker', ['default'], 'agent');
    const sql = sqlQueryForEngine(engine);

    await expect(grantReadCore(sql, clientId, 'collector')).rejects.toThrow(/read-capable scope/);
    expect(await federatedRead(clientId)).toEqual(['default']);
  });

  test('rejects soft-deleted clients', async () => {
    await seedSource('collector');
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);
    await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId}`;

    await expect(grantReadCore(sql, clientId, 'collector')).rejects.toThrow(/No active OAuth client/);
    expect(await federatedRead(clientId)).toEqual(['default']);
  });

  test('serializes concurrent duplicate grants', async () => {
    await seedSource('collector');
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    const results = await Promise.all([
      grantReadCore(sql, clientId, 'collector'),
      grantReadCore(sql, clientId, 'collector'),
    ]);

    expect(results.map(result => result.kind).sort()).toEqual(['noop', 'updated']);
    expect(await federatedRead(clientId)).toEqual(['default', 'collector']);
  });
});

describe('OAuth client discovery', () => {
  test('lists exact ids and current source scopes', async () => {
    const clientId = await seedClient('owner');
    const sql = sqlQueryForEngine(engine);

    const clients = await listOAuthClientsCore(sql);

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      client_id: clientId,
      client_name: 'owner',
      source_id: 'default',
      federated_read: ['default'],
      deleted_at: null,
    });
  });

  test('escapes terminal control characters', () => {
    expect(sanitizeForTerminal('owner\n\u001b[2J')).toBe('owner\\x0a\\x1b[2J');
  });
});
