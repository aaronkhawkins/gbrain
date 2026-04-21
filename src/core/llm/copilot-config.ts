import { loadConfig, type GBrainConfig } from '../config.ts';

export interface CopilotRuntimeConfig {
  githubToken?: string;
  useLoggedInUser: boolean;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(raw: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveFileConfig(): Partial<GBrainConfig> {
  return loadConfig() || {};
}

export function getCopilotRuntimeConfig(config?: Partial<GBrainConfig>): CopilotRuntimeConfig | null {
  const fileConfig = config || resolveFileConfig();
  const githubToken = process.env.GBRAIN_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || fileConfig.github_token;
  const useLoggedInUser = parseBoolean(
    process.env.GBRAIN_COPILOT_USE_LOGGED_IN_USER ?? fileConfig.copilot_use_logged_in_user,
    false,
  );
  const timeoutMs = parsePositiveInt(process.env.GBRAIN_COPILOT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  if (githubToken) {
    return {
      githubToken,
      useLoggedInUser: false,
      timeoutMs,
    };
  }

  if (useLoggedInUser) {
    return {
      useLoggedInUser: true,
      timeoutMs,
    };
  }

  return null;
}

export function hasCopilotClaudeConfig(config?: Partial<GBrainConfig>): boolean {
  return getCopilotRuntimeConfig(config) !== null;
}
