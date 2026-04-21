import type {
  CopilotClient as CopilotClientInstance,
  CopilotClientOptions,
  PermissionHandler,
} from '@github/copilot-sdk';
import { getCopilotRuntimeConfig, type CopilotRuntimeConfig } from './copilot-config.ts';

type CopilotSdkModule = {
  CopilotClient: new (options?: CopilotClientOptions) => CopilotClientInstance;
  approveAll: PermissionHandler;
};

let cachedClient: Promise<CopilotClientInstance> | null = null;
let cachedClientKey: string | null = null;
let loadCopilotSdkModule: () => Promise<CopilotSdkModule> = async () => await import('@github/copilot-sdk');

function getCacheKey(config: CopilotRuntimeConfig): string {
  return `${config.githubToken || ''}::${config.useLoggedInUser ? '1' : '0'}`;
}

function createClientOptions(config: CopilotRuntimeConfig): CopilotClientOptions {
  return {
    githubToken: config.githubToken,
    useLoggedInUser: config.useLoggedInUser,
  };
}

export async function getCopilotSdk(): Promise<CopilotSdkModule> {
  return await loadCopilotSdkModule();
}

export async function getCopilotClient(config?: CopilotRuntimeConfig): Promise<CopilotClientInstance> {
  const resolved = config || getCopilotRuntimeConfig();
  if (!resolved) {
    throw new Error(
      'GitHub Copilot auth is not configured. Set GBRAIN_GITHUB_TOKEN or opt into GBRAIN_COPILOT_USE_LOGGED_IN_USER=1.',
    );
  }

  const key = getCacheKey(resolved);
  if (cachedClient && cachedClientKey === key) {
    return await cachedClient;
  }

  const previousClient = cachedClient;
  const sdk = await getCopilotSdk();
  cachedClientKey = key;
  cachedClient = (async () => {
    const client = new sdk.CopilotClient(createClientOptions(resolved));
    await client.start();
    return client;
  })();

  if (previousClient) {
    void previousClient.then(client => client.stop()).catch(() => {});
  }

  return await cachedClient;
}

export async function resetCopilotClientForTests(): Promise<void> {
  if (cachedClient) {
    try {
      const client = await cachedClient;
      await client.stop();
    } catch {
      // Best-effort test cleanup.
    }
  }
  cachedClient = null;
  cachedClientKey = null;
}

export function setCopilotSdkLoaderForTests(loader: () => Promise<CopilotSdkModule>): void {
  loadCopilotSdkModule = loader;
}

export function restoreCopilotSdkLoaderForTests(): void {
  loadCopilotSdkModule = async () => await import('@github/copilot-sdk');
}
