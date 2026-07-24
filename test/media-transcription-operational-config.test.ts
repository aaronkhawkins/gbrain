import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveMediaTranscriptionConfig } from '../src/core/config.ts';
import { readBoundedMediaJson } from '../src/commands/jobs.ts';
import { assertActiveMediaTranscriptionSource } from '../src/core/media-transcription-operations.ts';

const scratchDirs: string[] = [];

afterEach(() => {
  for (const path of scratchDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('media transcription operational configuration', () => {
  test('uses the complete env tuple without mixing missing fields from file config', () => {
    const fileConfig = {
      engine: 'pglite' as const,
      media_transcription: {
        cli_path: '/file/cli',
        audio_root: '/file/audio',
        target_source_id: 'file-source',
      },
    };

    expect(() => resolveMediaTranscriptionConfig(fileConfig, {
      GBRAIN_MEDIA_TRANSCRIPTION_CLI: '/env/cli',
    })).toThrow(/all three/i);

    expect(resolveMediaTranscriptionConfig(fileConfig, {
      GBRAIN_MEDIA_TRANSCRIPTION_CLI: '/env/cli',
      GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT: '/env/audio',
      GBRAIN_MEDIA_TRANSCRIPTION_TARGET_SOURCE_ID: 'env-source',
    })).toEqual({
      cli_path: '/env/cli',
      audio_root: '/env/audio',
      target_source_id: 'env-source',
    });
  });

  test('parses declarative configuration without requiring live filesystem paths', () => {
    expect(resolveMediaTranscriptionConfig({
      engine: 'pglite',
      media_transcription: {
        cli_path: '/currently/missing/cli',
        audio_root: '/currently/missing/audio',
        target_source_id: 'birdclaw',
      },
    }, {})).toEqual({
      cli_path: '/currently/missing/cli',
      audio_root: '/currently/missing/audio',
      target_source_id: 'birdclaw',
    });
  });

  test('reads one bounded JSON descriptor and rejects oversized input', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-media-json-'));
    scratchDirs.push(root);
    const valid = join(root, 'valid.json');
    const exactLimit = join(root, 'exact-limit.json');
    const oversized = join(root, 'oversized.json');
    writeFileSync(valid, '{"media_id":"one"}');
    writeFileSync(exactLimit, `"${'x'.repeat(999_998)}"`);
    writeFileSync(oversized, Buffer.alloc(1_000_001, 0x20));

    expect(readBoundedMediaJson(valid)).toEqual({ media_id: 'one' });
    expect((readBoundedMediaJson(exactLimit) as string).length).toBe(999_998);
    expect(() => readBoundedMediaJson(oversized)).toThrow(/bounded JSON file/);
  });

  test('requires the configured target source to exist and remain active', async () => {
    const engineFor = (rows: Array<{ id: string; archived?: boolean }>) => ({
      executeRaw: async () => rows,
    }) as unknown as BrainEngine;

    await expect(
      assertActiveMediaTranscriptionSource(engineFor([{ id: 'birdclaw', archived: false }]), 'birdclaw'),
    ).resolves.toBeUndefined();
    await expect(
      assertActiveMediaTranscriptionSource(engineFor([{ id: 'birdclaw', archived: true }]), 'birdclaw'),
    ).rejects.toThrow(/archived/i);
    await expect(
      assertActiveMediaTranscriptionSource(engineFor([]), 'birdclaw'),
    ).rejects.toThrow(/not registered/i);
  });
});
