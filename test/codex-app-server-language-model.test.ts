import { describe, expect, test } from 'bun:test';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  CodexAppServerLanguageModel,
  codexAppServerCommand,
  type CodexAppServerChild,
} from '../src/core/ai/providers/codex-app-server-language-model.ts';

function options(extra: Partial<LanguageModelV2CallOptions> = {}): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'Answer carefully.' },
      { role: 'user', content: [{ type: 'text', text: 'Say READY.' }] },
    ],
    ...extra,
  } as LanguageModelV2CallOptions;
}

function fakeChild(onRequest: (
  message: any,
  send: (message: unknown) => void,
  controls: { sendRaw(value: string): void; close(): void },
) => void) {
  const requests: any[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const send = (message: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  const controls = {
    sendRaw(value: string) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
  };
  let killed = false;
  const child: CodexAppServerChild = {
    stdout,
    stderr: new ReadableStream<Uint8Array>(),
    stdin: {
      write(chunk) {
        const message = JSON.parse(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        requests.push(message);
        queueMicrotask(() => onRequest(message, send, controls));
        return chunk.length;
      },
      flush() {},
      end() {},
    },
    exited: new Promise(() => {}),
    kill() { killed = true; controller.close(); },
  };
  return { child, requests, wasKilled: () => killed };
}

function successfulProtocol(opts: { text?: string; structured?: unknown; executionItem?: boolean } = {}) {
  return fakeChild((message, send) => {
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'test' } });
    if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      if (opts.executionItem) {
        send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'exec-1', type: 'commandExecution', command: 'pwd' } } });
        return;
      }
      const text = opts.structured === undefined ? (opts.text ?? 'READY') : JSON.stringify(opts.structured);
      if (text) send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text } } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 }, total: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 } } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    }
  });
}

