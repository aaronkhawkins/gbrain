/**
 * AI SDK LanguageModelV2 adapter for OpenCode's persistent local server.
 *
 * OpenCode owns ChatGPT OAuth and token refresh. The adapter uses OpenCode only
 * as a structured model transport: every OpenCode session denies all tools,
 * and structured tool requests are returned to GBrain's gateway for audited
 * execution. This preserves GBrain's allow-lists, job receipts, and replay
 * semantics instead of letting a second agent write to the brain out of band.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
} from '@ai-sdk/provider';
import { AIConfigError, AITransientError } from '../errors.ts';
import { anySignal } from '../../abort-check.ts';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4097';
const DEFAULT_USERNAME = 'opencode';
const DEFAULT_PROVIDER_ID = 'openai';
const DEFAULT_AGENT = 'gbrain';
const CLEAN_CWD = join(tmpdir(), 'gbrain-opencode-server');
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OpenCodeServerOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  providerId?: string;
  agent?: string;
  directory?: string;
  fetch?: typeof globalThis.fetch;
}

interface OpenCodeStructuredResult {
  text: string;
  tool_calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

interface OpenCodeMessageResponse {
  name?: string;
  data?: { message?: string; ref?: string };
  info?: {
    structured?: unknown;
    error?: unknown;
    finish?: string;
    tokens?: { input?: number; output?: number; total?: number };
  };
  parts?: Array<{ type?: string; text?: string; reason?: string }>;
}

type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';

function responseText(payload: OpenCodeMessageResponse): string {
  return payload.parts
    ?.filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('\n')
    .trim() ?? '';
}

function openCodeFinishReason(payload: OpenCodeMessageResponse): FinishReason {
  const stepFinish = payload.parts?.findLast(part => part.type === 'step-finish')?.reason;
  const reason = (payload.info?.finish ?? stepFinish)?.toLowerCase().replaceAll('_', '-');
  if (!reason || reason === 'stop' || reason === 'end') return 'stop';
  if (reason === 'length' || reason === 'max-tokens' || reason === 'max-output-tokens') return 'length';
  if (reason === 'content-filter') return 'content-filter';
  if (reason === 'tool' || reason === 'tool-call' || reason === 'tool-calls') return 'tool-calls';
  if (reason === 'error') return 'error';
  return 'other';
}

function parseJsonText(rawText: string): unknown {
  let text = rawText.trim();
  if (!text) return undefined;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(text); } catch { /* try extracting an embedded object below */ }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) text = text.slice(firstBrace, lastBrace + 1);
  try { return JSON.parse(text); } catch { return undefined; }
}

function parseJsonResponse(payload: OpenCodeMessageResponse): unknown {
  const value = payload.info?.structured ?? parseJsonText(responseText(payload));
  if (value === undefined || value === null) {
    throw new AITransientError('OpenCode server returned no JSON response.');
  }
  return value;
}

