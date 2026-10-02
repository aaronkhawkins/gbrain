import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { discoverExtractablePages, countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { classifyExtractionCandidate } from '../src/core/cycle/bookmark-extraction-policy.ts';
import { collectResearchHealth } from '../src/core/research-health.ts';
import { gateMediaTranscriptionResearch } from '../src/core/media-transcription-operations.ts';
import { submitMediaTranscription } from '../src/core/media-transcription-submit.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { makeMediaTranscriptionHandler } from '../src/core/minions/handlers/media-transcription.ts';
import { MEDIA_EVIDENCE_API_VERSION, type MediaEvidence, type MediaProcessorIdentity } from '../src/core/ingestion/media-evidence.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const bookmark = {
  intake_adapter: 'birdclaw-bookmarks-to-brain',
  content_kind: 'x-bookmark',
  concept_synthesis_candidate: true,
};

async function seed(slug: string, type: 'media' | 'article' | 'atom', frontmatter: Record<string, unknown>) {
  await engine.putPage(slug, {
    type, title: slug, compiled_truth: `${slug}: ${'Synthetic evidence. '.repeat(40)}`,
    timeline: '', frontmatter,
  }, { sourceId: 'default' });
}

test('opt-out removes only bookmark admission from discovery and both backlog scopes', async () => {
  await seed('media/bookmark', 'media', bookmark);
  await seed('articles/ordinary', 'article', {});
  expect((await discoverExtractablePages(engine, 'default')).length).toBe(2);
  expect(classifyExtractionCandidate({ type: 'media', frontmatter: bookmark }).eligible).toBe(true);

  await engine.setConfig('research.birdclaw.enabled', 'false');
  expect((await discoverExtractablePages(engine, 'default')).map(row => row.slug)).toEqual(['articles/ordinary']);
  expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
  expect(await countExtractAtomsBacklog(engine)).toBe(1);
  expect((await collectResearchHealth(engine)).totals.backlog).toBe(0);
  expect(classifyExtractionCandidate({ type: 'media', frontmatter: bookmark }, false).eligible).toBe(false);
  expect(classifyExtractionCandidate({ type: 'article' }, false).eligible).toBe(true);
  expect(await engine.getPage('media/bookmark', { sourceId: 'default' })).not.toBeNull();

  await engine.unsetConfig('research.birdclaw.enabled');
  expect((await discoverExtractablePages(engine, 'default')).length).toBe(2);
});

test('global synthesis ignores only BirdClaw atoms, including atoms in a mixed concept', async () => {
  for (const n of [1, 2]) {
    await seed(`atoms/bookmark-${n}`, 'atom', {
      research_policy: 'birdclaw-research-v1', source_slug: `media/bookmark-${n}`,
      concepts: ['bookmark-only', 'shared'],
    });
    await seed(`atoms/ordinary-${n}`, 'atom', { concepts: ['ordinary-only', 'shared'] });
  }
  const before = await runPhaseSynthesizeConcepts(engine, { dryRun: true });
  expect(before.details?.atoms_seen).toBe(4);
  expect(before.details?.groups_found).toBe(3);

  await engine.setConfig('research.birdclaw.enabled', 'false');
  const after = await runPhaseSynthesizeConcepts(engine, { dryRun: true });
  expect(after.details?.atoms_seen).toBe(2);
  expect(after.details?.groups_found).toBe(2);
  const retained = await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM pages');
  expect(retained[0].count).toBe(4);
});

const processor: MediaProcessorIdentity = {
  processor_key: 'media.transcription', processor_version: '1',
  model_provider: 'local', model_name: 'synthetic', model_version: '1',
};
function media(source: string): MediaEvidence {
  return {
    api_version: MEDIA_EVIDENCE_API_VERSION, id: `${source}-audio`,
    url: 'https://media.example/audio.wav', kind: 'audio', content_hash: 'a'.repeat(64),
    owner: { brain_id: 'host', target_source_id: 'default' },
    provenance: { source_id: source, external_id: `${source}-1`, source_uri: 'https://media.example/item' },
    acquisition: { status: 'acquired', reason_code: null },
  };
}

test('submission refuses retired bookmark media but allows unrelated media in the same target source', async () => {
  await engine.setConfig('research.birdclaw.enabled', 'false');
  await expect(submitMediaTranscription(engine, media('birdclaw'), processor))
    .rejects.toThrow('media_transcription:birdclaw_research_disabled');
  await expect(submitMediaTranscription(engine, media('podcast'), processor)).resolves.toBeDefined();
  const rows = await engine.executeRaw<{ count: number }>('SELECT COUNT(*)::int AS count FROM minion_jobs');
  expect(rows[0].count).toBe(1);
});

test('already queued bookmark media is rejected before transport while another media job completes', async () => {
  await submitMediaTranscription(engine, media('birdclaw'), processor);
  await submitMediaTranscription(engine, media('podcast'), processor);
  await engine.setConfig('research.birdclaw.enabled', 'false');
  const attempted: string[] = [];
  const worker = new MinionWorker(engine, {
    pollInterval: 5, stalledInterval: 60_000, healthCheckInterval: 0,
  });
  worker.register('media_transcription', gateMediaTranscriptionResearch(engine,
    makeMediaTranscriptionHandler({ attempt: async input => {
      attempted.push(input.media.provenance.source_id);
      return { schema_version: 1, outcome: 'ignored', reason_code: 'no_meaningful_speech' };
    } }),
  ));
  const running = worker.start();
  try {
    const expires = Date.now() + 5_000;
    while (Date.now() < expires) {
      const jobs = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs');
      if (jobs.every(job => ['dead', 'completed'].includes(job.status))) break;
      await Bun.sleep(10);
    }
  } finally {
    worker.stop();
    await running;
  }
  const jobs = await engine.executeRaw<{ status: string; error_text: string | null; attempts_started: number; attempts_made: number }>(
    'SELECT status, error_text, attempts_started, attempts_made FROM minion_jobs ORDER BY id',
  );
  expect(jobs[0]).toMatchObject({ status: 'dead', error_text: 'media_transcription:birdclaw_research_disabled', attempts_started: 1 });
  expect(jobs[1].status).toBe('completed');
  expect(attempted).toEqual(['podcast']);
});
