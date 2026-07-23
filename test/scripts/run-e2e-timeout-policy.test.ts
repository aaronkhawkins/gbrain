import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;
const runner = join(repoRoot, 'scripts', 'run-e2e.sh');

function timeoutFor(file: string): string {
  return execFileSync('bash', [runner, '--dry-run-timeout', file], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function pgbouncerEnvStatus(env: Record<string, string>): string {
  return execFileSync('bash', [runner, '--dry-run-pgbouncer-env'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  }).trim();
}

describe('run-e2e outer timeout policy', () => {
  test('only the two measured long-running suites receive 240 seconds', () => {
    expect(timeoutFor('test/e2e/mechanical.test.ts')).toBe('240');
    expect(timeoutFor('test/e2e/skills.test.ts')).toBe('240');
  });

  test('ordinary E2E files retain the 180-second hang guard', () => {
    expect(timeoutFor('test/e2e/dream.test.ts')).toBe('180');
    expect(timeoutFor('arbitrary-new-suite.test.ts')).toBe('180');
  });
});

describe('run-e2e hermetic environment policy', () => {
  test('preserves runner-owned PgBouncer endpoints through the scrub', () => {
    expect(pgbouncerEnvStatus({
      GBRAIN_PGBOUNCER_URL: 'postgresql://pooled.example/gbrain_pgbouncer',
      GBRAIN_PGBOUNCER_DIRECT_URL: 'postgresql://direct.example/gbrain_test',
    })).toBe('pooled=set direct=set');
  });
});
