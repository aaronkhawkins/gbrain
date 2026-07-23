/**
 * Observer HTTP server (U4).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  startObserverServer,
  assertSafeBind,
} from '../../src/core/observability/observer-server.ts';
import type { OperationalSnapshot } from '../../src/core/observability/types.ts';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await s.close();
  }
});

function fixtureSnap(brain: string): OperationalSnapshot {
  return {
    schema_version: 1,
    brain,
    generated_at: new Date().toISOString(),
    state: 'healthy',
    items: [{
      key: 'runtime.supervisor',
      kind: 'local_runtime',
      state: 'unknown',
      last_attempt_at: null,
      last_success_at: null,
      next_due_at: null,
      backlog_items: null,
      oldest_pending_age_seconds: null,
      recent_failures: null,
      reason: 'evidence_unavailable',
      repair_runbook: 'observer-missing',
      required: false,
      enabled: true,
    }],
    build: { channel: 'test', tag: null, sha: null, managed_fork: false },
  };
}

describe('assertSafeBind', () => {
  test('allows only loopback and Tailscale ranges by default', () => {
    expect(() => assertSafeBind('0.0.0.0', false)).toThrow(/public/);
    expect(() => assertSafeBind('127.0.0.1', false)).not.toThrow();
    expect(() => assertSafeBind('127.42.0.9', false)).not.toThrow();
    expect(() => assertSafeBind('::1', false)).not.toThrow();
    expect(() => assertSafeBind('100.64.0.1', false)).not.toThrow();
    expect(() => assertSafeBind('100.127.255.254', false)).not.toThrow();
    expect(() => assertSafeBind('fd7a:115c:a1e0::1', false)).not.toThrow();
    expect(() => assertSafeBind('100.128.0.1', false)).toThrow(/loopback or Tailscale/);
    expect(() => assertSafeBind('192.168.1.20', false)).toThrow(/loopback or Tailscale/);
    expect(() => assertSafeBind('observer.internal', false)).toThrow(/loopback or Tailscale/);
    expect(() => assertSafeBind('0.0.0.0', true)).not.toThrow();
    expect(() => assertSafeBind('192.168.1.20', true)).not.toThrow();
  });
});

describe('startObserverServer', () => {
  test('rejects invalid refresh and collector timeout bounds', async () => {
    await expect(startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      refreshMs: 0,
      buildSnapshot: async () => fixtureSnap('invalid_refresh'),
    })).rejects.toThrow(/refreshMs/);
    await expect(startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      collectTimeoutMs: -1,
      buildSnapshot: async () => fixtureSnap('invalid_timeout'),
    })).rejects.toThrow(/collectTimeoutMs/);
  });

  test('two observers expose different brain identities', async () => {
    let builds = 0;
    const a = await startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      buildSnapshot: async () => {
        builds++;
        return fixtureSnap('brain_a');
      },
    });
    servers.push(a);
    const b = await startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      buildSnapshot: async () => fixtureSnap('brain_b'),
    });
    servers.push(b);

    const ma = await (await fetch(`${a.url}/metrics`)).text();
    const mb = await (await fetch(`${b.url}/metrics`)).text();
    expect(ma).toContain('brain="brain_a"');
    expect(mb).toContain('brain="brain_b"');
    // Label form only — reason-code names must not create false cross-brain hits.
    expect(ma).toContain('brain="brain_a"');
    expect(ma).not.toContain('brain="brain_b"');
    expect(mb).not.toContain('brain="brain_a"');

    // Repeated scrapes use cache — buildSnapshot called once for prime (+ optional refresh).
    await fetch(`${a.url}/metrics`);
    await fetch(`${a.url}/metrics`);
    expect(builds).toBe(1);

    const health = await (await fetch(`${a.url}/healthz`)).json() as { brain: string; ok: boolean };
    expect(health.ok).toBe(true);
    expect(health.brain).toBe('brain_a');

    const snapshotRoute = await fetch(`${a.url}/snapshot.json`);
    expect(snapshotRoute.status).toBe(404);
  });

  test('unavailable DB yields metrics without throwing healthy-by-default', async () => {
    const server = await startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      // Real builder with null engine → unknown/degraded, not healthy fake.
    });
    servers.push(server);
    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).toContain('gbrain_observer_info');
    // Must not claim brain healthy solely from empty evidence of required items.
    // (With only optional runtime items unknown, rollup may be unknown.)
    expect(text).toMatch(/gbrain_brain_state\{brain="[^"]+",state="(unknown|degraded|failed)"\} 1/);
  });

  test('pending schema is exported as unknown/schema_incompatible', async () => {
    const server = await startObserverServer({
      engine: {
        kind: 'pglite',
        getConfig: async () => '1',
        executeRaw: async () => [],
      } as never,
      config: { observability: { brain_id: 'pending_schema' } } as never,
      bind: '127.0.0.1',
      port: 0,
    });
    servers.push(server);

    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).toContain(
      'gbrain_expected_work_reason{brain="pending_schema",work="minion.autopilot-cycle",reason="schema_incompatible"} 1',
    );
    expect(text).toContain(
      'gbrain_expected_work_state{brain="pending_schema",work="minion.autopilot-cycle",state="unknown"} 1',
    );
  });

  test('health becomes unavailable after a refresh failure without exporting the error', async () => {
    let calls = 0;
    const server = await startObserverServer({
      engine: null,
      config: null,
      bind: '127.0.0.1',
      port: 0,
      buildSnapshot: async () => {
        calls++;
        if (calls > 1) throw new Error('postgres://user:secret@private-host/brain');
        return fixtureSnap('refresh_failure');
      },
    });
    servers.push(server);

    await expect(server.refresh()).rejects.toThrow();
    const response = await fetch(`${server.url}/healthz`);
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain('"reason":"refresh_failed"');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('private-host');
  });
});
