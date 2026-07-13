#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

type Json = Record<string, unknown>;

function fail(message: string): never {
  console.error(`[pilot] ${message}`);
  process.exit(2);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRegularNoFollow(path: string, privateInput = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`refusing non-regular input: ${basename(path)}`);
  if (privateInput && (stat.mode & 0o077) !== 0) fail(`private input must be mode 0600: ${basename(path)}`);
}

function atomicPrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* renamed or absent */ }
  }
}

function readJson(path: string, privateInput = false): Json {
  assertRegularNoFollow(path, privateInput);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`expected JSON object: ${basename(path)}`);
  return parsed as Json;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`missing ${field}`);
  return value;
}

function prepare(cohortPath: string, sourceDir: string, manifestPath: string, privateInput = false): void {
  assertRegularNoFollow(cohortPath, privateInput);
  mkdirSync(join(sourceDir, 'bookmarks'), { recursive: true, mode: 0o700 });
  const lines = readFileSync(cohortPath, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) fail('cohort is empty');

  const seen = new Set<string>();
  const records = lines.map((line, index) => {
    const record = JSON.parse(line) as Json;
    const id = requiredString(record.id, `record ${index + 1} id`);
    const text = requiredString(record.text, `record ${index + 1} text`);
    if (seen.has(id)) fail(`duplicate cohort id at record ${index + 1}`);
    seen.add(id);
    const recordHash = sha256(JSON.stringify({ id, text }));
    return { id, text, recordHash };
  }).sort((a, b) => a.recordHash.localeCompare(b.recordHash));

  const files: Array<{ path: string; sha256: string; source_record_hash: string }> = [];
  for (const record of records) {
    const rel = `bookmarks/${record.recordHash}.md`;
    const body = [
      '---',
      'type: media',
      'intake_adapter: birdclaw-bookmarks-to-brain',
      'content_kind: x-bookmark',
      'concept_synthesis_candidate: true',
      `source_record_hash: ${record.recordHash}`,
      '---',
      '',
      record.text,
      '',
    ].join('\n');
    const out = join(sourceDir, rel);
    if (lstatExists(out)) {
      assertRegularNoFollow(out);
      if (readFileSync(out, 'utf8') !== body) fail(`immutable source mismatch: ${rel}`);
    } else {
      const fd = openSync(out, 'wx', 0o600);
      try { writeFileSync(fd, body); } finally { closeSync(fd); }
    }
    chmodSync(out, 0o600);
    files.push({ path: rel, sha256: sha256(body), source_record_hash: record.recordHash });
  }

  const expected = new Set(files.map((file) => file.path));
  for (const name of readdirSync(join(sourceDir, 'bookmarks'))) {
    const rel = `bookmarks/${name}`;
    if (!expected.has(rel)) fail(`unlisted file in isolated cohort: ${rel}`);
  }
  const cohortSha = sha256(files.map((file) => `${file.source_record_hash}\n`).join(''));
  atomicPrivateJson(manifestPath, {
    schema_version: 1,
    cohort_sha256: cohortSha,
    record_count: files.length,
    files,
  });
  console.log(JSON.stringify({ record_count: files.length, cohort_hash_prefix: cohortSha.slice(0, 12) }));
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function treeDigest(root: string, outputPath: string): void {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`refusing symlink in snapshot: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(root, path), sha256: sha256(readFileSync(path)) });
      else fail(`refusing special file in snapshot: ${relative(root, path)}`);
    }
  };
  walk(root);
  const digest = sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
  atomicPrivateJson(outputPath, { schema_version: 1, digest, file_count: files.length, files });
  console.log(JSON.stringify({ file_count: files.length, digest_prefix: digest.slice(0, 12) }));
}

function ratio(numerator: number, denominator: number, field: string): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0 || numerator < 0 || numerator > denominator) {
    fail(`invalid scorecard count: ${field}`);
  }
  return numerator / denominator;
}

function counts(metric: unknown, field: string): [number, number] {
  if (!metric || typeof metric !== 'object') fail(`missing scorecard metric: ${field}`);
  const value = metric as Json;
  return [Number(value.pass ?? value.correct ?? value.count), Number(value.total)];
}

type Query = { id: string; relevant: string[] };
type Ranking = { query_id: string; results: string[] };

function retrievalMetrics(queries: Query[], rankings: Ranking[]): { recall_at_10: number; ndcg_at_10: number } {
  const byQuery = new Map(rankings.map((ranking) => [ranking.query_id, ranking.results]));
  let recall = 0;
  let ndcg = 0;
  for (const query of queries) {
    const relevant = new Set(query.relevant);
    const results = (byQuery.get(query.id) ?? []).slice(0, 10);
    recall += results.filter((id) => relevant.has(id)).length / relevant.size;
    const dcg = results.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const idealCount = Math.min(10, relevant.size);
    const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
    ndcg += idcg === 0 ? 0 : dcg / idcg;
  }
  return { recall_at_10: recall / queries.length, ndcg_at_10: ndcg / queries.length };
}

function parseQueries(input: Json): Query[] {
  if (!Array.isArray(input.queries) || input.queries.length === 0) fail('evaluation queries are required');
  return input.queries.map((raw, index) => {
    const value = raw as Json;
    const id = requiredString(value.id, `query ${index + 1} id`);
    if (!Array.isArray(value.relevant) || value.relevant.length === 0 || !value.relevant.every((item) => typeof item === 'string')) {
      fail(`query ${index + 1} requires relevant ids`);
    }
    return { id, relevant: value.relevant as string[] };
  });
}

function parseRankings(raw: unknown, field: string): Ranking[] {
  if (!Array.isArray(raw)) fail(`${field} rankings are required`);
  return raw.map((entry, index) => {
    const value = entry as Json;
    const queryId = requiredString(value.query_id, `${field} ranking ${index + 1} query_id`);
    if (!Array.isArray(value.results) || !value.results.every((item) => typeof item === 'string')) fail(`${field} ranking ${index + 1} results are invalid`);
    return { query_id: queryId, results: value.results as string[] };
  });
}

function score(scorecardPath: string, evaluationPath: string, outputPath: string): void {
  const input = readJson(scorecardPath, true);
  const evaluation = readJson(evaluationPath, true);
  const [useful, atoms] = counts(input.useful_atoms, 'useful_atoms');
  const [correctLinks, sampledLinks] = counts(input.source_links, 'source_links');
  const [evidence, evidenceTotal] = counts(input.evidence_coverage, 'evidence_coverage');
  const [falseMerges, mergeTotal] = counts(input.false_concept_merges, 'false_concept_merges');
  const [duplicates, conceptTotal] = counts(input.duplicate_concepts, 'duplicate_concepts');
  const [answered, questionTotal] = counts(input.representative_questions, 'representative_questions');
  const metrics = {
    useful_atom_rate: ratio(useful, atoms, 'useful_atoms'),
    source_link_correctness: ratio(correctLinks, sampledLinks, 'source_links'),
    evidence_coverage: ratio(evidence, evidenceTotal, 'evidence_coverage'),
    false_concept_merge_rate: ratio(falseMerges, mergeTotal, 'false_concept_merges'),
    duplicate_concept_rate: ratio(duplicates, conceptTotal, 'duplicate_concepts'),
    representative_questions_answered: answered,
    representative_questions_total: questionTotal,
  };
  const qualityChecks = {
    useful_atoms: metrics.useful_atom_rate >= 0.8,
    source_links: metrics.source_link_correctness === 1,
    evidence: metrics.evidence_coverage >= 0.9,
    false_merges: metrics.false_concept_merge_rate <= 0.1,
    duplicates: metrics.duplicate_concept_rate <= 0.1,
    representative_questions: questionTotal === 5 && answered >= 4,
  };

  const queries = parseQueries(evaluation);
  const lexical = retrievalMetrics(queries, parseRankings(evaluation.lexical_rankings, 'lexical'));
  if (!Array.isArray(evaluation.providers) || evaluation.providers.length === 0) fail('at least one evaluation provider is required');
  const providers = evaluation.providers.map((raw, index) => {
    const provider = raw as Json;
    const name = requiredString(provider.name, `provider ${index + 1} name`);
    const chunker = requiredString(provider.chunker_signature, `${name} chunker_signature`);
    const preprocessing = requiredString(provider.preprocessing_signature, `${name} preprocessing_signature`);
    const measured = retrievalMetrics(queries, parseRankings(provider.rankings, name));
    const unsupported = Number(provider.unsupported_results);
    const resultCount = Number(provider.result_count);
    if (!Number.isFinite(unsupported) || !Number.isFinite(resultCount) || unsupported < 0 || resultCount <= 0 || unsupported > resultCount) fail(`invalid ${name} unsupported-result counts`);
    const latencyMs = Number(provider.latency_ms);
    const costUsd = Number(provider.cost_usd);
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(costUsd) || costUsd < 0) fail(`invalid ${name} latency or cost`);
    return {
      name,
      ...measured,
      unsupported_result_rate: unsupported / resultCount,
      latency_ms: latencyMs,
      cost_usd: costUsd,
      chunker_signature: chunker,
      preprocessing_signature: preprocessing,
      not_worse_than_lexical: measured.recall_at_10 >= lexical.recall_at_10 && measured.ndcg_at_10 >= lexical.ndcg_at_10,
    };
  });
  const qualityPass = Object.values(qualityChecks).every(Boolean);
  const embeddingPass = providers.every((provider) => provider.not_worse_than_lexical);
  const passed = qualityPass && embeddingPass;
  atomicPrivateJson(outputPath, {
    schema_version: 1,
    decision: passed ? 'pass' : 'block_cleanup_and_backlog',
    thresholds: {
      useful_atom_rate_min: 0.8,
      source_link_correctness_min: 1,
      evidence_coverage_min: 0.9,
      false_concept_merge_rate_max: 0.1,
      duplicate_concept_rate_max: 0.1,
      representative_questions_min: 4,
      representative_questions_total: 5,
      provider_not_worse_than_lexical: true,
    },
    metrics,
    quality_checks: qualityChecks,
    retrieval: { lexical, providers, dgx_decision: 'deferred' },
  });
  console.log(JSON.stringify({ decision: passed ? 'pass' : 'block_cleanup_and_backlog', quality_pass: qualityPass, embedding_pass: embeddingPass }));
  if (!passed) process.exit(3);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare' && (args.length === 3 || args.length === 4)) prepare(args[0]!, args[1]!, args[2]!, args[3] === 'private');
else if (command === 'tree-digest' && args.length === 2) treeDigest(args[0]!, args[1]!);
else if (command === 'score' && args.length === 3) score(args[0]!, args[1]!, args[2]!);
else fail('usage: isolated-research-pilot.ts prepare COHORT SOURCE MANIFEST [private] | tree-digest ROOT OUTPUT | score SCORECARD EVALUATION OUTPUT');
