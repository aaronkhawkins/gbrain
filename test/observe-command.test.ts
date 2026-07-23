import { describe, expect, test } from 'bun:test';
import { runObserve } from '../src/commands/observe.ts';

describe('gbrain observe input validation', () => {
  test('rejects invalid refresh and collection timeout values', async () => {
    const errors: string[] = [];
    const refresh = await runObserve(null, ['serve', '--refresh-ms', 'nope'], {
      returnServer: true,
      stderr: (line) => errors.push(line),
    });
    expect(refresh.exitCode).toBe(2);
    expect(errors.join('')).toMatch(/invalid --refresh-ms/);

    errors.length = 0;
    const timeout = await runObserve(null, ['serve', '--collect-timeout-ms', '0'], {
      returnServer: true,
      stderr: (line) => errors.push(line),
    });
    expect(timeout.exitCode).toBe(2);
    expect(errors.join('')).toMatch(/invalid --collect-timeout-ms/);

    errors.length = 0;
    const missing = await runObserve(null, ['serve', '--refresh-ms'], {
      returnServer: true,
      stderr: (line) => errors.push(line),
    });
    expect(missing.exitCode).toBe(2);
    expect(errors.join('')).toMatch(/invalid --refresh-ms/);
  });

  test('snapshot reports pending schema as bounded operational evidence', async () => {
    const output: string[] = [];
    const result = await runObserve({
      kind: 'pglite',
      getConfig: async () => '1',
      executeRaw: async () => [],
    } as never, ['snapshot'], {
      stdout: (line) => output.push(line),
      stderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    const snapshot = JSON.parse(output.join('')) as {
      items: Array<{ kind: string; state: string; reason: string | null }>;
    };
    const dbItems = snapshot.items.filter((item) => item.kind !== 'local_runtime');
    expect(dbItems.length).toBeGreaterThan(0);
    expect(dbItems.every((item) =>
      item.state === 'unknown' && item.reason === 'schema_incompatible',
    )).toBe(true);
  });
});