function normalizeModel(model: string): string {
  const prefix = 'opencode-server:';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Render the AI SDK conversation into one deterministic OpenCode prompt. */
export function renderOpenCodePrompt(prompt: LanguageModelV2Prompt): {
  systemText: string;
  conversationText: string;
} {
  const systemParts: string[] = [];
  const conversation: string[] = [];

  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      const text = msg.content
        .map(part => part.type === 'text' ? part.text : `[file ${part.mediaType ?? 'unknown'}]`)
        .join('\n');
      conversation.push(`User: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      const text = msg.content.map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'reasoning') return '';
        if (part.type === 'tool-call') return `[tool_use ${part.toolName}(${part.input})]`;
        if (part.type === 'tool-result') return `[tool_result ${outputToText(part.output)}]`;
        return '';
      }).filter(Boolean).join('\n');
      if (text) conversation.push(`Assistant: ${text}`);
      continue;
    }
    if (msg.role === 'tool') {
      const text = msg.content
        .map(part => `[tool_result ${outputToText(part.output)}]`)
        .join('\n');
      conversation.push(`User: ${text}`);
    }
  }

  return { systemText: systemParts.join('\n\n'), conversationText: conversation.join('\n\n') };
}

function functionTools(
  tools: ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool> | undefined,
): LanguageModelV2FunctionTool[] {
  return (tools ?? []).filter((tool): tool is LanguageModelV2FunctionTool => tool.type === 'function');
}

function toolInstructions(tools: LanguageModelV2FunctionTool[]): string {
  if (tools.length === 0) {
    return 'No tools are available. Return the final answer in text and an empty tool_calls array.';
  }
  const specs = tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  return [
    'GBrain owns tool execution. Do not use any OpenCode tools.',
    'Return only one JSON object with exactly these fields: text (string) and tool_calls (array).',
    'If a GBrain tool is required, return it in tool_calls and leave text empty.',
    'If the conversation already contains a matching [tool_result ...], use it to answer and do not request that tool again.',
    'If the task is complete, return prose in text and an empty tool_calls array.',
    'Available GBrain tools:',
    JSON.stringify(specs),
  ].join('\n\n');
}

function outputSchema(tools: LanguageModelV2FunctionTool[]): Record<string, unknown> {
  const names = tools.map(tool => tool.name);
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      tool_calls: {
        type: 'array',
        ...(names.length === 0 ? { maxItems: 0 } : {}),
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: names.length > 0 ? { type: 'string', enum: names } : { type: 'string' },
            input: { type: 'object', additionalProperties: true },
          },
          required: ['id', 'name', 'input'],
          additionalProperties: false,
        },
      },
    },
    required: ['text', 'tool_calls'],
    additionalProperties: false,
  };
}

function parseStructuredResult(
  payload: OpenCodeMessageResponse,
  allowPlainText = false,
): OpenCodeStructuredResult {
  let value = payload.info?.structured;
  let rawText = '';
  if (value === undefined || value === null) {
    rawText = responseText(payload);
    value = parseJsonText(rawText);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (allowPlainText && rawText) return { text: rawText, tool_calls: [] };
    throw new AITransientError('OpenCode server returned no structured response.');
  }
  const obj = value as Record<string, unknown>;
  const text = typeof obj.text === 'string'
    ? obj.text
    : typeof obj.output_text === 'string'
      ? obj.output_text
      : '';
  if (!Array.isArray(obj.tool_calls)) {
    if (allowPlainText) return { text, tool_calls: [] };
    throw new AITransientError('OpenCode structured response omitted tool_calls.');
  }
  const toolCalls = obj.tool_calls.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AITransientError(`OpenCode returned malformed tool call at index ${index}.`);
    }
    const call = entry as Record<string, unknown>;
    let input = call.input ?? call.arguments;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* rejected below */ }
    }
    if (typeof call.name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AITransientError(`OpenCode returned malformed tool call at index ${index}.`);
    }
    return {
      id: typeof call.id === 'string' && call.id ? call.id : `toolu_opencode_${index}`,
      name: call.name,
      input: input as Record<string, unknown>,
    };
  });
  // Some OpenCode/OpenAI model combinations satisfy the wrapper schema with
  // an empty `text` field while placing the actual assistant answer in the
  // normal text parts. Prefer that answer only for tool-free completions;
  // tool-capable turns must retain the validated structured boundary.
  const partText = toolCalls.length === 0 ? responseText(payload) : '';
  return { text: text || partText, tool_calls: toolCalls };
}

export class OpenCodeServerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'opencode-server';
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly providerId: string;
  private readonly agent: string;
  private readonly directory: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(modelId: string, options: OpenCodeServerOptions = {}) {
    this.modelId = normalizeModel(modelId);
    this.baseUrl = (options.baseUrl ?? DEFAULT_SERVER_URL).replace(/\/$/, '');
    this.username = options.username ?? DEFAULT_USERNAME;
    this.password = options.password ?? '';
    this.providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
    this.agent = options.agent ?? DEFAULT_AGENT;
    this.directory = options.directory ?? CLEAN_CWD;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    let endpoint: URL;
    try { endpoint = new URL(this.baseUrl); } catch {
      throw new AIConfigError('Invalid OpenCode server URL.');
    }
    if (!['127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname)) {
      throw new AIConfigError('OpenCode server endpoint must use a numeric loopback address.');
    }
    if (!this.password) {
      throw new AIConfigError('OpenCode server authentication is required.');
    }
    mkdirSync(this.directory, { recursive: true });
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
    };
  }

  private isStructuredOutputError(payload: OpenCodeMessageResponse): boolean {
    const error = payload.info?.error;
    return Boolean(
      error &&
      typeof error === 'object' &&
      (error as Record<string, unknown>).name === 'StructuredOutputError',
    );
  }

  private topLevelError(payload: OpenCodeMessageResponse): string | null {
    if (!payload.name && !payload.data?.message) return null;
    return [payload.name, payload.data?.message, payload.data?.ref]
      .filter(Boolean)
      .join(': ');
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    const requestSignal = anySignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal);
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal: requestSignal,
      });
    } catch {
      if (signal?.aborted) throw new AITransientError('OpenCode server request was aborted.');
      throw new AITransientError('OpenCode server request failed or timed out.');
    }
    if (response.ok) return response;
    const message = `OpenCode server HTTP ${response.status}.`;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new AIConfigError(message, 'Check the OpenCode server URL, password, and ChatGPT OAuth login.');
    }
    throw new AITransientError(message);
  }

  private async readJson(response: Response): Promise<OpenCodeMessageResponse> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new AITransientError('OpenCode server response exceeded the configured size limit.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new AITransientError('OpenCode server response exceeded the configured size limit.');
    }
    try {
      return JSON.parse(text) as OpenCodeMessageResponse;
    } catch {
      throw new AITransientError('OpenCode server returned an invalid response envelope.');
    }
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
    warnings: never[];
  }> {
    const tools = functionTools(options.tools);
    const jsonFormat = options.responseFormat?.type === 'json' ? options.responseFormat : undefined;
    if (jsonFormat && tools.length > 0) {
      throw new AIConfigError('OpenCode JSON response format cannot be combined with GBrain tools.');
    }
    const knownToolNames = new Set(tools.map(tool => tool.name));
    const { systemText, conversationText } = renderOpenCodePrompt(options.prompt);
    const directory = encodeURIComponent(this.directory);
    let sessionId: string | null = null;

    try {
      const sessionResponse = await this.request(`/session?directory=${directory}`, {
        method: 'POST',
        body: JSON.stringify({
          title: `GBrain ${this.modelId}`,
          model: { id: this.modelId, providerID: this.providerId },
          permission: [{ permission: '*', pattern: '*', action: 'deny' }],
        }),
      }, options.abortSignal);
      const session = await this.readJson(sessionResponse) as { id?: string };
      if (!session.id) throw new AITransientError('OpenCode server did not return a session id.');
      sessionId = session.id;

      const messagePath = `/session/${encodeURIComponent(sessionId)}/message?directory=${directory}`;
      const responseInstructions = jsonFormat
        ? [
            'Return only JSON that matches the requested schema.',
            jsonFormat.description ?? '',
          ].filter(Boolean).join('\n\n')
        : toolInstructions(tools);
      const baseMessage = {
        model: { providerID: this.providerId, modelID: this.modelId },
        agent: this.agent,
        system: [systemText, responseInstructions].filter(Boolean).join('\n\n'),
        parts: [{ type: 'text', text: conversationText }],
      };
      const requestedSchema = jsonFormat
        ? (jsonFormat.schema ?? {})
        : outputSchema(tools);
      let response = await this.request(messagePath, {
        method: 'POST',
        body: JSON.stringify({
          ...baseMessage,
          format: !jsonFormat && tools.length === 0
            ? { type: 'text' }
            : { type: 'json_schema', schema: requestedSchema, retryCount: 2 },
        }),
      }, options.abortSignal);
      let payload = await this.readJson(response);
      let retryUsage: { input?: number; output?: number; total?: number } | undefined;
      let recoveredToolFreeText = false;
      if (this.isStructuredOutputError(payload) && !jsonFormat && tools.length === 0) {
        try {
          recoveredToolFreeText = Boolean(parseStructuredResult(payload, true).text);
        } catch { /* retry below */ }
      }
      if ((this.isStructuredOutputError(payload) || this.topLevelError(payload)) && !recoveredToolFreeText) {
        retryUsage = payload.info?.tokens;
        const retryInstruction = jsonFormat
          ? 'IMPORTANT: Return only the required JSON value. Do not return prose or markdown outside it.'
          : 'IMPORTANT: Return only the required JSON object. Do not return prose or markdown outside it.';
        response = await this.request(messagePath, {
          method: 'POST',
          body: JSON.stringify({
            ...baseMessage,
            format: { type: 'text' },
            parts: [{
              type: 'text',
              text: `${conversationText}\n\n${retryInstruction}`,
            }],
          }),
        }, options.abortSignal);
        payload = await this.readJson(response);
      }
      if ((payload.info?.error || this.topLevelError(payload)) && !recoveredToolFreeText) {
        throw new AITransientError('OpenCode assistant returned an error envelope.');
      }
      const inputTokens = (payload.info?.tokens?.input ?? 0) + (retryUsage?.input ?? 0);
      const outputTokens = (payload.info?.tokens?.output ?? 0) + (retryUsage?.output ?? 0);
      const totalTokens = (payload.info?.tokens?.total ?? 0) + (retryUsage?.total ?? 0) ||
        (inputTokens + outputTokens || undefined);

      if (jsonFormat) {
        return {
          content: [{ type: 'text', text: JSON.stringify(parseJsonResponse(payload)) }],
          finishReason: openCodeFinishReason(payload),
          usage: { inputTokens, outputTokens, totalTokens },
          warnings: [],
        };
      }
      // Plain text is safe only when GBrain offered no tools. Tool-capable turns
      // must retain the validated JSON boundary so OpenCode cannot bypass the
      // gateway's tool allowlist or argument validation.
      const finishReason = openCodeFinishReason(payload);
      const result = tools.length === 0 && finishReason === 'length' && !responseText(payload)
        ? { text: '', tool_calls: [] }
        : parseStructuredResult(payload, tools.length === 0);
      for (const call of result.tool_calls) {
        if (!knownToolNames.has(call.name)) {
          throw new AITransientError(`OpenCode requested unknown GBrain tool "${call.name}".`);
        }
      }

      const content: LanguageModelV2Content[] = [];
      if (result.text) content.push({ type: 'text', text: result.text });
      for (const call of result.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: JSON.stringify(call.input),
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });

      return {
        content,
        finishReason: result.tool_calls.length > 0 ? 'tool-calls' : finishReason,
        usage: { inputTokens, outputTokens, totalTokens },
        warnings: [],
      };
    } finally {
      if (sessionId) {
        await this.request(`/session/${encodeURIComponent(sessionId)}?directory=${directory}`, {
          method: 'DELETE',
        }, AbortSignal.timeout(5_000)).catch(() => {});
      }
    }
  }

  async doStream(): Promise<never> {
    throw new Error('OpenCode server adapter does not support streaming; use doGenerate.');
  }
}
