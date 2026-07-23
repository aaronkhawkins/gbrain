import { afterEach, describe, expect, test } from 'bun:test';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import {
  OpenCodeServerLanguageModel,
  renderOpenCodePrompt,
} from '../src/core/ai/providers/opencode-server-language-model.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function options(tools: LanguageModelV2CallOptions['tools'] = []): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'You are a careful knowledge worker.' },
      { role: 'user', content: [{ type: 'text', text: 'Process this bookmark.' }] },
    ],
    tools,
  } as LanguageModelV2CallOptions;
}

function fakeServer(result: unknown, opts: { status?: number; password?: string } = {}) {
  const requests: Array<{ method: string; path: string; body: any; authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json() : null;
      requests.push({
        method: request.method,
        path: url.pathname,
        body,
        authorization: request.headers.get('authorization'),
      });
      if (opts.status) return new Response('failure', { status: opts.status });
      if (request.method === 'POST' && url.pathname === '/session') {
        return Response.json({ id: 'ses_test' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_test/message') {
        return Response.json({
          info: { structured: result, tokens: { input: 120, output: 30, total: 150 } },
          parts: [],
        });
      }
      if (request.method === 'DELETE' && url.pathname === '/session/ses_test') {
        return Response.json(true);
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}

describe('opencode-server recipe', () => {
  test('is registered as a tool-capable native chat provider', () => {
    const recipe = getRecipe('opencode-server');
    expect(recipe?.implementation).toBe('opencode-server');
    expect(recipe?.touchpoints.chat?.supports_tools).toBe(true);
    expect(recipe?.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(recipe?.touchpoints.chat?.models).toContain('gpt-5.6-sol');
    expect(recipe?.touchpoints.expansion?.models).toContain('gpt-5.4-mini');
  });
});

describe('OpenCodeServerLanguageModel', () => {
  test('preserves provider-native colons inside model ids', () => {
    const model = new OpenCodeServerLanguageModel('qwen3.6:35b', { providerId: 'ollama', password: 'test-secret' });
    expect(model.modelId).toBe('qwen3.6:35b');
  });

  test('rejects non-loopback, wildcard, and unauthenticated endpoints without echoing secrets', () => {
    for (const baseUrl of ['http://example.test:4097', 'http://0.0.0.0:4097', 'http://[::]:4097']) {
      expect(() => new OpenCodeServerLanguageModel('gpt-5.5', {
        baseUrl,
        password: 'oauth-private-value',
      })).toThrow('loopback');
    }
    expect(() => new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: 'http://127.0.0.1:4097',
    })).toThrow('authentication');
  });

  test('bounds response size and redacts HTTP/provider response bodies', async () => {
    const oversized = new OpenCodeServerLanguageModel('gpt-5.5', {
      password: 'oauth-private-value',
      fetch: (async () => new Response('{}', {
        headers: { 'content-length': '3000000' },
      })) as unknown as typeof globalThis.fetch,
    });
    await expect(oversized.doGenerate(options())).rejects.toThrow('size limit');

    const secretBody = 'oauth-private-value provider-private-output';
    const failed = new OpenCodeServerLanguageModel('gpt-5.5', {
      password: 'oauth-private-value',
      fetch: (async () => new Response(secretBody, { status: 503 })) as unknown as typeof globalThis.fetch,
    });
    try {
      await failed.doGenerate(options());
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toContain('HTTP 503');
      expect((error as Error).message).not.toContain('oauth-private-value');
      expect((error as Error).message).not.toContain('provider-private-output');
    }
  });

  test('bounds requests with an abort signal and returns a redacted error', async () => {
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      password: 'oauth-private-value',
      fetch: ((_: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) return reject(new Error('oauth-private-value'));
          init?.signal?.addEventListener('abort', () => reject(new Error('oauth-private-value')));
        });
      }) as unknown as typeof globalThis.fetch,
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await model.doGenerate({ ...options(), abortSignal: controller.signal });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toContain('aborted');
      expect((error as Error).message).not.toContain('oauth-private-value');
    }
  });

  test('returns final text, usage, deny-all permissions, and deletes the session', async () => {
    const fake = fakeServer({ text: 'Done.', tool_calls: [] });
    const model = new OpenCodeServerLanguageModel('opencode-server:gpt-5.5', {
      baseUrl: fake.baseUrl,
      password: 'test-secret',
      directory: '/tmp/gbrain-opencode-test',
    });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(fake.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      'POST /session',
      'POST /session/ses_test/message',
      'DELETE /session/ses_test',
    ]);
    expect(fake.requests[1].body.format).toEqual({ type: 'text' });
    expect(fake.requests[0].body.permission).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
    ]);
    expect(fake.requests[1].body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' });
    expect(fake.requests[1].body.agent).toBe('gbrain');
  });

  test('normalizes the observed OpenCode step envelope and preserves its finish reason', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_live_shape' });
        if (request.method === 'POST' && path === '/session/ses_live_shape/message') {
          return Response.json({
            info: {
              finish: 'stop',
              tokens: { input: 170, output: 5, total: 175 },
            },
            parts: [
              { type: 'step-start', id: 'step_1' },
              { type: 'text', id: 'part_1', text: 'READY' },
              { type: 'step-finish', id: 'step_2', reason: 'stop' },
            ],
          });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 170, outputTokens: 5, totalTokens: 175 });
  });

  test('preserves output-budget exhaustion so the gateway can classify empty output', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_length' });
        if (request.method === 'POST' && path === '/session/ses_length/message') {
          return Response.json({
            info: {
              finish: 'length',
              tokens: { input: 170, output: 128, total: 298 },
            },
            parts: [{ type: 'step-finish', reason: 'length' }],
          });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: '' }]);
    expect(result.finishReason).toBe('length');
    expect(result.usage.outputTokens).toBe(128);
  });

  test('normalizes an omitted tool_calls field only when no tools were offered', async () => {
    const fake = fakeServer({ text: 'Done.' });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(result.finishReason).toBe('stop');
  });

  test('uses the caller JSON schema for AI SDK structured generation', async () => {
    const fake = fakeServer({ queries: ['Swift development', 'iOS architecture'] });
    const model = new OpenCodeServerLanguageModel('gpt-5.4-mini', { baseUrl: fake.baseUrl, password: 'test-secret' });
    const schema = {
      type: 'object',
      properties: { queries: { type: 'array', items: { type: 'string' } } },
      required: ['queries'],
      additionalProperties: false,
    } as const;

    const result = await model.doGenerate({
      ...options(),
      responseFormat: { type: 'json', schema },
    });

    expect(result.content).toEqual([{
      type: 'text',
      text: '{"queries":["Swift development","iOS architecture"]}',
    }]);
    expect(result.finishReason).toBe('stop');
    expect(fake.requests[1].body.format.schema).toEqual(schema);
    expect(fake.requests[1].body.system).toContain('matches the requested schema');
    expect(fake.requests[1].body.system).not.toContain('tool_calls');
  });

  test('preserves top-level arrays in plain-text JSON fallback', async () => {
    let messageCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_test' });
        if (request.method === 'POST' && path === '/session/ses_test/message') {
          messageCalls++;
          if (messageCalls === 1) {
            return Response.json({ info: { error: { name: 'StructuredOutputError' } }, parts: [] });
          }
          return Response.json({ info: {}, parts: [{ type: 'text', text: '```json\n[{"name":"iOS"}]\n```' }] });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.4-mini', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate({
      ...options(),
      responseFormat: { type: 'json', schema: { type: 'array', items: { type: 'object' } } },
    });

    expect(result.content).toEqual([{ type: 'text', text: '[{"name":"iOS"}]' }]);
    expect(messageCalls).toBe(2);
  });

  test('recovers OpenAI OAuth output_text when OpenCode flags structured output', async () => {
    let messageCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_test' });
        if (request.method === 'POST' && path === '/session/ses_test/message') {
          messageCalls++;
          return Response.json({
            info: {
              error: { name: 'StructuredOutputError' },
              tokens: { input: 176, output: 29, total: 205 },
            },
            parts: [{ type: 'text', text: '{"output_text":"READY"}' }],
          });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
    expect(result.usage).toEqual({ inputTokens: 176, outputTokens: 29, totalTokens: 205 });
    expect(messageCalls).toBe(1);
  });

  test('retries top-level OpenCode structured errors as plain text', async () => {
    let messageCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/session') return Response.json({ id: 'ses_top_error' });
        if (request.method === 'POST' && url.pathname.includes('/message')) {
          messageCalls++;
          if (messageCalls === 1) {
            return Response.json({ name: 'UnknownError', data: { message: 'structured format failed', ref: 'err_1' } });
          }
          return Response.json({ info: { tokens: { input: 2, output: 3 } }, parts: [{ type: 'text', text: '[{"title":"Recovered"}]' }] });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const model = new OpenCodeServerLanguageModel('gpt-5.5', {
        baseUrl: `http://127.0.0.1:${server.port}`,
        password: 'test-secret',
      });
      const result = await model.doGenerate(options());
      expect(result.content).toEqual([{ type: 'text', text: '[{"title":"Recovered"}]' }]);
      expect(messageCalls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('converts structured requests into native AI SDK tool calls', async () => {
    const fake = fakeServer({
      text: '',
      tool_calls: [{ id: 'toolu_1', name: 'brain_search', input: { query: 'iOS' } }],
    });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    const result = await model.doGenerate(options([{
      type: 'function',
      name: 'brain_search',
      description: 'Search the brain',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    }]));

    expect(result.finishReason).toBe('tool-calls');
    expect(result.content).toEqual([{
      type: 'tool-call',
      toolCallId: 'toolu_1',
      toolName: 'brain_search',
      input: '{"query":"iOS"}',
    }]);
    expect(fake.requests[1].body.format.schema.properties.tool_calls.items.properties.name.enum)
      .toEqual(['brain_search']);
    expect(fake.requests[1].body.system).toContain('do not request that tool again');
  });

  test('accepts OpenAI OAuth tool arguments as an input alias', async () => {
    const fake = fakeServer({
      text: '',
      tool_calls: [{ name: 'brain_search', arguments: { query: 'iOS' } }],
    });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    const result = await model.doGenerate(options([{
      type: 'function',
      name: 'brain_search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }]));

    expect(result.content).toEqual([{
      type: 'tool-call',
      toolCallId: 'toolu_opencode_0',
      toolName: 'brain_search',
      input: '{"query":"iOS"}',
    }]);
  });

  test('falls back to strict text JSON on tool-capable turns', async () => {
    let messageCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_test' });
        if (request.method === 'POST' && path === '/session/ses_test/message') {
          messageCalls++;
          if (messageCalls === 1) {
            return Response.json({
              info: {
                error: { name: 'StructuredOutputError' },
                tokens: { input: 10, output: 2, total: 12 },
              },
              parts: [{ type: 'text', text: 'not json' }],
            });
          }
          const body = await request.json() as any;
          expect(body.format).toEqual({ type: 'text' });
          expect(body.parts[0].text).toContain('Return only the required JSON object');
          return Response.json({
            info: { tokens: { input: 20, output: 4, total: 24 } },
            parts: [{ type: 'text', text: '```json\n{"text":"READY","tool_calls":[]}\n```' }],
          });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate(options([{
      type: 'function',
      name: 'brain_search',
      inputSchema: { type: 'object', properties: {} },
    }]));

    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 6, totalTokens: 36 });
    expect(messageCalls).toBe(2);
  });

  test('accepts fallback plain text only when no GBrain tools were offered', async () => {
    let messageCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/session') return Response.json({ id: 'ses_test' });
        if (request.method === 'POST' && path === '/session/ses_test/message') {
          messageCalls++;
          if (messageCalls === 1) {
            return Response.json({ info: { error: { name: 'StructuredOutputError' } }, parts: [] });
          }
          return Response.json({ info: {}, parts: [{ type: 'text', text: 'READY' }] });
        }
        if (request.method === 'DELETE') return Response.json(true);
        return new Response('not found', { status: 404 });
      },
    });
    servers.push(server);
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: 'test-secret',
    });

    const result = await model.doGenerate(options());

    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
    expect(result.finishReason).toBe('stop');
  });

  test('rejects a structured call for an unregistered tool', async () => {
    const fake = fakeServer({
      text: '',
      tool_calls: [{ id: 'toolu_1', name: 'bash', input: { command: 'whoami' } }],
    });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    await expect(model.doGenerate(options([{
      type: 'function',
      name: 'brain_search',
      inputSchema: { type: 'object', properties: {} },
    }]))).rejects.toThrow('unknown GBrain tool "bash"');
    expect(fake.requests.at(-1)?.method).toBe('DELETE');
  });

  test('sends required HTTP Basic credentials without exposing them in payloads', async () => {
    const fake = fakeServer({ text: 'ok', tool_calls: [] });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', {
      baseUrl: fake.baseUrl,
      username: 'gbrain',
      password: 'test-password',
    });

    await model.doGenerate(options());

    expect(fake.requests[0].authorization).toBe(
      `Basic ${Buffer.from('gbrain:test-password').toString('base64')}`,
    );
    expect(JSON.stringify(fake.requests.map(request => request.body))).not.toContain('test-password');
  });

  test('classifies authentication errors as configuration failures', async () => {
    const fake = fakeServer({}, { status: 401 });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    try {
      await model.doGenerate(options());
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AIConfigError);
      expect((error as Error).message).toContain('HTTP 401');
    }
  });

  test('classifies server errors as retryable failures', async () => {
    const fake = fakeServer({}, { status: 503 });
    const model = new OpenCodeServerLanguageModel('gpt-5.5', { baseUrl: fake.baseUrl, password: 'test-secret' });

    try {
      await model.doGenerate(options());
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AITransientError);
      expect((error as Error).message).toContain('HTTP 503');
    }
  });

  test('renders prior GBrain tool results into replay context', () => {
    const rendered = renderOpenCodePrompt([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: [{
        type: 'tool-call',
        toolCallId: 'toolu_1',
        toolName: 'brain_search',
        input: '{"query":"iOS"}',
      }] },
      { role: 'tool', content: [{
        type: 'tool-result',
        toolCallId: 'toolu_1',
        toolName: 'brain_search',
        output: { type: 'text', value: 'Found 3 pages' },
      }] },
    ] as any);

    expect(rendered.systemText).toBe('system');
    expect(rendered.conversationText).toContain('brain_search');
    expect(rendered.conversationText).toContain('Found 3 pages');
  });
});
