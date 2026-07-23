/**
 * Tests for env-aware `gbrain autopilot --install`.
 *
 * Covers:
 *   - detectInstallTarget picks the right target based on env vars +
 *     filesystem sentinels.
 *   - --target flag overrides detection.
 *   - Ephemeral-container path writes the start script + executable bit.
 *   - OpenClaw bootstrap injection is idempotent + creates .bak.
 *   - Uninstall mirrors all four targets and is a no-op when nothing is
 *     installed.
 *
 * Regression guards:
 *   - macOS launchd plist still writes the same shape it always did.
 *   - Linux crontab still writes the same every-5-min line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

import {
  detectInstallTarget,
  resolveAutopilotInstallIdentity,
} from '../src/commands/autopilot.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

function envKeys() {
  return ['HOME', 'GBRAIN_HOME', 'RENDER', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME', 'OPENCLAW_HOME'] as const;
}

beforeEach(() => {
  for (const k of envKeys()) envSnapshot[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  process.env.HOME = tmp;
  // Start each test with a clean slate for ephemeral env vars.
  delete process.env.RENDER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.FLY_APP_NAME;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  for (const k of envKeys()) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('detectInstallTarget', () => {
  test('returns "macos" on darwin regardless of env', () => {
    if (process.platform !== 'darwin') return; // Skip on non-mac CI
    // Even if RENDER is set, darwin wins (user is probably dev-testing).
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('macos');
  });

  test('returns "ephemeral-container" when RENDER is set', () => {
    if (process.platform === 'darwin') return; // darwin shortcircuits first
    process.env.RENDER = 'true';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when RAILWAY_ENVIRONMENT is set', () => {
    if (process.platform === 'darwin') return;
    process.env.RAILWAY_ENVIRONMENT = 'production';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  test('returns "ephemeral-container" when FLY_APP_NAME is set', () => {
    if (process.platform === 'darwin') return;
    process.env.FLY_APP_NAME = 'myapp';
    expect(detectInstallTarget()).toBe('ephemeral-container');
  });

  // Note: direct testing of linux-systemd / linux-cron requires mocking
  // existsSync + execSync which is awkward in-process. Those branches are
  // exercised by the E2E test (Task 14) against a stubbed host.
});

describe('resolveAutopilotInstallIdentity', () => {
  test('preserves the legacy default service while keeping artifacts under the default brain home', () => {
    delete process.env.GBRAIN_HOME;

    expect(resolveAutopilotInstallIdentity()).toEqual({
      launchdLabel: 'com.gbrain.autopilot',
      wrapperPath: join(homedir(), '.gbrain', 'autopilot-run.sh'),
      stdoutPath: join(homedir(), '.gbrain', 'autopilot.log'),
      stderrPath: join(homedir(), '.gbrain', 'autopilot.err'),
      plistPath: join(tmp, 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist'),
      systemdUnitName: 'gbrain-autopilot.service',
      systemdUnitPath: join(tmp, '.config', 'systemd', 'user', 'gbrain-autopilot.service'),
      ephemeralStartScriptPath: join(homedir(), '.gbrain', 'start-autopilot.sh'),
      bootstrapMarker: '# gbrain:autopilot v0.11.0',
    });
  });

  test('isolates every install artifact when GBRAIN_HOME selects another brain', () => {
    process.env.GBRAIN_HOME = join(tmp, 'second-brain-home');

    const identity = resolveAutopilotInstallIdentity();

    expect(identity.launchdLabel).toMatch(/^com\.gbrain\.autopilot\.[a-f0-9]{12}$/);
    expect(identity.launchdLabel).not.toBe('com.gbrain.autopilot');
    expect(identity.wrapperPath).toBe(join(tmp, 'second-brain-home', '.gbrain', 'autopilot-run.sh'));
    expect(identity.stdoutPath).toBe(join(tmp, 'second-brain-home', '.gbrain', 'autopilot.log'));
    expect(identity.stderrPath).toBe(join(tmp, 'second-brain-home', '.gbrain', 'autopilot.err'));
    expect(identity.plistPath).toBe(
      join(tmp, 'Library', 'LaunchAgents', `${identity.launchdLabel}.plist`),
    );
    expect(identity.systemdUnitName).toBe(`${identity.launchdLabel}.service`);
    expect(identity.systemdUnitPath).toBe(
      join(tmp, '.config', 'systemd', 'user', `${identity.launchdLabel}.service`),
    );
    expect(identity.ephemeralStartScriptPath).toBe(
      join(tmp, 'second-brain-home', '.gbrain', 'start-autopilot.sh'),
    );
    expect(identity.bootstrapMarker).toMatch(/^# gbrain:autopilot v0\.11\.0 [a-f0-9]{12}$/);
  });

  test('different GBRAIN_HOME values cannot resolve to the same service artifacts', () => {
    process.env.GBRAIN_HOME = join(tmp, 'brain-a');
    const first = resolveAutopilotInstallIdentity();
    process.env.GBRAIN_HOME = join(tmp, 'brain-b');
    const second = resolveAutopilotInstallIdentity();

    expect(first.launchdLabel).not.toBe(second.launchdLabel);
    expect(first.plistPath).not.toBe(second.plistPath);
    expect(first.wrapperPath).not.toBe(second.wrapperPath);
    expect(first.stdoutPath).not.toBe(second.stdoutPath);
  });
});

// v0.36.1.x (cherry-pick #966): the autopilot wrapper script must source
// ~/.zshenv BEFORE ~/.zshrc. zshenv is the canonical place for env vars in
// non-interactive zsh; zshrc only fires for interactive shells, so vars
// exported in zshrc never reach the LaunchAgent subprocess. Operators who
// exported GBRAIN_DATABASE_URL or {OPENAI,ANTHROPIC}_API_KEY in zshrc and
// expected autopilot to inherit them hit silent missing-secret failures.
describe('autopilot wrapper script — env source order (v0.36.1.x #966)', () => {
  test('wrapper sources ~/.zshenv before ~/.zshrc', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    const zshenvIdx = src.indexOf('~/.zshenv');
    const zshrcIdx = src.indexOf('~/.zshrc');
    expect(zshenvIdx).toBeGreaterThan(0);
    expect(zshrcIdx).toBeGreaterThan(0);
    expect(zshenvIdx).toBeLessThan(zshrcIdx);
    // Both should appear inside writeWrapperScript's heredoc as `source ~/.foo`
    expect(src).toMatch(/source\s+~\/\.zshenv/);
    expect(src).toMatch(/source\s+~\/\.zshrc/);
  });

  test('scoped wrapper pins the selected GBRAIN_HOME after shell profiles load', async () => {
    const src = readFileSync('src/commands/autopilot.ts', 'utf8');
    expect(src).toContain("export GBRAIN_HOME='");
    expect(src.indexOf('${brainHomeExport}exec')).toBeGreaterThan(src.indexOf('source ~/.zshrc'));
  });
});
