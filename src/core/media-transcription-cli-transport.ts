import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { MediaTranscriptionConfig } from './config.ts';
import type {
  MediaProcessorIdentity,
  MediaTranscriptSegment,
} from './ingestion/media-evidence.ts';
import {
  mediaTranscriptionErrorFromCliCode,
  MediaTranscriptionTransportError,
  type MediaTranscriptionAttempt,
  type MediaTranscriptionAttemptResult,
  type MediaTranscriptionTransport,
  type MediaTranscriptionTransportErrorKind,
} from './media-transcription-transport.ts';
import { isValidSourceId } from './source-id.ts';

const MAX_RESULT_BYTES = 5_000_000;
// #39 emits one required record terminator after its bounded JSON document.
const MAX_STDOUT_BYTES = MAX_RESULT_BYTES + 1;
const MAX_STDERR_BYTES = 4_096;
// The Parakeet runner reserves up to 30 seconds after SIGTERM for scoped
// remote cleanup. Keep this below the worker's 60-second hard deadline while
// allowing that cleanup to finish before the controller falls back to SIGKILL.
const TERMINATE_GRACE_MS = 35_000;
const SAFE_MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LANGUAGE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const CLI_ERROR_RE = /^gbrain-parakeet:([a-z_]+)\n$/;
const CLEANUP_WARNING = 'gbrain-parakeet:cleanup_failed\n';
const EXPECTED_RUNTIME_IMAGE =
  'sha256:8906f0c7e2267fb872e950cf9a60d60e8f5891686bc922ffcd3e7fe8511c0dca';
const EXPECTED_RUNTIME_SOURCE_HASHES = Object.freeze({
  'runners/__init__.py': 'd1862cdd5d4d197531347717d1584449177a252790de69dc0357c56b92f40982',
  'runners/gbrain_single.py': 'dd9aa4a982f481c668981d896919a1cfb17fcae48ef0e8774c52bb6d782dfe0c',
  'scripts/__init__.py': 'eb107601d5e971751a4aad5d1c527953b979839a27489813d1a5c426101d673e',
  'scripts/audio_chunks.py': 'c908091c46e45eb99faabc8aec569dd9440f2ede8a520fa0a590d95986729f60',
  'scripts/gbrain_result.py': '4bc8d14a4109cadd61b17956456142d192bcbff54df7e45dcb4e7bdd4ba84a11',
  'scripts/gbrain_single_contract.py': 'b10553b09c002b1a0c163d4015943aa7abba27111a592523f450a40107f034bc',
});

export const PARAKEET_PROCESSOR_IDENTITY = Object.freeze({
  processor_key: 'parakeet-asr',
  processor_version: '1',
  model_provider: 'nvidia',
  model_name: 'parakeet-tdt-0.6b-v2',
  model_version: 'ae9ad07059c7c739ffaf932226a8fe64ae2620b0',
}) satisfies MediaProcessorIdentity;

interface ProcessCapture {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
  aborted: boolean;
}

function transportError(
  code: ConstructorParameters<typeof MediaTranscriptionTransportError>[0],
  kind: MediaTranscriptionTransportErrorKind,
): MediaTranscriptionTransportError {
  return new MediaTranscriptionTransportError(code, kind);
}

function invalidConfig(): never {
  throw transportError('invalid_runtime_config', 'permanent');
}

function resolveExecutable(path: string): string {
  if (!isAbsolute(path)) invalidConfig();
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) invalidConfig();
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    if (error instanceof MediaTranscriptionTransportError) throw error;
    return invalidConfig();
  }
}

function resolveAudioRoot(path: string): string {
  if (!isAbsolute(path)) invalidConfig();
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) invalidConfig();
    return resolved;
  } catch (error) {
    if (error instanceof MediaTranscriptionTransportError) throw error;
    return invalidConfig();
  }
}

