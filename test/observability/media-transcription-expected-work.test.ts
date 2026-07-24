import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  buildExpectedWorkRegistry,
  mediaTranscriptionWorkKey,
} from '../../src/core/observability/expected-work.ts';
import {
  deriveSourceLabelKey,
  discoverRegistryInput,
} from '../../src/core/observability/snapshot.ts';

const SOURCE_LABEL_KEY = 'media-transcription-test-label-key';
const scratchDirs: string[] = [];

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-media-observer-'));
  scratchDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of scratchDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('media-transcription expected work', () => {
  test('registers one generic source-scoped Minion work item with an opaque key', () => {
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['birdclaw', 'other-private-source'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      mediaTranscriptionTargetIds: ['birdclaw'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });
    const work = registry.filter((entry) => entry.selector === 'media_transcription');

    expect(work).toEqual([{
      key: mediaTranscriptionWorkKey('birdclaw', SOURCE_LABEL_KEY),
      kind: 'minion',
      enabled: true,
      required: true,
      criticality: 'required',
      cadence_seconds: null,
      grace_seconds: 0,
      evidence_adapter: 'minion_job',
      selector: 'media_transcription',
      scope: { type: 'source', source_id: 'birdclaw' },
      backlog_warn: 50,
      backlog_fail: 500,
      healthy_when_idle: true,
      track_unresolved_failures: true,
      repair_runbook: 'media-transcription',
    }]);
    expect(work[0]!.key).toMatch(/^minion\.media_transcription\.s_[a-f0-9]{16}$/);
    expect(work[0]!.key).not.toContain('birdclaw');
  });

  test('does not invent work for a target that is not a discovered source', () => {
    const registry = buildExpectedWorkRegistry({
      sourceIds: ['other'],
      sourceLabelKey: SOURCE_LABEL_KEY,
      mediaTranscriptionTargetIds: ['birdclaw'],
      enabledDreamPhases: [],
      includeInfrastructure: false,
    });

    expect(registry.some((entry) => entry.selector === 'media_transcription')).toBe(false);
  });

  test('discovers exactly the configured registered target and stays dormant when absent', async () => {
    const root = scratch();
    const cli = join(root, 'fake-cli');
    const audioRoot = join(root, 'audio');
    writeFileSync(cli, '#!/bin/sh\nexit 0\n');
    chmodSync(cli, 0o755);
    mkdirSync(audioRoot);
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string) => sql.includes('FROM sources')
        ? [{
            id: 'birdclaw',
            name: 'Birdclaw',
            local_path: null,
            last_commit: null,
            last_sync_at: null,
            config: {},
            created_at: new Date(),
            archived: false,
          }]
        : [],
      getConfig: async () => null,
    } as unknown as BrainEngine;
    const baseConfig = {
      engine: 'pglite' as const,
      database_path: join(root, 'brain.db'),
    };

    const dormant = await discoverRegistryInput(engine, baseConfig, {}, {});
    expect(dormant.mediaTranscriptionTargetIds).toEqual([]);

    const configured = await discoverRegistryInput(engine, {
      ...baseConfig,
      media_transcription: {
        cli_path: cli,
        audio_root: audioRoot,
        target_source_id: 'birdclaw',
      },
    }, {}, {});
    expect(configured.mediaTranscriptionTargetIds).toEqual(['birdclaw']);
    const sourceLabelKey = deriveSourceLabelKey(baseConfig)!;
    expect(buildExpectedWorkRegistry(configured)).toContainEqual(expect.objectContaining({
      key: mediaTranscriptionWorkKey('birdclaw', sourceLabelKey),
      selector: 'media_transcription',
      scope: { type: 'source', source_id: 'birdclaw' },
    }));
  });

  test('keeps filesystem incidents observable and reports an unregistered target as discovery failure', async () => {
    const root = scratch();
    const engineFor = (sourceId: string) => ({
      kind: 'pglite',
      executeRaw: async (sql: string) => sql.includes('FROM sources')
        ? [{
            id: sourceId,
            name: sourceId,
            local_path: null,
            last_commit: null,
            last_sync_at: null,
            config: {},
            created_at: new Date(),
            archived: false,
          }]
        : [],
      getConfig: async () => null,
    }) as unknown as BrainEngine;

    const missingRuntime = await discoverRegistryInput(engineFor('birdclaw'), {
      engine: 'pglite',
      database_path: join(root, 'brain.db'),
      media_transcription: {
        cli_path: join(root, 'missing-cli'),
        audio_root: join(root, 'missing-audio'),
        target_source_id: 'birdclaw',
      },
    }, {}, {});

    expect(missingRuntime.mediaTranscriptionTargetIds).toEqual(['birdclaw']);
    expect(missingRuntime.discoveryFailures).toContain('media_transcription');
    expect(buildExpectedWorkRegistry(missingRuntime)).toContainEqual(expect.objectContaining({
      selector: 'media_transcription',
      scope: { type: 'source', source_id: 'birdclaw' },
    }));
    expect(buildExpectedWorkRegistry(missingRuntime)).toContainEqual(expect.objectContaining({
      key: 'discovery.media_transcription',
      kind: 'infrastructure',
      selector: 'media_transcription',
    }));

    const cli = join(root, 'fake-cli');
    const audioRoot = join(root, 'audio');
    writeFileSync(cli, '#!/bin/sh\nexit 0\n');
    chmodSync(cli, 0o755);
    mkdirSync(audioRoot);
    const unregistered = await discoverRegistryInput(engineFor('other'), {
      engine: 'pglite',
      database_path: join(root, 'brain.db'),
      media_transcription: {
        cli_path: cli,
        audio_root: audioRoot,
        target_source_id: 'birdclaw',
      },
    }, {}, {});
    expect(unregistered.mediaTranscriptionTargetIds).toEqual([]);
    expect(unregistered.discoveryFailures).toContain('media_transcription');
  });

  test('does not probe a configured runtime outside the requested source scope', async () => {
    const root = scratch();
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string) => sql.includes('FROM sources')
        ? [{
            id: 'other',
            name: 'Other',
            local_path: null,
            last_commit: null,
            last_sync_at: null,
            config: {},
            created_at: new Date(),
            archived: false,
          }]
        : [],
      getConfig: async () => null,
    } as unknown as BrainEngine;

    const discovered = await discoverRegistryInput(engine, {
      engine: 'pglite',
      database_path: join(root, 'brain.db'),
      media_transcription: {
        cli_path: join(root, 'missing-cli'),
        audio_root: join(root, 'missing-audio'),
        target_source_id: 'birdclaw',
      },
    }, { sourceId: 'other' }, {});

    expect(discovered.mediaTranscriptionTargetIds).toEqual([]);
    expect(discovered.discoveryFailures).not.toContain('media_transcription');
  });
});
