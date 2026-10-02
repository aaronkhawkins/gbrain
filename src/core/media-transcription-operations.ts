import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { MediaTranscriptionConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { fetchSource } from './sources-load.ts';
import { BIRDCLAW_RESEARCH_ENABLED_KEY } from './cycle/bookmark-extraction-policy.ts';
import { UnrecoverableError, type MinionHandler } from './minions/types.ts';

/** Retire only media whose source provenance identifies the bookmark adapter. */
export async function assertMediaTranscriptionResearchEnabled(
  engine: BrainEngine,
  provenanceSourceId: unknown,
): Promise<void> {
  if (provenanceSourceId !== 'birdclaw') return;
  const enabled = await engine.getConfig(BIRDCLAW_RESEARCH_ENABLED_KEY);
  if (enabled?.trim().toLowerCase() === 'false') {
    throw new UnrecoverableError('media_transcription:birdclaw_research_disabled');
  }
}

/** Check queued work at execution time without preventing unrelated workers from starting. */
export function gateMediaTranscriptionResearch(engine: BrainEngine, handler: MinionHandler): MinionHandler {
  return async (job) => {
    const media = job.data.media as { provenance?: { source_id?: unknown } } | undefined;
    await assertMediaTranscriptionResearchEnabled(engine, media?.provenance?.source_id);
    return handler(job);
  };
}

/** Fail closed unless the configured transcription owner is an active source. */
export async function assertActiveMediaTranscriptionSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<void> {
  const source = await fetchSource(engine, sourceId);
  if (!source) {
    throw new Error('media transcription target source is not registered');
  }
  if (source.archived === true) {
    throw new Error('media transcription target source is archived');
  }
}

async function inspectRuntime(config: MediaTranscriptionConfig): Promise<void> {
  const [cliPath, audioRoot] = await Promise.all([
    realpath(config.cli_path),
    realpath(config.audio_root),
  ]);
  const [cliMetadata, rootMetadata] = await Promise.all([
    stat(cliPath),
    stat(audioRoot),
  ]);
  if (!cliMetadata.isFile() || !rootMetadata.isDirectory()) {
    throw new Error('invalid media transcription runtime');
  }
  await access(cliPath, constants.X_OK);
}

/**
 * Probe runtime files without blocking a snapshot on filesystem I/O.
 * Declarative discovery remains authoritative; this only adds an explicit
 * degraded/unknown signal when the configured runtime cannot be reached.
 */
export async function probeMediaTranscriptionRuntime(
  config: MediaTranscriptionConfig,
  timeoutMs = 250,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      inspectRuntime(config),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('media transcription runtime probe timed out')),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