describe('CodexAppServerLanguageModel', () => {
  test('starts app-server with inherited MCP and built-in tools disabled', () => {
    const command = codexAppServerCommand('codex');
    expect(command).toContain('mcp_servers={}');
    expect(command).toContain('web_search="disabled"');
    for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'plugins', 'multi_agent']) {
      expect(command).toContain(feature);
    }
  });

  test('returns final assistant text and usage through the narrow app-server protocol', async () => {
    const fake = successfulProtocol();
    const model = new CodexAppServerLanguageModel('codex-app-server:gpt-5.6-sol', { spawn: () => fake.child });
    const result = await model.doGenerate(options());

    expect(model.modelId).toBe('gpt-5.6-sol');
    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    expect(fake.requests.map(request => request.method).filter(Boolean)).toEqual([
      'initialize', 'initialized', 'account/read', 'thread/start', 'turn/start',
    ]);
    expect(fake.requests.find(request => request.method === 'thread/start').params).toMatchObject({
      model: 'gpt-5.6-sol', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    });
    expect(fake.requests.find(request => request.method === 'turn/start').params.sandboxPolicy).toEqual({
      type: 'readOnly', networkAccess: false,
    });
    expect(fake.wasKilled()).toBe(true);
  });

  test('forwards response schema and canonicalizes structured JSON', async () => {
    const fake = successfulProtocol({ structured: { answer: 42 } });
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
    const result = await model.doGenerate(options({ responseFormat: { type: 'json', schema } }));

    expect(result.content).toEqual([{ type: 'text', text: '{"answer":42}' }]);
    expect(fake.requests.find(request => request.method === 'turn/start').params.outputSchema).toEqual(schema);
  });

  test('fails completed turns that have usage but no final assistant text', async () => {
    const fake = successfulProtocol({ text: '' });
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    await expect(model.doGenerate(options())).rejects.toThrow('no final assistant text');
  });

  test('returns a sanitized login hint when Codex has no account', async () => {
    const fake = fakeChild((message, send) => {
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'account/read') send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    });
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    await expect(model.doGenerate(options())).rejects.toThrow('codex login');
  });

  test('rejects API-key and Bedrock accounts instead of making metered calls', async () => {
    for (const type of ['apiKey', 'amazonBedrock']) {
      const fake = fakeChild((message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        if (message.method === 'account/read') send({ id: message.id, result: { account: { type } } });
      });
      const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
      await expect(model.doGenerate(options())).rejects.toThrow('signed in with ChatGPT');
      expect(fake.requests.some(request => request.method === 'thread/start')).toBe(false);
    }
  });

  test('reports a missing Codex executable without exposing spawn details', async () => {
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', {
      spawn: () => { throw new Error('private PATH and process details'); },
    });
    try {
      await model.doGenerate(options());
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toContain('Unable to start Codex');
      expect((error as Error).message).not.toContain('private PATH');
    }
  });

  test('returns tool calls for GBrain outer-loop execution without app-server execution', async () => {
    const fake = successfulProtocol({ structured: {
      text: '',
      tool_call: { id: 'call-1', name: 'brain_search', input_json: '{"query":"iOS"}' },
    } });
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    const result = await model.doGenerate(options({ tools: [{
      type: 'function',
      name: 'brain_search',
      description: 'Search GBrain',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', default: 10 },
          filters: {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    }] as any }));

    expect(result.content).toEqual([{
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'brain_search',
      input: '{"query":"iOS"}',
    }]);
    expect(result.finishReason).toBe('tool-calls');
    const turn = fake.requests.find(request => request.method === 'turn/start').params;
    expect(turn.outputSchema.properties.tool_call.anyOf[0].properties.name.enum).toEqual(['brain_search']);
    expect(turn.outputSchema.properties.tool_call.anyOf[0].properties.input_json).toEqual({ type: 'string' });
    expect(JSON.stringify(turn.outputSchema)).not.toContain('filters');
    expect(JSON.stringify(turn.outputSchema)).not.toContain('default');
    expect(turn.input[0].text).toContain('Search GBrain');
    expect(turn.input[0].text).toContain('filters');
  });

  test('returns final text from a tool envelope after GBrain supplies tool results', async () => {
    const fake = successfulProtocol({ structured: { text: 'Found one page.', tool_call: null } });
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    const result = await model.doGenerate(options({ tools: [{
      type: 'function', name: 'brain_search', description: 'Search GBrain', inputSchema: {},
    }] as any }));
    expect(result.content).toEqual([{ type: 'text', text: 'Found one page.' }]);
    expect(result.finishReason).toBe('stop');
  });

  test('rejects tool input_json that is malformed or is not an object', async () => {
    for (const input_json of ['not-json', '[]', 'null']) {
      const fake = successfulProtocol({ structured: {
        text: '', tool_call: { id: 'call-1', name: 'brain_search', input_json },
      } });
      const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
      await expect(model.doGenerate(options({ tools: [{
        type: 'function', name: 'brain_search', inputSchema: {},
      }] as any }))).rejects.toThrow('invalid GBrain tool input');
    }
  });

  test('rejects unknown tool calls, provider-defined tools, and Codex execution items', async () => {
    const unknown = successfulProtocol({ structured: {
      text: '', tool_call: { id: 'call-1', name: 'shell', input_json: '{}' },
    } });
    const unknownModel = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => unknown.child });
    await expect(unknownModel.doGenerate(options({ tools: [{
      type: 'function', name: 'brain_search', inputSchema: {},
    }] as any }))).rejects.toThrow('unknown GBrain tool');

    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => successfulProtocol().child });
    await expect(model.doGenerate(options({ tools: [{ type: 'provider-defined' }] as any }))).rejects.toThrow('function tools');

    const fake = successfulProtocol({ executionItem: true });
    const executionModel = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    await expect(executionModel.doGenerate(options())).rejects.toThrow('execution item');
  });

  test('rejects execution items as soon as they start', async () => {
    const fake = fakeChild((message, send) => {
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution' } } });
      }
    });
    await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
      spawn: () => fake.child,
    }).doGenerate(options())).rejects.toThrow('disallowed execution item');
  });

  test('rejects method-bearing server requests before response correlation', async () => {
    for (const id of [1, 'request-1']) {
      const fake = fakeChild((message, send) => {
        if (message.method === 'initialize') {
          send({ id, method: 'item/commandExecution/requestApproval', params: {} });
        }
      });
      await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
        spawn: () => fake.child,
      }).doGenerate(options())).rejects.toThrow('disallowed client action');
    }
  });

  test('classifies permanent turn errors as configuration failures', async () => {
    for (const codexErrorInfo of ['unauthorized', 'badRequest']) {
      const fake = fakeChild((message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
        if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
        if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'turn-1' } } });
          send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: {
            id: 'turn-1', status: 'failed', items: [], error: { codexErrorInfo },
          } } });
        }
      });
      await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
        spawn: () => fake.child,
      }).doGenerate(options())).rejects.toMatchObject({ name: 'AIConfigError' });
    }
  });

  test('sanitizes failed stdin writes without leaving an unhandled waiter', async () => {
    const fake = successfulProtocol();
    fake.child.stdin.write = async () => { throw new Error('private write detail'); };
    await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
      spawn: () => fake.child,
    }).doGenerate(options())).rejects.toThrow('request write failed');
  });

  test('fails sanitized when the child emits malformed JSON or exits early', async () => {
    const malformed = fakeChild((message, _send, controls) => {
      if (message.method === 'initialize') controls.sendRaw('{not-json}\n');
    });
    await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
      spawn: () => malformed.child,
    }).doGenerate(options())).rejects.toThrow('invalid protocol response');

    const exited = fakeChild((message, _send, controls) => {
      if (message.method === 'initialize') controls.close();
    });
    await expect(new CodexAppServerLanguageModel('gpt-5.6-sol', {
      spawn: () => exited.child,
    }).doGenerate(options())).rejects.toThrow('exited before completing');
  });

  test('interrupts the active turn and kills the child on abort', async () => {
    const fake = fakeChild((message, send) => {
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    });
    const controller = new AbortController();
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol', { spawn: () => fake.child });
    const pending = model.doGenerate(options({ abortSignal: controller.signal }));
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(fake.requests).toContainEqual(expect.objectContaining({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }));
    expect(fake.wasKilled()).toBe(true);
  });
});

test.skipIf(process.env.GBRAIN_CODEX_APP_SERVER_LIVE !== '1')(
  'live Codex app-server returns subscription-backed text through the installed protocol',
  async () => {
    const model = new CodexAppServerLanguageModel('gpt-5.6-sol');
    const result = await model.doGenerate(options({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly READY.' }] }],
    }));
    expect(result.content).toEqual([{ type: 'text', text: 'READY' }]);
  },
  300_000,
);
