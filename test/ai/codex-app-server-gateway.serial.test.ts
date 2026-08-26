import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  toolLoop,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';
import {
  setCodexAppServerSpawnForTests,
  type CodexAppServerChild,
} from '../../src/core/ai/providers/codex-app-server-language-model.ts';

function fixtureChild(): CodexAppServerChild {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const send = (message: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));

  return {
    stdout,
    stderr: new ReadableStream<Uint8Array>(),
    stdin: {
      write(chunk) {
        const message = JSON.parse(String(chunk));
        queueMicrotask(() => {
          if (message.method === 'initialize') send({ id: message.id, result: {} });
          if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
          if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
          if (message.method === 'turn/start') {
            const prompt = message.params.input[0].text as string;
            const hasResult = prompt.includes('Found one iOS page');
            const text = JSON.stringify(hasResult
              ? { text: 'The brain contains one relevant iOS page.', tool_call: null }
              : { text: '', tool_call: { id: 'call-1', name: 'brain_search', input_json: '{"query":"iOS"}' } });
            send({ id: message.id, result: { turn: { id: 'turn-1' } } });
            send({ method: 'item/completed', params: {
              threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text },
            } });
            send({ method: 'turn/completed', params: {
              threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
            } });
          }
        });
        return String(chunk).length;
      },
      flush() {},
      end() {},
    },
    exited: new Promise(() => {}),
    kill() { controller.close(); },
  };
}

beforeAll(() => {
  setCodexAppServerSpawnForTests(() => fixtureChild());
  configureGateway({ chat_model: 'codex-app-server:gpt-5.6-sol', env: {} });
});

afterAll(() => {
  resetGateway();
  setCodexAppServerSpawnForTests();
});

describe('Codex app-server through the canonical GBrain gateway loop', () => {
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
      model: 'codex-app-server:gpt-5.6-sol',
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
  });
});
