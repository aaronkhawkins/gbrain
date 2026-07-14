import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(import.meta.dir, '../../scripts/run-isolated-research-pilot.sh');
const HELPER = resolve(import.meta.dir, '../../scripts/lib/isolated-research-pilot.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function passingInputs(root: string): { cohort: string; scorecard: string; evaluation: string } {
  const cohort = join(root, 'synthetic.jsonl');
  writeFileSync(cohort, [
    JSON.stringify({ id: 'synthetic-1', text: 'A local build system can cache deterministic intermediate artifacts.' }),
    JSON.stringify({ id: 'synthetic-2', text: 'Evidence links let readers audit how a topic summary was formed.' }),
  ].join('\n') + '\n');
  const scorecard = join(root, 'scorecard.json');
  privateJson(scorecard, {
    useful_atoms: { count: 8, total: 10 },
    source_links: { correct: 10, total: 10 },
    evidence_coverage: { count: 9, total: 10 },
    false_concept_merges: { count: 1, total: 10 },
    duplicate_concepts: { count: 1, total: 10 },
    representative_questions: { count: 4, total: 5 },
  });
  const rankings = [
    { query_id: 'q1', results: ['topic-a', 'topic-b'] },
    { query_id: 'q2', results: ['topic-b', 'topic-a'] },
  ];
  const evaluation = join(root, 'evaluation.json');
  privateJson(evaluation, {
    queries: [
      { id: 'q1', relevant: ['topic-a'] },
      { id: 'q2', relevant: ['topic-b'] },
    ],
    lexical_rankings: rankings,
    providers: [{
      name: 'synthetic-provider',
      rankings,
      unsupported_results: 0,
      result_count: 4,
      latency_ms: 3,
      cost_usd: 0,
      chunker_signature: 'chunker:test-v1',
      preprocessing_signature: 'preprocess:test-v1',
    }],
  });
  return { cohort, scorecard, evaluation };
}

function fakeGbrain(root: string): string {
  const path = join(root, 'fake-gbrain.sh');
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
[[ -n "\${GBRAIN_HOME:-}" ]]
[[ -z "\${DATABASE_URL:-}" ]]
[[ -z "\${GBRAIN_DATABASE_URL:-}" ]]
printf '%s\\n' "$*" >> "$PILOT_PRIVATE_DIR/commands.log"
printf '%s\\n' 'private child output must stay private'
printf '%s\\n' 'private child error must stay private' >&2
if [[ "\${1:-}" == export ]]; then
  shift
  [[ "\${1:-}" == --dir ]]
  mkdir -p "$2/concepts"
  printf '%s\\n' 'synthetic stable wiki output' > "$2/concepts/research-methods.md"
fi
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

describe('isolated research pilot', () => {
  test('runs the scheduled path twice in an isolated home and produces a passing private decision', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pilot-'));
    roots.push(root);
    const inputs = passingInputs(root);
    const workRoot = join(root, 'private-work');
    const result = Bun.spawnSync({
      cmd: ['bash', SCRIPT, '--cohort', inputs.cohort, '--work-root', workRoot,
        '--scorecard-input', inputs.scorecard, '--evaluation-input', inputs.evaluation,
        '--gbrain-bin', fakeGbrain(root), '--synthetic'],
      env: { ...process.env, DATABASE_URL: 'postgres://must-not-leak', GBRAIN_DATABASE_URL: 'postgres://must-not-leak' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('idempotent=true');
    expect(result.stdout.toString()).not.toContain('private child output');
    expect(result.stderr.toString()).not.toContain('private child error');
    expect(result.stdout.toString()).not.toContain(realpathSync(workRoot));

    const commands = readFileSync(join(workRoot, 'private', 'commands.log'), 'utf8').trim().split('\n');
    const canonicalWorkRoot = realpathSync(workRoot);
    expect(commands.slice(0, 3)).toEqual([
      'init --pglite --no-embedding',
      `sources add research-pilot --path ${join(canonicalWorkRoot, 'collector-replay')} --name Isolated research pilot --no-federated`,
      'schema use gbrain-creator',
    ]);
    const scheduled = [
      'sync --source research-pilot --no-pull',
      'dream --source research-pilot --phase extract_atoms --drain --window 300',
      'dream --source research-pilot',
    ];
    expect(commands.slice(3, 6)).toEqual(scheduled);
    expect(commands.slice(7, 10)).toEqual(scheduled);

    const decision = JSON.parse(readFileSync(join(workRoot, 'private', 'decision.json'), 'utf8'));
    expect(decision.decision).toBe('candidate_pass_pending_human_review');
    expect(decision.cleanup_authorized).toBe(false);
    expect(decision.backlog_release_authorized).toBe(false);
    expect(decision.retrieval.lexical).toEqual({ recall_at_10: 1, ndcg_at_10: 1 });
    expect(decision.retrieval.providers[0].not_worse_than_lexical).toBe(true);
    expect(decision.retrieval.dgx_decision).toBe('deferred');
    expect(Bun.file(join(workRoot, 'private', 'decision.json')).size).toBeGreaterThan(0);
    const privateLogs = readdirSync(join(workRoot, 'private')).filter((name) => name.startsWith('gbrain-command-'));
    expect(privateLogs.length).toBeGreaterThan(0);
    for (const name of privateLogs) {
      expect(statSync(join(workRoot, 'private', name)).mode & 0o077).toBe(0);
    }
  });

  test('rejects a reused collector replay repository with any Git remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pilot-remote-'));
    roots.push(root);
    const inputs = passingInputs(root);
    const workRoot = join(root, 'private-work');
    const source = join(workRoot, 'collector-replay');
    mkdirSync(source, { recursive: true });
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'Pilot Test'],
      ['config', 'user.email', 'pilot@example.invalid'],
    ]) expect(Bun.spawnSync(['git', '-C', source, ...args]).exitCode).toBe(0);
    writeFileSync(join(source, 'seed'), 'seed\n');
    expect(Bun.spawnSync(['git', '-C', source, 'add', 'seed']).exitCode).toBe(0);
    expect(Bun.spawnSync(['git', '-C', source, 'commit', '-qm', 'seed']).exitCode).toBe(0);
    expect(Bun.spawnSync(['git', '-C', source, 'remote', 'add', 'origin', 'https://example.invalid/private.git']).exitCode).toBe(0);

    const result = Bun.spawnSync({
      cmd: ['bash', SCRIPT, '--cohort', inputs.cohort, '--work-root', workRoot,
        '--scorecard-input', inputs.scorecard, '--evaluation-input', inputs.evaluation,
        '--gbrain-bin', fakeGbrain(root), '--synthetic'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('refusing collector replay repository with a Git remote');
  });

  test('any missed threshold blocks cleanup and backlog release', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-pilot-score-'));
    roots.push(root);
    const inputs = passingInputs(root);
    const scorecard = JSON.parse(readFileSync(inputs.scorecard, 'utf8'));
    scorecard.useful_atoms = { count: 7, total: 10 };
    privateJson(inputs.scorecard, scorecard);
    const output = join(root, 'decision.json');
    const result = Bun.spawnSync({ cmd: ['bun', HELPER, 'score', inputs.scorecard, inputs.evaluation, output], stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(3);
    const decision = JSON.parse(readFileSync(output, 'utf8'));
    expect(decision.decision).toBe('block_cleanup_and_backlog');
    expect(decision.cleanup_authorized).toBe(false);
    expect(decision.backlog_release_authorized).toBe(false);
  });
});
