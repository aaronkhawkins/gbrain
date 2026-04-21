import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getCopilotRuntimeConfig,
  hasCopilotClaudeConfig,
} from '../src/core/llm/copilot-config.ts';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  restoreEnv();
  delete process.env.GBRAIN_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GBRAIN_COPILOT_USE_LOGGED_IN_USER;
  delete process.env.GBRAIN_COPILOT_TIMEOUT_MS;
});

afterEach(() => {
  restoreEnv();
});

describe('copilot auth resolution', () => {
  test('prefers explicit GBRAIN_GITHUB_TOKEN', () => {
    process.env.GBRAIN_GITHUB_TOKEN = 'gho_test';

    expect(getCopilotRuntimeConfig()).toEqual({
      githubToken: 'gho_test',
      useLoggedInUser: false,
      timeoutMs: 120000,
    });
    expect(hasCopilotClaudeConfig()).toBe(true);
  });

  test('falls back to GH_TOKEN when explicit token is absent', () => {
    process.env.GH_TOKEN = 'ghu_test';

    expect(getCopilotRuntimeConfig()).toEqual({
      githubToken: 'ghu_test',
      useLoggedInUser: false,
      timeoutMs: 120000,
    });
  });

  test('supports opt-in logged-in user mode without explicit token', () => {
    process.env.GBRAIN_COPILOT_USE_LOGGED_IN_USER = '1';

    expect(getCopilotRuntimeConfig()).toEqual({
      useLoggedInUser: true,
      timeoutMs: 120000,
    });
  });

  test('explicit token wins over logged-in user convenience mode', () => {
    process.env.GBRAIN_GITHUB_TOKEN = 'github_pat_test';
    process.env.GBRAIN_COPILOT_USE_LOGGED_IN_USER = '1';

    expect(getCopilotRuntimeConfig()).toEqual({
      githubToken: 'github_pat_test',
      useLoggedInUser: false,
      timeoutMs: 120000,
    });
  });

  test('returns null when no copilot auth path is configured', () => {
    expect(getCopilotRuntimeConfig()).toBeNull();
    expect(hasCopilotClaudeConfig()).toBe(false);
  });
});
