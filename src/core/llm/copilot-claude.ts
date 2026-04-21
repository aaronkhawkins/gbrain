import type { Tool } from '@github/copilot-sdk';
import { getCopilotRuntimeConfig } from './copilot-config.ts';
import { getCopilotClient, getCopilotSdk } from './copilot.ts';
import { resolveCopilotClaudeModel } from './model-map.ts';

export interface ClaudeUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface ClaudeTextRequest {
  anthropicModel: string;
  prompt: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface ClaudeTextResponse {
  content: string;
  usage: ClaudeUsage | null;
  model: string;
}

export interface ClaudeToolRequest<TArgs extends object> {
  anthropicModel: string;
  prompt: string;
  systemPrompt?: string;
  toolName: string;
  toolDescription: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  requireToolCall?: boolean;
}

interface ClaudeSessionRequest {
  anthropicModel: string;
  prompt: string;
  systemPrompt?: string;
  timeoutMs?: number;
  tools?: Tool[];
}

async function runClaudeSession(request: ClaudeSessionRequest): Promise<ClaudeTextResponse> {
  const runtimeConfig = getCopilotRuntimeConfig();
  if (!runtimeConfig) {
    throw new Error(
      'GitHub Copilot auth is not configured. Set GBRAIN_GITHUB_TOKEN or opt into GBRAIN_COPILOT_USE_LOGGED_IN_USER=1.',
    );
  }

  const copilotModel = resolveCopilotClaudeModel(request.anthropicModel);
  const sdk = await getCopilotSdk();
  const client = await getCopilotClient(runtimeConfig);

  let usage: ClaudeUsage | null = null;
  await using session = await client.createSession({
    model: copilotModel,
    onPermissionRequest: sdk.approveAll,
    systemMessage: request.systemPrompt ? { content: request.systemPrompt } : undefined,
    tools: request.tools,
    availableTools: request.tools ? request.tools.map(tool => tool.name) : [],
    infiniteSessions: { enabled: false },
    streaming: false,
    workingDirectory: process.cwd(),
  });

  session.on('assistant.usage', (event) => {
    usage = {
      model: event.data.model,
      inputTokens: event.data.inputTokens,
      outputTokens: event.data.outputTokens,
      cost: event.data.cost,
    };
  });

  const response = await session.sendAndWait(
    { prompt: request.prompt, mode: 'immediate' },
    request.timeoutMs || runtimeConfig.timeoutMs,
  );

  return {
    content: response?.data.content?.trim() || '',
    usage,
    model: copilotModel,
  };
}

export async function completeClaudeText(request: ClaudeTextRequest): Promise<ClaudeTextResponse> {
  return await runClaudeSession(request);
}

export async function completeClaudeTool<TArgs extends object>(
  request: ClaudeToolRequest<TArgs>,
): Promise<{ result: TArgs | null; usage: ClaudeUsage | null; model: string; content: string }> {
  let captured: TArgs | null = null;
  const response = await runClaudeSession({
    anthropicModel: request.anthropicModel,
    prompt: request.prompt,
    systemPrompt: request.systemPrompt,
    timeoutMs: request.timeoutMs,
    tools: [
      {
        name: request.toolName,
        description: request.toolDescription,
        parameters: request.parameters,
        skipPermission: true,
        handler: async (args: TArgs) => {
          captured = args;
          return { ok: true };
        },
      },
    ],
  });

  const requireToolCall = request.requireToolCall !== false;
  if (requireToolCall && captured === null) {
    const detail = response.content
      ? ` Received plain-text response instead: ${JSON.stringify(response.content.slice(0, 200))}`
      : '';
    throw new Error(
      `Copilot Claude model ${response.model} did not invoke required tool ${request.toolName}.${detail}`,
    );
  }

  return {
    result: captured,
    usage: response.usage,
    model: response.model,
    content: response.content,
  };
}
