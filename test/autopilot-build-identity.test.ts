import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTOPILOT_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot managed-fork build receipt wiring', () => {
  test('persists the scheduler receipt before entering runtime mode selection', () => {
    expect(AUTOPILOT_SOURCE).toContain(
      "import { getProcessBuildReceipt, persistProcessBuildReceipt } from '../core/build-identity.ts';",
    );

    const receipt = AUTOPILOT_SOURCE.indexOf(
      "const schedulerReceipt = getProcessBuildReceipt('scheduler');",
    );
    const persist = AUTOPILOT_SOURCE.indexOf(
      'persistProcessBuildReceipt(schedulerReceipt);',
      receipt,
    );
    const modeSelection = AUTOPILOT_SOURCE.indexOf('// Mode resolution:', persist);

    expect(receipt).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(receipt);
    expect(modeSelection).toBeGreaterThan(persist);
  });

  test('emits the same content-free receipt used for private verification', () => {
    expect(AUTOPILOT_SOURCE).toMatch(
      /event:\s*'process_build_receipt',\s*receipt:\s*schedulerReceipt/,
    );
  });
});
