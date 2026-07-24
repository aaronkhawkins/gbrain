import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_EVIDENCE_API_VERSION,
  type MediaEvidence,
} from '../src/core/ingestion/media-evidence.ts';
import {
  CliMediaTranscriptionTransport,
  PARAKEET_PROCESSOR_IDENTITY,
} from '../src/core/media-transcription-cli-transport.ts';
import { resolveMediaTranscriptionConfig } from '../src/core/config.ts';
import { MediaTranscriptionTransportError } from '../src/core/media-transcription-transport.ts';

const AUDIO_HASH = 'a'.repeat(64);
const roots: string[] = [];

function scratch(prefix = 'gbrain-media-cli-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidence(id = 'audio-1'): MediaEvidence {
  return {
    api_version: MEDIA_EVIDENCE_API_VERSION,
    id,
    url: 'https://media.example/audio.wav',
    kind: 'audio',
    content_hash: AUDIO_HASH,
    owner: {
      brain_id: 'host',
      target_source_id: 'research',
    },
    provenance: {
      source_id: 'collector',
      external_id: 'external-1',
      source_uri: 'https://source.example/items/1',
    },
    acquisition: {
      status: 'acquired',
      reason_code: null,
    },
  };
}

function makeArtifact(root: string, id = 'audio-1'): string {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'audio.wav');
  writeFileSync(path, 'fake audio bytes');
  return path;
}

type FakeMode =
  | 'complete'
  | 'ignored'
  | 'permanent'
  | 'transient'
  | 'cancelled'
  | 'stderr-overflow'
  | 'oversized'
  | 'sleep'
  | 'bad-runtime'
  | 'wrong-runtime-image'
  | 'wrong-runtime-digest'
  | 'bad-lineage'
  | 'bad-transcript-hash'
  | 'hash-mismatch'
  | 'bad-segments'
  | 'ignored-retained'
  | 'boundary-result'
  | 'over-boundary-result'
  | 'invalid-success-stderr';

