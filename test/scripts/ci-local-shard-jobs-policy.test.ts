import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;
const runner = join(repoRoot, 'scripts', 'ci-local.sh');

function resolvedShardJobs(value?: string): string {
  return execFileSync('bash', [runner, '--dry-run-shard-jobs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GBRAIN_CI_SHARD_JOBS: value,
    },
  }).trim();
}

describe('ci-local shard worker policy', () => {
  test('defaults to one concurrent shard job for an 8 GiB Docker runtime', () => {
    expect(resolvedShardJobs()).toBe('1');
  });

  test('accepts an explicit sequential acceptance run', () => {
    expect(resolvedShardJobs('1')).toBe('1');
  });

  test('accepts explicit values through the four available cohorts', () => {
    expect(resolvedShardJobs('3')).toBe('3');
    expect(resolvedShardJobs('4')).toBe('4');
  });

  test.each(['0', '5', '1.5', 'many'])('rejects invalid shard jobs value %s', (value) => {
    const result = spawnSync('bash', [runner, '--dry-run-shard-jobs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GBRAIN_CI_SHARD_JOBS: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('GBRAIN_CI_SHARD_JOBS must be an integer from 1 through 4');
  });
});
