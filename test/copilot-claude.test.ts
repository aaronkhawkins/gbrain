import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  completeClaudeText,
  completeClaudeTool,
} from '../src/core/llm/copilot-claude.ts';
import {
  resetCopilotClientForTests,
  restoreCopilotSdkLoaderForTests,
  setCopilotSdkLoaderForTests,
} from '../src/core/llm/copilot.ts';

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
  process.env.GBRAIN_GITHUB_TOKEN = 'gho_test';
});

afterEach(async () => {
  restoreEnv();
  restoreCopilotSdkLoaderForTests();
  await resetCopilotClientForTests();
});

describe('copilot-backed claude helpers', () => {
  test('returns text content and assistant usage', async () => {
    const createdSessions: Array<Record<string, unknown>> = [];

    class FakeCopilotClient {
      async start() {}
      async stop() {}
      async createSession(config: Record<string, unknown>) {
        createdSessions.push(config);
        const handlers = new Map<string, Array<(event: any) => void>>();
        return {
          on(eventType: string, handler: (event: any) => void) {
            const list = handlers.get(eventType) || [];
            list.push(handler);
            handlers.set(eventType, list);
            return () => {};
          },
          async sendAndWait() {
            for (const handler of handlers.get('assistant.usage') || []) {
              handler({
                data: {
                  model: 'claude-haiku-4.5',
                  inputTokens: 12,
                  outputTokens: 4,
                  cost: 0.33,
                },
              });
            }
            return {
              data: {
                content: 'OK',
              },
            };
          },
          async disconnect() {},
          async [Symbol.asyncDispose]() {
            await this.disconnect();
          },
        };
      }
    }

    setCopilotSdkLoaderForTests(async () => ({
      CopilotClient: FakeCopilotClient as any,
      approveAll: (() => ({}) as any),
    }));

    const response = await completeClaudeText({
      anthropicModel: 'claude-haiku-4-5',
      prompt: 'Reply with just OK.',
    });

    expect(response.content).toBe('OK');
    expect(response.usage).toEqual({
      model: 'claude-haiku-4.5',
      inputTokens: 12,
      outputTokens: 4,
      cost: 0.33,
    });
    expect(createdSessions[0]?.model).toBe('claude-haiku-4.5');
    expect(createdSessions[0]?.availableTools).toEqual([]);
  });

  test('captures structured tool args and limits available tools to the requested tool', async () => {
    const createdSessions: Array<Record<string, unknown>> = [];

    class FakeCopilotClient {
      async start() {}
      async stop() {}
      async createSession(config: Record<string, any>) {
        createdSessions.push(config);
        return {
          on() {
            return () => {};
          },
          async sendAndWait() {
            await config.tools[0].handler({
              alternative_queries: ['founders of YC', 'Y Combinator founders'],
            });
            return {
              data: {
                content: '',
              },
            };
          },
          async disconnect() {},
          async [Symbol.asyncDispose]() {
            await this.disconnect();
          },
        };
      }
    }

    setCopilotSdkLoaderForTests(async () => ({
      CopilotClient: FakeCopilotClient as any,
      approveAll: (() => ({}) as any),
    }));

    const response = await completeClaudeTool<{ alternative_queries: string[] }>({
      anthropicModel: 'claude-haiku-4-5-20251001',
      prompt: '<user_query>\nwho founded YC\n</user_query>',
      toolName: 'expand_query',
      toolDescription: 'Generate alternative queries',
      parameters: {
        type: 'object',
        properties: {
          alternative_queries: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    });

    expect(response.result).toEqual({
      alternative_queries: ['founders of YC', 'Y Combinator founders'],
    });
    expect(createdSessions[0]?.model).toBe('claude-haiku-4.5');
    expect(createdSessions[0]?.availableTools).toEqual(['expand_query']);
  });
});
