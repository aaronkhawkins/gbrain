/**
 * v0.31 E2E — `gbrain recall --today` markdown render against real Postgres.
 * Mostly a parity check: same shape as the PGLite test, on PG.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { runRecall } from '../../src/commands/recall.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
let isolatedHome: string;
let previousGbrainHome: string | undefined;

beforeAll(async () => {
  if (!RUN) return;
  // runRecall reads the file plane to detect thin-client mode. The E2E runner
  // intentionally reuses one isolated HOME across files, so a prior config
  // fixture must not change this test from local to remote recall.
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-recall-e2e-'));
  previousGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = isolatedHome;
  await setupDB();
});
afterAll(async () => {
  if (!RUN) return;
  await teardownDB();
  if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousGbrainHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

d('gbrain recall --today (Postgres)', () => {
  test('renders markdown with kind icons', async () => {
    if (!RUN) return;
    const engine = getEngine();
    await engine.insertFact(
      { fact: 'render-event', kind: 'event', entity_slug: 'render-pg-e', source: 'test' },
      { source_id: 'default' },
    );
    await engine.insertFact(
      { fact: 'render-pref', kind: 'preference', entity_slug: 'render-pg-p', source: 'test' },
      { source_id: 'default' },
    );

    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await runRecall(engine, ['--today']);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(captured).toContain('Hot memory — ');
    expect(captured).toContain('📅');  // event icon
    expect(captured).toContain('🎯');  // preference icon
  });
});
