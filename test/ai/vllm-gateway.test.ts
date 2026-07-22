import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chat,
  configureGateway,
  expand,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

const MODEL = 'nvidia/Qwen3.6-35B-A3B-NVFP4';
let server: ReturnType<typeof Bun.serve>;
let lastBody: Record<string, any> | undefined;

function completion(content: string | null, finishReason: string, completionTokens: number) {
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 0,
    model: MODEL,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: 5,
      completion_tokens: completionTokens,
      total_tokens: 5 + completionTokens,
    },
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
      }
      if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      lastBody = await request.json() as Record<string, any>;
      const prompt = JSON.stringify(lastBody.messages ?? []);
      if (prompt.includes('empty-stop')) return Response.json(completion(null, 'stop', 12));
      if (prompt.includes('empty-length')) return Response.json(completion(null, 'length', 12));
      if (prompt.includes('expansion failure')) return new Response('invalid request detail', { status: 400 });
      return Response.json(completion('READY', 'stop', 2));
    },
  });
});

afterAll(() => {
  resetGateway();
  server.stop(true);
});

beforeEach(() => {
  lastBody = undefined;
  configureGateway({
    chat_model: `vllm:${MODEL}`,
    expansion_model: `vllm:${MODEL}`,
    base_urls: { vllm: `http://127.0.0.1:${server.port}/v1` },
    env: {},
  });
});

describe('vLLM through the GBrain gateway', () => {
  test('returns text and disables thinking for background calls', async () => {
    const result = await chat({ messages: [{ role: 'user', content: 'ready' }] });

    expect(result.text).toBe('READY');
    expect(result.providerId).toBe('vllm');
    expect(lastBody?.model).toBe(MODEL);
    expect(lastBody?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('treats a stopped nonzero-token empty completion as transient contract failure', async () => {
    await expect(chat({ messages: [{ role: 'user', content: 'empty-stop' }] }))
      .rejects.toBeInstanceOf(AITransientError);
  });

  test('classifies an empty length completion as an output-budget configuration failure', async () => {
    await expect(chat({ messages: [{ role: 'user', content: 'empty-length' }] }))
      .rejects.toBeInstanceOf(AIConfigError);
  });

  test('logs a sanitized diagnostic when best-effort expansion falls back', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await expand('expansion failure')).toEqual(['expansion failure']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('vllm');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('invalid request detail');
    } finally {
      warn.mockRestore();
    }
  });
});