function makeFakeCli(root: string, mode: FakeMode): { cli: string; log: string } {
  const directory = join(root, 'fake cli with spaces');
  mkdirSync(directory, { recursive: true });
  const cli = join(directory, 'parakeet fake');
  const log = join(root, 'argv.jsonl');
  // #39 normalizes segment timestamps to Python floats before hashing, so
  // integral timestamps canonically render as 0.0 even though JSON.parse
  // represents both 0 and 0.0 as the same JavaScript number.
  const completeHash = 'ecbf7e1e1249827147fa218d28346a23ffdadb3868f7e550f94e9964bc779705';
  const ignoredHash = '01f6821085e60f0571ce191f6de9703d0c2f884a676f2bd2d1d7a1fbcae9bd44';
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
const mode = ${JSON.stringify(mode)};
if (mode === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  process.exit(0);
}
if (mode === 'permanent') {
  process.stderr.write('gbrain-parakeet:input_changed\\n');
  process.exit(65);
}
if (mode === 'transient') {
  process.stderr.write('gbrain-parakeet:transport_failed\\n');
  process.exit(75);
}
if (mode === 'cancelled') {
  process.stderr.write('gbrain-parakeet:cancelled\\n');
  process.exit(130);
}
if (mode === 'stderr-overflow') {
  process.stderr.write('x'.repeat(100_000) + 'gbrain-parakeet:input_changed\\n');
  process.exit(65);
}
if (mode === 'oversized') {
  for (let i = 0; i < 6_000; i += 1) {
    if (!process.stdout.write('x'.repeat(1_024))) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }
  process.exit(0);
}
const meaningful = ['complete', 'bad-runtime', 'wrong-runtime-image', 'wrong-runtime-digest', 'bad-lineage', 'bad-transcript-hash', 'hash-mismatch', 'bad-segments', 'boundary-result', 'over-boundary-result', 'invalid-success-stderr'].includes(mode);
const segments = meaningful
  ? [{ start: 0, end: 1.5, text: 'One explicit transcript.', speaker: '' }]
  : mode === 'ignored-retained'
    ? [{ start: 0, end: 0.5, text: 'Hi', speaker: '' }]
  : [];
const result = {
  schemaVersion: 1,
  status: 'complete',
  model: 'nemo-parakeet-tdt-0.6b-v2',
  language: 'en',
  hasMeaningfulSpeech: meaningful,
  speechSeconds: meaningful ? 1.5 : mode === 'ignored-retained' ? 0.5 : 0,
  segments,
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
  transcriptContentHash: meaningful
    ? ${JSON.stringify(completeHash)}
    : mode === 'ignored-retained'
      ? '8fcca3afc0506bf4053c739c2245ee8ced57f7732eb95f6e615cc7a3d1af10d9'
      : ${JSON.stringify(ignoredHash)},
  runtimeIdentity: {
    imageId: 'sha256:8906f0c7e2267fb872e950cf9a60d60e8f5891686bc922ffcd3e7fe8511c0dca',
    sourceHashes: ${JSON.stringify(sourceHashes)},
  },
};
if (mode === 'bad-runtime') result.runtimeIdentity.imageId = 'not-an-image-id';
if (mode === 'wrong-runtime-image') result.runtimeIdentity.imageId = 'sha256:' + 'f'.repeat(64);
if (mode === 'wrong-runtime-digest') {
  result.runtimeIdentity.sourceHashes['runners/gbrain_single.py'] = 'f'.repeat(64);
}
if (mode === 'bad-lineage') result.mediaId = 'different-media';
if (mode === 'bad-transcript-hash') result.transcriptContentHash = 'not-a-hash';
if (mode === 'hash-mismatch') result.transcriptContentHash = 'f'.repeat(64);
if (mode === 'bad-segments') result.segments = [{ start: 2, end: 1, text: 'invalid' }];
if (mode === 'invalid-success-stderr') process.stderr.write(Buffer.from([0xff]));
if (mode === 'boundary-result' || mode === 'over-boundary-result') {
  result.padding = '';
  const base = JSON.stringify(result);
  const target = mode === 'boundary-result' ? 5_000_000 : 5_000_001;
  result.padding = 'x'.repeat(target - base.length);
}
process.stdout.write(JSON.stringify(result) + '\\n');
`);
  chmodSync(cli, 0o755);
  return { cli, log };
}

function transportInput(item = evidence(), signal = new AbortController().signal) {
  return {
    job_id: 7,
    attempt: 1,
    media: item,
    processor: PARAKEET_PROCESSOR_IDENTITY,
    deadline_at_ms: Date.now() + 10_000,
    signal,
  };
}

function transportConfig(cli: string, audioRoot: string, targetSourceId = 'research') {
  return {
    cli_path: realpathSync(cli),
    audio_root: realpathSync(audioRoot),
    target_source_id: targetSourceId,
  };
}

async function caught(promise: Promise<unknown>): Promise<MediaTranscriptionTransportError> {
  return await promise.catch((error: unknown) => error) as MediaTranscriptionTransportError;
}

describe('configured Parakeet CLI transport', () => {
  test('is dormant only when all configuration is absent and rejects partial configuration', () => {
    expect(resolveMediaTranscriptionConfig(undefined, {})).toBeUndefined();

    expect(() => resolveMediaTranscriptionConfig({
      engine: 'postgres',
      media_transcription: {
        cli_path: '/trusted/cli',
        target_source_id: 'research',
      },
    }, {})).toThrow(/media.transcription|media_transcription/i);
    expect(() => resolveMediaTranscriptionConfig({
      engine: 'postgres',
      media_transcription: {
        audio_root: '/trusted/audio',
        target_source_id: 'research',
      },
    }, {})).toThrow(/media.transcription|media_transcription/i);
    expect(() => resolveMediaTranscriptionConfig(undefined, {
      GBRAIN_MEDIA_TRANSCRIPTION_CLI: '/trusted/cli',
    })).toThrow(/media.transcription|media_transcription/i);
    expect(() => resolveMediaTranscriptionConfig(undefined, {
      GBRAIN_MEDIA_TRANSCRIPTION_CLI: '/trusted/cli',
      GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT: '/trusted/audio',
    })).toThrow(/media.transcription|media_transcription/i);
    expect(() => resolveMediaTranscriptionConfig({
      engine: 'postgres',
      media_transcription: { target_source_id: 'research' },
    }, {})).toThrow(/media.transcription|media_transcription/i);
  });

  test('environment values atomically override file-plane paths', () => {
    const root = scratch();
    const { cli } = makeFakeCli(root, 'complete');
    const audioRoot = join(root, 'audio');
    mkdirSync(audioRoot);
    expect(resolveMediaTranscriptionConfig({
      engine: 'postgres',
      media_transcription: {
        cli_path: cli,
        audio_root: audioRoot,
        target_source_id: 'file-source',
      },
    }, {
      GBRAIN_MEDIA_TRANSCRIPTION_CLI: cli,
      GBRAIN_MEDIA_TRANSCRIPTION_AUDIO_ROOT: audioRoot,
      GBRAIN_MEDIA_TRANSCRIPTION_TARGET_SOURCE_ID: 'env-source',
    })).toEqual({
      cli_path: cli,
      audio_root: audioRoot,
      target_source_id: 'env-source',
    });
  });

  test('runs exactly one argv-only child and maps a meaningful transcript', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    const audio = makeArtifact(audioRoot);
    const { cli, log } = makeFakeCli(root, 'complete');
    const transport = new CliMediaTranscriptionTransport(transportConfig(cli, audioRoot));

    const result = await transport.attempt(transportInput());

    expect(result).toEqual({
      schema_version: 1,
      outcome: 'complete',
      transcript: {
        source_kind: 'asr',
        media_id: 'audio-1',
        media_content_hash: AUDIO_HASH,
        transcript_content_hash: 'ecbf7e1e1249827147fa218d28346a23ffdadb3868f7e550f94e9964bc779705',
        language: 'en',
        text: 'One explicit transcript.',
        segments: [{
          start_seconds: 0,
          end_seconds: 1.5,
          text: 'One explicit transcript.',
        }],
        ...PARAKEET_PROCESSOR_IDENTITY,
      },
    });
    const invocations = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain('--audio');
    expect(invocations[0][invocations[0].indexOf('--audio') + 1]).toBe(realpathSync(audio));
    expect(invocations[0]).toContain('--deadline-at-ms');
    expect(invocations[0]).not.toContain('sh');
    expect(invocations[0]).not.toContain('-c');
  });

  test('maps a valid no-speech response to the semantic ignored outcome', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'ignored');

    const result = await new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput());

    expect(result).toEqual({
      schema_version: 1,
      outcome: 'ignored',
      reason_code: 'no_meaningful_speech',
    });
  });

  test('discards valid short retained segments when speech is not meaningful', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'ignored-retained');

    const result = await new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput());

    expect(result).toEqual({
      schema_version: 1,
      outcome: 'ignored',
      reason_code: 'no_meaningful_speech',
    });
  });

  test('rejects missing artifacts and path or symlink escape without spawning', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    mkdirSync(audioRoot);
    const { cli, log } = makeFakeCli(root, 'complete');
    const transport = new CliMediaTranscriptionTransport(transportConfig(cli, audioRoot));

    const missing = await caught(transport.attempt(transportInput()));
    expect(missing).toMatchObject({ kind: 'permanent' });
    expect(missing.message).not.toContain(root);

    const outside = join(root, 'outside.wav');
    writeFileSync(outside, 'outside');
    mkdirSync(join(audioRoot, 'audio-1'));
    symlinkSync(outside, join(audioRoot, 'audio-1', 'audio.wav'));
    const linked = await caught(transport.attempt(transportInput()));
    expect(linked).toMatchObject({ kind: 'permanent' });
    expect(linked.message).not.toContain(root);

    const escaped = await caught(transport.attempt(
      transportInput(evidence('../outside')),
    ));
    expect(escaped).toMatchObject({ kind: 'permanent', code: 'locator_invalid' });
    expect(existsSync(log)).toBe(false);
  });

  test('rejects media owned by a different target source before spawning', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli, log } = makeFakeCli(root, 'complete');
    const transport = new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot, 'birdclaw'),
    );

    const error = await caught(transport.attempt(transportInput()));

    expect(error).toMatchObject({ kind: 'permanent' });
    expect(error.message).not.toContain('research');
    expect(existsSync(log)).toBe(false);
  });

  test.each([
    ['permanent', 'input_changed', 'permanent'],
    ['transient', 'transport_failed', 'transient'],
    ['cancelled', 'cancelled', 'cancelled'],
  ] as const)('maps the exact CLI %s exit contract', async (mode, code, kind) => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, mode);
    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({ code, kind });
    expect(error.message).toBe(`media_transcription:${code}`);
    expect(error.message).not.toContain(root);
  });

  test.each([
    ['bad-runtime', 'runtime_mismatch'],
    ['wrong-runtime-image', 'runtime_mismatch'],
    ['wrong-runtime-digest', 'runtime_mismatch'],
    ['bad-lineage', 'result_schema_invalid'],
    ['bad-transcript-hash', 'result_schema_invalid'],
    ['hash-mismatch', 'result_schema_invalid'],
    ['bad-segments', 'result_schema_invalid'],
  ] as const)('rejects %s output as a content-free permanent result failure', async (mode, code) => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, mode);
    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({ kind: 'permanent', code });
    expect(error.message).toBe(`media_transcription:${code}`);
    expect(error.message).not.toContain('different-media');
  });

  test('accepts a maximum-size JSON result plus its required trailing newline', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'boundary-result');

    const result = await new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput());

    expect(result).toMatchObject({ outcome: 'complete' });
  });

  test('rejects JSON one byte above the result contract limit', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'over-boundary-result');

    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({ code: 'result_too_large', kind: 'permanent' });
  });

  test('treats invalid UTF-8 on successful stderr as a transient transport failure', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'invalid-success-stderr');

    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({ code: 'transport_failed', kind: 'transient' });
  });

  test('bounds child output and rejects an oversized result without retaining it', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'oversized');
    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({
      code: 'result_too_large',
      kind: 'permanent',
    });
    expect(error.message.length).toBeLessThan(100);
  });

  test('bounds stderr and rejects overflow without parsing a trailing error code', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli } = makeFakeCli(root, 'stderr-overflow');
    const error = await caught(new CliMediaTranscriptionTransport(
      transportConfig(cli, audioRoot),
    ).attempt(transportInput()));

    expect(error).toMatchObject({
      code: 'transport_failed',
      kind: 'transient',
    });
    expect(error.message).toBe('media_transcription:transport_failed');
  });

  test('aborts the one child promptly with a content-free cancellation', async () => {
    const root = scratch();
    const audioRoot = join(root, 'artifacts');
    makeArtifact(audioRoot);
    const { cli, log } = makeFakeCli(root, 'sleep');
    const controller = new AbortController();
    const transport = new CliMediaTranscriptionTransport(transportConfig(cli, audioRoot));
    const started = Date.now();
    const pending = caught(transport.attempt(transportInput(evidence(), controller.signal)));
    while (!existsSync(log)) await Bun.sleep(5);
    controller.abort(new Error('private cancellation detail'));

    const error = await pending;

    expect(error).toMatchObject({ code: 'cancelled', kind: 'cancelled' });
    expect(error.message).toBe('media_transcription:cancelled');
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 8_000);
});