function sameProcessor(
  actual: MediaProcessorIdentity,
  expected: MediaProcessorIdentity,
): boolean {
  return actual.processor_key === expected.processor_key
    && actual.processor_version === expected.processor_version
    && actual.model_provider === expected.model_provider
    && actual.model_name === expected.model_name
    && actual.model_version === expected.model_version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveAudioArtifact(root: string, mediaId: string): string {
  if (!SAFE_MEDIA_ID_RE.test(mediaId)) {
    throw transportError('locator_invalid', 'permanent');
  }
  const candidate = join(root, mediaId, 'audio.wav');
  try {
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw transportError('locator_invalid', 'permanent');
    }
    const resolved = realpathSync(candidate);
    const confined = relative(root, resolved);
    if (!confined || isAbsolute(confined) || confined.split(/[\\/]/).includes('..')) {
      throw transportError('locator_invalid', 'permanent');
    }
    return resolved;
  } catch (error) {
    if (error instanceof MediaTranscriptionTransportError) throw error;
    throw transportError('artifact_missing', 'permanent');
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  retainedBytes: { value: number },
  maximumBytes: number,
): boolean {
  if (retainedBytes.value + chunk.length > maximumBytes) return false;
  chunks.push(chunk);
  retainedBytes.value += chunk.length;
  return true;
}

async function runCli(argv: string[], signal: AbortSignal): Promise<ProcessCapture> {
  if (signal.aborted) throw transportError('cancelled', 'cancelled');
  return await new Promise<ProcessCapture>((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(transportError('invalid_runtime_config', 'permanent'));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutBytes = { value: 0 };
    const stderrBytes = { value: 0 };
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let aborted = false;
    let terminating = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return;
      terminating = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS);
      killTimer.unref();
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (value: Buffer) => {
      if (!appendBounded(stdout, value, stdoutBytes, MAX_STDOUT_BYTES)) {
        stdoutOverflow = true;
        terminate();
      }
    });
    child.stderr.on('data', (value: Buffer) => {
      if (!appendBounded(stderr, value, stderrBytes, MAX_STDERR_BYTES)) {
        stderrOverflow = true;
        terminate();
      }
    });
    child.once('error', () => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      reject(transportError('invalid_runtime_config', 'permanent'));
    });
    child.once('close', (exitCode, exitSignal) => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutOverflow,
        stderrOverflow,
        aborted,
      });
    });
  });
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw transportError('result_schema_invalid', 'permanent');
  }
}

function validateRuntimeIdentity(value: unknown): boolean {
  if (!isRecord(value)
    || value.imageId !== EXPECTED_RUNTIME_IMAGE
    || !isRecord(value.sourceHashes)
    || Object.keys(value.sourceHashes).length
      !== Object.keys(EXPECTED_RUNTIME_SOURCE_HASHES).length) {
    return false;
  }
  const sourceHashes = value.sourceHashes;
  return Object.entries(EXPECTED_RUNTIME_SOURCE_HASHES).every(([path, digest]) =>
    sourceHashes[path] === digest
  );
}

function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) throw transportError('result_schema_invalid', 'permanent');
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  const absolute = Math.abs(value);
  if (absolute === 0 || (absolute >= 1e-4 && absolute < 1e16)) {
    return String(value);
  }
  const [coefficient, exponent = '0'] = value.toExponential().split('e');
  const parsedExponent = Number(exponent);
  const sign = parsedExponent >= 0 ? '+' : '-';
  return `${coefficient}e${sign}${String(Math.abs(parsedExponent)).padStart(2, '0')}`;
}

