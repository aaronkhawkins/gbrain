import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  generatedOutputDigest,
  reconcileGeneratedOutputs,
  resolveGeneratedOutputPath,
  writeGeneratedOutput,
} from '../src/core/generated-output-writer.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let root: string;
let stateDir: string;
const priorGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
});

beforeEach(async () => {
  await resetPgliteState(engine);
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'gbrain-generated-'));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = mkdtempSync(join(tmpdir(), 'gbrain-generated-state-'));
  process.env.GBRAIN_HOME = stateDir;
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, 'default']);
});

const markdown = `---
type: atom
title: Durable atom
generated_by: dream
---
The canonical file exists before its projection.
`;

describe('FS-first generated output writer', () => {
  test('atomically places a file and then creates searchable projection', async () => {
    const result = await writeGeneratedOutput(engine, 'atoms/durable', markdown, {
      expectedDigest: null,
      noEmbed: true,
    });
    expect(result.status).toBe('projected');
    expect(readFileSync(join(root, 'atoms/durable.md'), 'utf8')).toBe(markdown);
    expect(await engine.getPage('atoms/durable')).not.toBeNull();
    expect((await engine.getChunks('atoms/durable')).length).toBeGreaterThan(0);
  });

  test('failure before placement leaves no file and no DB page', async () => {
    await expect(writeGeneratedOutput(engine, 'atoms/before', markdown, {
      expectedDigest: null,
      noEmbed: true,
      _failAt: 'before_placement',
    })).rejects.toThrow('before placement');
    expect(existsSync(join(root, 'atoms/before.md'))).toBe(false);
    expect(await engine.getPage('atoms/before')).toBeNull();
  });

  test('startup reconciliation repairs a crash after placement', async () => {
    await expect(writeGeneratedOutput(engine, 'atoms/recover', markdown, {
      expectedDigest: null,
      noEmbed: true,
      _failAt: 'after_placement',
    })).rejects.toThrow('after placement');
    expect(existsSync(join(root, 'atoms/recover.md'))).toBe(true);
    expect(await engine.getPage('atoms/recover')).toBeNull();

    const repaired = await reconcileGeneratedOutputs(engine, { noEmbed: true });
    expect(repaired).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(await engine.getPage('atoms/recover')).not.toBeNull();
  });

  test('identical rerun is a no-op without timestamp churn', async () => {
    const first = await writeGeneratedOutput(engine, 'atoms/noop', markdown, {
      expectedDigest: null,
      noEmbed: true,
    });
    const before = statSync(first.path).mtimeMs;
    const second = await writeGeneratedOutput(engine, 'atoms/noop', markdown, {
      expectedDigest: generatedOutputDigest(markdown),
      noEmbed: true,
    });
    expect(second.status).toBe('noop');
    expect(statSync(first.path).mtimeMs).toBe(before);
  });

  test('divergent concurrent expectation fails explicitly', async () => {
    const path = await resolveGeneratedOutputPath(engine, 'atoms/cas');
    expect(path).toBe(join(root, 'atoms/cas.md'));
    await writeGeneratedOutput(engine, 'atoms/cas', markdown, {
      expectedDigest: null,
      noEmbed: true,
    });
    const changed = markdown.replace('canonical', 'newer');
    const conflict = await writeGeneratedOutput(engine, 'atoms/cas', changed, {
      expectedDigest: null,
      noEmbed: true,
    });
    expect(conflict.status).toBe('conflict');
    expect(readFileSync(path, 'utf8')).toBe(markdown);
  });

  test('two writers from the same base cannot silently overwrite each other', async () => {
    const alternate = markdown.replace('canonical', 'alternate');
    const [a, b] = await Promise.all([
      writeGeneratedOutput(engine, 'atoms/race', markdown, {
        expectedDigest: null,
        noEmbed: true,
      }),
      writeGeneratedOutput(engine, 'atoms/race', alternate, {
        expectedDigest: null,
        noEmbed: true,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['conflict', 'projected']);
    const winner = readFileSync(join(root, 'atoms/race.md'), 'utf8');
    expect([markdown, alternate]).toContain(winner);
  });

  test('source checkouts remain isolated for identical slugs', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'gbrain-generated-other-'));
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('research', 'research', $1, '{}'::jsonb)`,
        [otherRoot],
      );
      await writeGeneratedOutput(engine, 'atoms/shared', markdown, {
        sourceId: 'research',
        expectedDigest: null,
        noEmbed: true,
      });
      expect(existsSync(join(otherRoot, 'atoms/shared.md'))).toBe(true);
      expect(existsSync(join(root, 'atoms/shared.md'))).toBe(false);
      expect(await engine.getPage('atoms/shared', { sourceId: 'research' })).not.toBeNull();
      expect(await engine.getPage('atoms/shared', { sourceId: 'default' })).toBeNull();
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
