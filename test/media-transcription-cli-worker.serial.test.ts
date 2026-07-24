import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobs, registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { MEDIA_EVIDENCE_API_VERSION, type MediaEvidence } from '../src/core/ingestion/media-evidence.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const AUDIO_HASH = 'a'.repeat(64);
const CONFIG_ENV_KEYS = [
  'GBRAIN_MEDIA_TRANSCRIPTION_CLI',
  'GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT',
  'GBRAIN_MEDIA_TRANSCRIPTION_TARGET_SOURCE_ID',
] as const;

let engine: PGLiteEngine;
const root = mkdtempSync(join(tmpdir(), 'gbrain-media-cli-worker-'));
const originalEnv = new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('birdclaw', 'BirdClaw', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

function mediaEvidence(): MediaEvidence {
  return {
    api_version: MEDIA_EVIDENCE_API_VERSION,
    id: 'audio-1',
    url: 'https://media.example/audio.wav',
    kind: 'audio',
    content_hash: AUDIO_HASH,
    owner: {
      brain_id: 'host',
      target_source_id: 'birdclaw',
    },
    provenance: {
      source_id: 'birdclaw',
      external_id: 'external-1',
      source_uri: 'https://source.example/items/1',
    },
    acquisition: {
      status: 'acquired',
      reason_code: null,
    },
  };
}

function configureFakeCli(): { log: string; mediaJson: string } {
  const audioRoot = join(root, 'artifacts');
  const artifactDir = join(audioRoot, 'audio-1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'audio.wav'), 'fake audio');

  const log = join(root, 'argv.jsonl');
  const cli = join(root, 'fake-parakeet');
  const sourceHashes = {
    'runners/__init__.py': 'd1862cdd5d4d197531347717d1584449177a252790de69dc0357c56b92f40982',
    'runners/gbrain_single.py': 'dd9aa4a982f481c668981d896919a1cfb17fcae48ef0e8774c52bb6d782dfe0c',
    'scripts/__init__.py': 'eb107601d5e971751a4aad5d1c527953b979839a27489813d1a5c426101d673e',
    'scripts/audio_chunks.py': 'c908091c46e45eb99faabc8aec569dd9440f2ede8a520fa0a590d95986729f60',
    'scripts/gbrain_result.py': '4bc8d14a4109cadd61b17956456142d192bcbff54df7e45dcb4e7bdd4ba84a11',
    'scripts/gbrain_single_contract.py': 'b10553b09c002b1a0c163d4015943aa7abba27111a592523f450a40107f034bc',
  };
  writeFileSync(cli, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const value = (flag) => args[args.indexOf(flag) + 1];
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: 'complete',
  model: 'nemo-parakeet-tdt-0.6b-v2',
  language: 'en',
  hasMeaningfulSpeech: false,
  speechSeconds: 0,
  segments: [],
  apiVersion: 'gbrain-parakeet-result-v1',
  mediaId: value('--media-id'),
  mediaContentHash: value('--sha256'),
  processor: {
    processor_key: value('--processor-key'),
    processor_version: value('--processor-version'),
    model_provider: value('--model-provider'),
    model_name: value('--model-name'),
    model_version: value('--model-version'),
  },
  transcriptContentHash: '01f6821085e60f0571ce191f6de9703d0c2f884a676f2bd2d1d7a1fbcae9bd44',
  runtimeIdentity: {
    imageId: 'sha256:8906f0c7e2267fb872e950cf9a60d60e8f5891686bc922ffcd3e7fe8511c0dca',
    sourceHashes: ${JSON.stringify(sourceHashes)},
  },
}) + '\\n');
`);
  chmodSync(cli, 0o755);

  const mediaJson = join(root, 'media.json');
  writeFileSync(mediaJson, JSON.stringify(mediaEvidence()));
  process.env.GBRAIN_MEDIA_TRANSCRIPTION_CLI = cli;
  process.env.GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT = audioRoot;
  process.env.GBRAIN_MEDIA_TRANSCRIPTION_TARGET_SOURCE_ID = 'birdclaw';
  return { log, mediaJson };
}

async function captureJson(action: () => Promise<void>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await action();
  } finally {
    console.log = originalLog;
  }
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function waitForTerminal(queue: MinionQueue, jobId: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && ['completed', 'failed', 'dead', 'cancelled'].includes(job.status)) return job;
    await Bun.sleep(20);
  }
  throw new Error(`media_transcription job ${jobId} did not become terminal`);
}

describe('media-transcription CLI and configured worker', () => {
  test('submits idempotently, reports trusted status, and runs one real worker attempt', async () => {
    const { log, mediaJson } = configureFakeCli();

    const configuration = await captureJson(() =>
      runJobs(engine, ['media-transcription', 'status']));
    expect(configuration).toEqual(expect.objectContaining({
      schema_version: 1,
      configured: true,
      target_source_id: 'birdclaw',
      processor: expect.objectContaining({ processor_key: 'parakeet-asr' }),
    }));

    const accepted = await captureJson(() =>
      runJobs(engine, ['media-transcription', 'submit', '--media-json', mediaJson]));
    expect(accepted).toEqual(expect.objectContaining({
      schema_version: 1,
      disposition: 'accepted',
      job_status: 'waiting',
    }));
    const jobId = accepted.job_id as number;

    const duplicate = await captureJson(() =>
      runJobs(engine, ['media-transcription', 'submit', '--media-json', mediaJson]));
    expect(duplicate).toEqual({
      schema_version: 1,
      disposition: 'duplicate',
      job_id: jobId,
      job_status: 'waiting',
    });

    const waiting = await captureJson(() =>
      runJobs(engine, ['media-transcription', 'status', String(jobId)]));
    expect(waiting).toEqual({
      schema_version: 1,
      job_id: jobId,
      status: 'waiting',
      attempts_started: 0,
      attempts_made: 0,
      error_code: null,
    });
    const waitingWithResult = await captureJson(() =>
      runJobs(engine, [
        'media-transcription',
        'status',
        String(jobId),
        '--include-result',
      ]));
    expect(waitingWithResult).toEqual({
      ...waiting,
      result_available: false,
      result: null,
    });

    const queue = new MinionQueue(engine);
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      pollInterval: 10,
      stalledInterval: 50,
    });
    await registerBuiltinHandlers(worker, engine, { quiet: true });
    expect(worker.registeredNames).toContain('media_transcription');

    const workerRun = worker.start();
    try {
      const terminal = await waitForTerminal(queue, jobId);
      expect(terminal.status).toBe('completed');
      expect(terminal.attempts_started).toBe(1);
      expect(terminal.result).toEqual({
        schema_version: 1,
        outcome: 'ignored',
        reason_code: 'no_meaningful_speech',
      });
    } finally {
      worker.stop();
      await workerRun;
    }

    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
    const completed = await captureJson(() =>
      runJobs(engine, ['media-transcription', 'status', String(jobId)]));
    expect(completed).toEqual({
      schema_version: 1,
      job_id: jobId,
      status: 'completed',
      attempts_started: 1,
      attempts_made: 0,
      error_code: null,
    });
    const completedWithResult = await captureJson(() =>
      runJobs(engine, [
        'media-transcription',
        'status',
        String(jobId),
        '--include-result',
      ]));
    expect(completedWithResult).toEqual({
      ...completed,
      result_available: true,
      result: {
        schema_version: 1,
        outcome: 'ignored',
        reason_code: 'no_meaningful_speech',
      },
    });
  }, 30_000);
});
