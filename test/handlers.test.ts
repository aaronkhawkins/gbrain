/**
 * Tests for registerBuiltinHandlers in src/commands/jobs.ts.
 *
 * Covers:
 *   - Every expected handler name is registered.
 *   - autopilot-cycle handler returns { partial, status, report } (v0.17
 *     runCycle-backed shape) when any step fails — does NOT throw itself
 *     (critical invariant: an intermittent phase failure must not cause
 *     the Minion to retry and block every future cycle).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let worker: MinionWorker;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  worker = new MinionWorker(engine, { queue: 'test' });
  await registerBuiltinHandlers(worker, engine);
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setEmbedTransportForTests((async ({ values }: any) => ({
    embeddings: values.map(() => Array.from({ length: 1280 }, () => 0)),
  })) as any);
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('registerBuiltinHandlers', () => {
  test('registers all built-in handler names', () => {
    const names = worker.registeredNames;
    // Existing handlers from pre-v0.11.1
    expect(names).toContain('sync');
    expect(names).toContain('embed');
    expect(names).toContain('lint');
    expect(names).toContain('import');
    // New in v0.11.1 (Tier 1 + autopilot-cycle)
    expect(names).toContain('extract');
    expect(names).toContain('backlinks');
    expect(names).toContain('autopilot-cycle');
    expect(names).toContain('facts-absorb');
  });

  test('total handler count includes all 7 names', () => {
    expect(worker.registeredNames.length).toBeGreaterThanOrEqual(7);
  });
});

describe('facts-absorb handler', () => {
  test('loads the persisted page and completes fact extraction after enqueueing process exits', async () => {
    const slug = 'meetings/durable-worker-test';
    const body = 'A durable meeting note with enough substantive content for extraction. '.repeat(3);
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.putPage(slug, {
      title: 'durable worker test',
      type: 'meeting',
      compiled_truth: body,
      timeline: '',
      frontmatter: {},
    });
    __setChatTransportForTests(async () => ({
      text: JSON.stringify({ facts: [{
        fact: 'The durable worker completed extraction.',
        kind: 'event',
        entity: null,
        confidence: 1,
        notability: 'high',
      }] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const contentHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const handler = (worker as any).handlers.get('facts-absorb');

    try {
      const result = await handler({
        data: {
          slug,
          sourceId: 'default',
          sessionId: 'sync:durable-worker-test',
          notabilityFilter: 'high-only',
          contentHash,
        },
        signal: new AbortController().signal,
      });
      expect(result.mode).toBe('inline');
      expect(result.inserted).toBe(1);
      const facts = await engine.listFactsBySession('default', 'sync:durable-worker-test');
      expect(facts.some((fact) => fact.fact === 'The durable worker completed extraction.')).toBe(true);
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  });

  test('skips a stale durable job when the page changed after enqueue', async () => {
    const slug = 'meetings/durable-worker-changed';
    await engine.putPage(slug, {
      title: 'changed worker test',
      type: 'meeting',
      compiled_truth: 'This content changed after the original durable job was queued. '.repeat(2),
      timeline: '',
      frontmatter: {},
    });
    const handler = (worker as any).handlers.get('facts-absorb');
    const result = await handler({
      data: { slug, sourceId: 'default', contentHash: '0'.repeat(64) },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ skipped: true, reason: 'page_changed' });
  });

  test('revalidates the source revision immediately before fact writes', async () => {
    const slug = 'meetings/durable-worker-midflight-change';
    const body = 'The original substantive meeting body. '.repeat(5);
    await engine.putPage(slug, {
      title: 'midflight change', type: 'meeting', compiled_truth: body,
      timeline: '', frontmatter: {},
    });
    __setChatTransportForTests(async () => {
      await engine.putPage(slug, {
        title: 'midflight change', type: 'meeting',
        compiled_truth: 'A replacement body written while extraction was running. '.repeat(4),
        timeline: '', frontmatter: {},
      });
      return {
        text: JSON.stringify({ facts: [{
          fact: 'A stale claim that must not be persisted.', kind: 'fact', entity: null,
          confidence: 1, notability: 'high',
        }] }),
        blocks: [], stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub', providerId: 'test',
      };
    });
    const { factsContentHash } = await import('../src/core/facts/durable-job.ts');
    const handler = (worker as any).handlers.get('facts-absorb');
    const result = await handler({
      data: {
        schema_version: 1, slug, sourceId: 'default', sessionId: null,
        source: 'sync:import', notabilityFilter: 'high-only',
        contentHash: factsContentHash(body),
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ mode: 'inline', skipped: 'source_changed', inserted: 0 });
    const facts = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE fact = $1`,
      ['A stale claim that must not be persisted.'],
    );
    expect(facts[0]?.n).toBe(0);
  });

  test('surfaces a transient extraction failure so the worker can retry it', async () => {
    const slug = 'meetings/durable-worker-retry';
    const body = 'A substantive meeting note whose first extraction attempt should retry. '.repeat(3);
    await engine.putPage(slug, {
      title: 'retry worker test',
      type: 'meeting',
      compiled_truth: body,
      timeline: '',
      frontmatter: {},
    });
    __setChatTransportForTests(async () => {
      throw new Error('temporary gateway outage');
    });
    const handler = (worker as any).handlers.get('facts-absorb');
    try {
      await expect(handler({
        data: {
          slug,
          sourceId: 'default',
          sessionId: null,
          source: 'sync:import',
          notabilityFilter: 'high-only',
          contentHash: (await import('../src/core/facts/durable-job.ts')).factsContentHash(body),
        },
        signal: new AbortController().signal,
      })).rejects.toThrow('temporary gateway outage');
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  });

  test('rejects an unsupported durable payload version', async () => {
    const handler = (worker as any).handlers.get('facts-absorb');
    await expect(handler({
      data: { schema_version: 99, slug: 'meetings/future-payload' },
      signal: new AbortController().signal,
    })).rejects.toThrow('unsupported payload schema_version 99');
  });

  test('rejects malformed durable payload fields at the worker boundary', async () => {
    const handler = (worker as any).handlers.get('facts-absorb');
    await expect(handler({
      data: { slug: 'meetings/bad-source', source: 'sender-controlled' },
      signal: new AbortController().signal,
    })).rejects.toThrow('unsupported source sender-controlled');
    await expect(handler({
      data: { slug: 'meetings/bad-hash', contentHash: 'not-a-digest' },
      signal: new AbortController().signal,
    })).rejects.toThrow('contentHash must be a SHA-256 hex digest');
  });
});

describe('autopilot-cycle handler — partial failure does NOT throw', () => {
  test('phase failure returns partial:true + structured report, no throw', async () => {
    // Call the handler directly with a job pointing at a nonexistent repo.
    // Filesystem-dependent phases (lint, backlinks, sync) all fail because
    // the dir / .git repo isn't there. DB-dependent phases (extract,
    // embed, orphans) run fine against the in-memory test engine.
    //
    // CRITICAL INVARIANT: the handler must return successfully even when
    // phases fail. Throwing would cause the Minion to retry, blocking
    // every future cycle on an intermittent bug. v0.17 moves this
    // guarantee into runCycle itself (per-phase try/catch in cycle.ts).
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-autopilot-test' },
      signal: { aborted: false } as any,
      job: { id: 1, name: 'autopilot-cycle' } as any,
    });

    expect(result).toBeDefined();
    expect((result as any).partial).toBe(true);
    // v0.17 shape: { partial, status, report }. The report's phases array
    // replaces the old failed_steps list.
    expect(['partial', 'failed']).toContain((result as any).status);
    const report = (result as any).report;
    expect(report).toBeDefined();
    expect(report.schema_version).toBe('1');
    expect(Array.isArray(report.phases)).toBe(true);
    // The filesystem-dependent phases should have failed on a missing dir.
    const failedPhases = report.phases
      .filter((p: any) => p.status === 'fail')
      .map((p: any) => p.phase);
    expect(failedPhases).toContain('lint');
    expect(failedPhases).toContain('backlinks');
    expect(failedPhases).toContain('sync');
  });

  test('all phases succeed → result has structured report (smoke)', async () => {
    // Smoke: invoke against a real (if empty) git repo. If every phase
    // completes (or gracefully skips), the handler returns a result
    // object with the full runCycle report. Some phases may still warn
    // (empty repo has nothing to lint/sync) — the invariant is that the
    // handler never throws.
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cycle-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      const result = await handler({
        data: { repoPath: dir },
        signal: { aborted: false } as any,
        job: { id: 2, name: 'autopilot-cycle' } as any,
      });
      // The handler MUST return a result object, never throw, regardless
      // of individual phase outcomes.
      expect(result).toBeDefined();
      expect(typeof (result as any).partial).toBe('boolean');
      expect('report' in (result as any)).toBe(true);
      expect((result as any).report.schema_version).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('autopilot-cycle handler — phase passthrough', () => {
  test('job.data.phases restricts which phases run', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-pass-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Request only lint and sync — embed should NOT appear
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'sync'] },
        signal: { aborted: false } as any,
        job: { id: 10, name: 'autopilot-cycle' } as any,
      });

      expect(result).toBeDefined();
      const report = (result as any).report;
      expect(report).toBeDefined();
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).toContain('sync');
      // Phases NOT requested must be absent
      expect(phaseNames).not.toContain('embed');
      expect(phaseNames).not.toContain('extract');
      expect(phaseNames).not.toContain('backlinks');
      expect(phaseNames).not.toContain('orphans');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('invalid phase names in job.data.phases are filtered out', async () => {
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-phase-invalid-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      // Mix valid and bogus names — only 'lint' should survive filtering
      const result = await handler({
        data: { repoPath: dir, phases: ['lint', 'BOGUS', 'rm -rf /'] },
        signal: { aborted: false } as any,
        job: { id: 11, name: 'autopilot-cycle' } as any,
      });

      const report = (result as any).report;
      const phaseNames = report.phases.map((p: any) => p.phase);
      expect(phaseNames).toContain('lint');
      expect(phaseNames).not.toContain('BOGUS');
      expect(phaseNames.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('empty phases array falls back to all phases (same as no phases)', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    // Empty array should fall through to ALL_PHASES (same as omitting phases)
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: [] },
      signal: { aborted: false } as any,
      job: { id: 12, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    // With all phases, filesystem phases fail on missing dir
    const phaseNames = report.phases.map((p: any) => p.phase);
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('backlinks');
    expect(phaseNames).toContain('sync');
  }, 30_000);

  test('non-array phases value is ignored (falls back to all)', async () => {
    const handler = (worker as any).handlers.get('autopilot-cycle');
    // String instead of array — should be ignored
    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-phase-test', phases: 'lint' },
      signal: { aborted: false } as any,
      job: { id: 13, name: 'autopilot-cycle' } as any,
    });

    const report = (result as any).report;
    const phaseNames = report.phases.map((p: any) => p.phase);
    // Should have all phases since the string was ignored
    expect(phaseNames).toContain('lint');
    expect(phaseNames).toContain('sync');
    expect(phaseNames).toContain('embed');
  }, 30_000);
});