function transcriptContentHash(payload: Record<string, unknown>): string {
  const segments = payload.segments as Record<string, unknown>[];
  const canonicalSegments = segments.map((segment) => {
    const keys = Object.keys(segment).sort();
    const expectedKeys = segment.speaker === undefined
      ? ['end', 'start', 'text']
      : ['end', 'speaker', 'start', 'text'];
    if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
      throw transportError('result_schema_invalid', 'permanent');
    }
    const speaker = segment.speaker === undefined
      ? ''
      : `,"speaker":${JSON.stringify(segment.speaker)}`;
    return `{"end":${pythonFloat(segment.end as number)}${speaker},`
      + `"start":${pythonFloat(segment.start as number)},`
      + `"text":${JSON.stringify(segment.text)}}`;
  }).join(',');
  // #39's build_result normalizes all segment times to Python floats. A
  // non-empty segment list therefore also makes speechSeconds a float; the
  // empty-list no-speech result retains Python's integer zero.
  const speechSeconds = segments.length === 0
    ? JSON.stringify(payload.speechSeconds)
    : pythonFloat(payload.speechSeconds as number);
  const canonical = `{"hasMeaningfulSpeech":${JSON.stringify(payload.hasMeaningfulSpeech)},`
    + `"language":${JSON.stringify(payload.language)},`
    + `"model":${JSON.stringify(payload.model)},`
    + `"segments":[${canonicalSegments}],`
    + `"speechSeconds":${speechSeconds},`
    + `"status":${JSON.stringify(payload.status)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function processorFromResult(value: unknown): MediaProcessorIdentity | null {
  if (!isRecord(value)) return null;
  const processor = {
    processor_key: value.processor_key,
    processor_version: value.processor_version,
    model_provider: value.model_provider,
    model_name: value.model_name,
    model_version: value.model_version,
  };
  if (!Object.values(processor).every((item) => typeof item === 'string')) return null;
  return processor as MediaProcessorIdentity;
}

function mapSuccessResult(
  payload: unknown,
  input: MediaTranscriptionAttempt,
): MediaTranscriptionAttemptResult {
  if (!isRecord(payload)
    || payload.apiVersion !== 'gbrain-parakeet-result-v1'
    || payload.schemaVersion !== 1
    || payload.status !== 'complete'
    || payload.model !== 'nemo-parakeet-tdt-0.6b-v2'
    || payload.mediaId !== input.media.id
    || payload.mediaContentHash !== input.media.content_hash
    || typeof payload.transcriptContentHash !== 'string'
    || !SHA256_RE.test(payload.transcriptContentHash)
    || typeof payload.language !== 'string'
    || !LANGUAGE_RE.test(payload.language)
    || typeof payload.hasMeaningfulSpeech !== 'boolean'
    || typeof payload.speechSeconds !== 'number'
    || !Number.isFinite(payload.speechSeconds)
    || payload.speechSeconds < 0
    || !Array.isArray(payload.segments)
  ) {
    throw transportError('result_schema_invalid', 'permanent');
  }
  const processor = processorFromResult(payload.processor);
  if (!processor || !sameProcessor(processor, input.processor)) {
    throw transportError('result_schema_invalid', 'permanent');
  }
  if (!validateRuntimeIdentity(payload.runtimeIdentity)) {
    throw transportError('runtime_mismatch', 'permanent');
  }

  const segments: MediaTranscriptSegment[] = payload.segments.map((value) => {
    if (!isRecord(value)
      || typeof value.start !== 'number'
      || !Number.isFinite(value.start)
      || value.start < 0
      || typeof value.end !== 'number'
      || !Number.isFinite(value.end)
      || value.end < value.start
      || typeof value.text !== 'string'
      || value.text.length === 0) {
      throw transportError('result_schema_invalid', 'permanent');
    }
    const segment: MediaTranscriptSegment = {
      start_seconds: value.start,
      end_seconds: value.end,
      text: value.text,
    };
    if (typeof value.speaker === 'string' && value.speaker.length > 0) {
      segment.speaker = value.speaker;
    } else if (value.speaker !== undefined && value.speaker !== '') {
      throw transportError('result_schema_invalid', 'permanent');
    }
    return segment;
  });

  if (transcriptContentHash(payload) !== payload.transcriptContentHash) {
    throw transportError('result_schema_invalid', 'permanent');
  }

  if (!payload.hasMeaningfulSpeech) {
    return {
      schema_version: 1,
      outcome: 'ignored',
      reason_code: 'no_meaningful_speech',
    };
  }

  if (segments.length === 0) {
    throw transportError('result_schema_invalid', 'permanent');
  }
  const text = segments.map(segment => segment.text).join('\n');
  if (text.length === 0 || text.length > 2_000_000) {
    throw transportError('result_schema_invalid', 'permanent');
  }
  return {
    schema_version: 1,
    outcome: 'complete',
    transcript: {
      source_kind: 'asr',
      media_id: input.media.id,
      media_content_hash: input.media.content_hash!,
      transcript_content_hash: payload.transcriptContentHash,
      language: payload.language,
      text,
      segments,
      ...input.processor,
    },
  };
}

function classifyFailure(capture: ProcessCapture): never {
  if (capture.aborted) throw transportError('cancelled', 'cancelled');
  if (capture.stdout.length !== 0 || capture.stderrOverflow || capture.signal !== null) {
    throw transportError('transport_failed', 'transient');
  }
  let stderr: string;
  try {
    stderr = decodeUtf8(capture.stderr);
  } catch {
    throw transportError('transport_failed', 'transient');
  }
  const match = CLI_ERROR_RE.exec(stderr);
  if (!match) throw transportError('transport_failed', 'transient');
  const mapped = mediaTranscriptionErrorFromCliCode(match[1]);
  const expectedExit = mapped.kind === 'permanent'
    ? 65
    : mapped.kind === 'transient'
      ? 75
      : 130;
  if (capture.exitCode !== expectedExit) {
    throw transportError('transport_failed', 'transient');
  }
  throw mapped;
}

export class CliMediaTranscriptionTransport implements MediaTranscriptionTransport {
  private readonly config: MediaTranscriptionConfig;

  constructor(config: MediaTranscriptionConfig) {
    if (!isValidSourceId(config.target_source_id)) invalidConfig();
    this.config = {
      cli_path: resolveExecutable(config.cli_path),
      audio_root: resolveAudioRoot(config.audio_root),
      target_source_id: config.target_source_id,
    };
  }

  async attempt(input: MediaTranscriptionAttempt): Promise<MediaTranscriptionAttemptResult> {
    if (input.media.owner.target_source_id !== this.config.target_source_id) {
      throw transportError('locator_invalid', 'permanent');
    }
    if (!sameProcessor(input.processor, PARAKEET_PROCESSOR_IDENTITY)) {
      throw transportError('processor_mismatch', 'permanent');
    }
    if (input.media.content_hash === null || !SHA256_RE.test(input.media.content_hash)) {
      throw transportError('hash_mismatch', 'permanent');
    }
    const audio = resolveAudioArtifact(this.config.audio_root, input.media.id);
    const argv = [
      this.config.cli_path,
      '--audio', audio,
      '--sha256', input.media.content_hash,
      '--media-id', input.media.id,
      '--processor-key', PARAKEET_PROCESSOR_IDENTITY.processor_key,
      '--processor-version', PARAKEET_PROCESSOR_IDENTITY.processor_version,
      '--model-provider', PARAKEET_PROCESSOR_IDENTITY.model_provider,
      '--model-name', PARAKEET_PROCESSOR_IDENTITY.model_name,
      '--model-version', PARAKEET_PROCESSOR_IDENTITY.model_version,
      '--deadline-at-ms', String(input.deadline_at_ms),
    ];
    const capture = await runCli(argv, input.signal);
    if (capture.aborted) {
      throw transportError('cancelled', 'cancelled');
    }
    if (capture.stdoutOverflow) {
      throw transportError('result_too_large', 'permanent');
    }
    if (capture.exitCode !== 0) classifyFailure(capture);
    if (capture.signal !== null || capture.stderrOverflow) {
      throw transportError('transport_failed', 'transient');
    }
    let stderr: string;
    try {
      stderr = decodeUtf8(capture.stderr);
    } catch {
      throw transportError('transport_failed', 'transient');
    }
    if (stderr !== '' && stderr !== CLEANUP_WARNING) {
      throw transportError('transport_failed', 'transient');
    }
    if (stderr === CLEANUP_WARNING) process.stderr.write(CLEANUP_WARNING);
    const stdout = decodeUtf8(capture.stdout);
    if (!stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) {
      throw transportError('result_schema_invalid', 'permanent');
    }
    if (capture.stdout.length - 1 > MAX_RESULT_BYTES) {
      throw transportError('result_too_large', 'permanent');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(stdout.slice(0, -1));
    } catch {
      throw transportError('result_schema_invalid', 'permanent');
    }
    return mapSuccessResult(payload, input);
  }
}
