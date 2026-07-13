import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  toolLoop,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';

let server: ReturnType<typeof Bun.serve>;
let promptCount = 0;
let deletedSessions = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/session') {
        return Response.json({ id: `ses_${promptCount}` });
      }
      if (request.method === 'POST' && /\/session\/ses_\d+\/message/.test(url.pathname)) {
        const body = await request.json() as any;
        promptCount++;
        const replayedToolResult = body.parts?.[0]?.text?.includes('Found one iOS page');
        return Response.json({
          info: {
            structured: replayedToolResult
              ? { text: 'The brain contains one relevant iOS page.', tool_calls: [] }
              : {
                  text: '',
                  tool_calls: [{ id: 'toolu_search', name: 'brain_search', input: { query: 'iOS' } }],
                },
            tokens: { input: replayedToolResult ? 20 : 10, output: replayedToolResult ? 5 : 3, total: replayedToolResult ? 25 : 13 },
          },
          parts: [],
        });
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/session/')) {
        deletedSessions++;
        return Response.json(true);
      }
      return new Response('not found', { status: 404 });
    },
  });
  configureGateway({
    chat_model: 'opencode-server:gpt-5.5',
    env: {
      GBRAIN_OPENCODE_SERVER_URL: `http://127.0.0.1:${server.port}`,
      GBRAIN_OPENCODE_SERVER_PASSWORD: 'test-secret',
    },
  });
});

afterAll(() => {
  resetGateway();
  server.stop(true);
});

describe('OpenCode server through the real GBrain gateway loop', () => {
  test('executes a GBrain-owned tool and replays its result to a final response', async () => {
    let handledInput: unknown;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        handledInput = input;
        return { summary: 'Found one iOS page' };
      },
    };

    const result = await toolLoop({
      model: 'opencode-server:gpt-5.5',
      initialMessages: [{ role: 'user', content: 'What do I know about iOS?' }],
      tools: [{
        name: 'brain_search',
        description: 'Search GBrain',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      toolHandlers: new Map([['brain_search', handler]]),
    });

    expect(handledInput).toEqual({ query: 'iOS' });
    expect(result.finalText).toBe('The brain contains one relevant iOS page.');
    expect(result.stopReason).toBe('end');
    expect(result.totalTurns).toBe(1);
    expect(result.totalUsage.input_tokens).toBe(30);
    expect(result.totalUsage.output_tokens).toBe(8);
    expect(promptCount).toBe(2);
    expect(deletedSessions).toBe(2);
  });
});

test('uses assistant text parts when a tool-free structured wrapper is empty', async () => {
  let deleted = false;
  const fallbackServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/session') return Response.json({ id: 'ses_fallback' });
      if (request.method === 'POST' && url.pathname.includes('/message')) {
        return Response.json({
          info: { structured: { text: '', tool_calls: [] }, tokens: { input: 5, output: 4 } },
          parts: [{ type: 'text', text: '[{"title":"Native atom"}]' }],
        });
      }
      if (request.method === 'DELETE') {
        deleted = true;
        return Response.json(true);
      }
      return new Response('not found', { status: 404 });
    },
  });
  configureGateway({
    chat_model: 'opencode-server:gpt-5.5',
    env: {
      GBRAIN_OPENCODE_SERVER_URL: `http://127.0.0.1:${fallbackServer.port}`,
      GBRAIN_OPENCODE_SERVER_PASSWORD: 'test-secret',
    },
  });
  try {
    const { chat } = await import('../../src/core/ai/gateway.ts');
    const result = await chat({ messages: [{ role: 'user', content: 'Return JSON' }] });
    expect(result.text).toBe('[{"title":"Native atom"}]');
    expect(deleted).toBe(true);
  } finally {
    fallbackServer.stop(true);
    configureGateway({
      chat_model: 'opencode-server:gpt-5.5',
      env: {
        GBRAIN_OPENCODE_SERVER_URL: `http://127.0.0.1:${server.port}`,
        GBRAIN_OPENCODE_SERVER_PASSWORD: 'test-secret',
      },
    });
  }
});
