/** AI SDK adapter for the local Codex app-server JSONL protocol. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
} from '@ai-sdk/provider';
import { AIConfigError, AITransientError } from '../errors.ts';

const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;
const CHATGPT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';

interface CodexStdin {
  write(chunk: string | Uint8Array): number | Promise<number>;
  flush?(): void | Promise<void>;
  end?(): void;
}

export interface CodexAppServerChild {
  stdin: CodexStdin;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CodexAppServerOptions {
  codexPath?: string;
  spawn?: (options: { cwd: string; env: Record<string, string> }) => CodexAppServerChild;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function toolEnvelopeSchema(tools: LanguageModelV2FunctionTool[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      tool_call: {
        anyOf: [
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string', enum: tools.map(tool => tool.name) },
              // Keep provider-facing structured output deliberately simple.
              // Real GBrain schemas may contain optional/default/union keywords
              // that Codex structured output does not accept. GBrain validates
              // the decoded arguments against the real tool schema downstream.
              input_json: { type: 'string' },
            },
            required: ['id', 'name', 'input_json'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
      },
    },
    required: ['text', 'tool_call'],
    additionalProperties: false,
  };
}

function toolPrompt(tools: LanguageModelV2FunctionTool[]): string {
  return [
    'GBrain owns tool execution. Do not invoke Codex tools or execute the functions yourself.',
    'Return the required JSON envelope. To request a tool, set text to an empty string and tool_call to one call.',
    'Encode the tool arguments as a JSON object string in tool_call.input_json.',
    'When the task is complete, put the final answer in text and set tool_call to null.',
    'If the conversation contains a matching Tool result, use it rather than requesting the same call again.',
    'Available GBrain functions:',
    JSON.stringify(tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? { type: 'object' },
    }))),
  ].join('\n\n');
}

function normalizeModel(model: string): string {
  const prefix = 'codex-app-server:';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function safeEnvironment(): Record<string, string> {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'CODEX_HOME'];
  return Object.fromEntries(
    allowed.flatMap(key => process.env[key] ? [[key, process.env[key] as string]] : []),
  );
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const DISABLED_CODEX_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'plugins',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_call_mcp_elicitation',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
] as const;

/** Render a provider-neutral AI SDK conversation as one Codex text input. */
export function renderCodexPrompt(prompt: LanguageModelV2Prompt): string {
  const sections: string[] = [];
  for (const message of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (message.role === 'system') {
      sections.push(`System:\n${message.content}`);
      continue;
    }
    if (message.role === 'user') {
      const parts = message.content.map(part => {
        if (part.type !== 'text') throw new AIConfigError('Codex app-server accepts text input only.');
        return part.text;
      });
      sections.push(`User:\n${parts.join('\n')}`);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = message.content.flatMap(part => {
        if (part.type === 'text') return [part.text];
        if (part.type === 'reasoning') return [];
        if (part.type === 'tool-call') return [`[tool_use ${part.toolName}(${part.input})]`];
        if (part.type === 'tool-result') return [`[tool_result ${outputText(part.output)}]`];
        return [];
      });
      if (parts.length) sections.push(`Assistant:\n${parts.join('\n')}`);
      continue;
    }
    if (message.role === 'tool') {
      sections.push(`Tool result:\n${message.content.map(part => outputText(part.output)).join('\n')}`);
    }
  }
  sections.push('Return only the final answer. Do not invoke tools, inspect files, or execute commands.');
  return sections.join('\n\n');
}

export function codexAppServerCommand(codexPath: string): string[] {
  return [
    codexPath,
    'app-server',
    '--stdio',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    ...DISABLED_CODEX_FEATURES.flatMap(feature => ['--disable', feature]),
  ];
}

/** Prefer the subscription-authenticated Codex bundled with ChatGPT on macOS. */
export function defaultCodexAppServerPath(): string {
  return existsSync(CHATGPT_CODEX_PATH) ? CHATGPT_CODEX_PATH : 'codex';
}

let spawnOverrideForTests: CodexAppServerOptions['spawn'];

/** @internal Test seam for gateway-level integration fixtures. */
export function setCodexAppServerSpawnForTests(spawn?: CodexAppServerOptions['spawn']): void {
  spawnOverrideForTests = spawn;
}

function spawnCodex(codexPath: string, options: { cwd: string; env: Record<string, string> }): CodexAppServerChild {
  return Bun.spawn({
    cmd: codexAppServerCommand(codexPath),
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CodexAppServerChild;
}

export class CodexAppServerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-app-server';
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly codexPath: string;
  private readonly spawn: NonNullable<CodexAppServerOptions['spawn']>;
  private readonly usesRealProcess: boolean;

  constructor(modelId: string, options: CodexAppServerOptions = {}) {
    this.modelId = normalizeModel(modelId);
    this.codexPath = options.codexPath ?? defaultCodexAppServerPath();
    const injectedSpawn = options.spawn ?? spawnOverrideForTests;
    this.usesRealProcess = !injectedSpawn;
    this.spawn = injectedSpawn ?? (spawnOptions => spawnCodex(this.codexPath, spawnOptions));
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'tool-calls' | 'error';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
    warnings: never[];
  }> {
    const rawTools = options.tools ?? [];
    if (rawTools.some(tool => tool.type !== 'function')) {
      throw new AIConfigError('Codex app-server accepts AI SDK function tools only.');
    }
    const tools = rawTools as LanguageModelV2FunctionTool[];
    const jsonFormat = options.responseFormat?.type === 'json' ? options.responseFormat : undefined;
    if (tools.length > 0 && jsonFormat) {
      throw new AIConfigError('Codex app-server cannot combine function tools with a JSON response format.');
    }
    if (options.abortSignal?.aborted) {
      throw new AITransientError('Codex app-server request was aborted.');
    }
    if (
      this.usesRealProcess &&
      process.env.NODE_ENV === 'test' &&
      process.env.GBRAIN_CODEX_APP_SERVER_LIVE !== '1'
    ) {
      throw new AIConfigError(
        'Live Codex app-server calls are disabled during tests.',
        'Set GBRAIN_CODEX_APP_SERVER_LIVE=1 only for the opt-in protocol test.',
      );
    }

    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-codex-'));
    let child: CodexAppServerChild;
    try {
      child = this.spawn({ cwd, env: safeEnvironment() });
    } catch {
      rmSync(cwd, { recursive: true, force: true });
      throw new AIConfigError('Unable to start Codex app-server.', 'Install Codex, then run `codex login`.');
    }

    let requestId = 0;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finalText = '';
    let usage: Usage = {};
    let totalBytes = 0;
    let settled = false;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    let completeResolve!: () => void;
    let completeReject!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      completeResolve = resolve;
      completeReject = reject;
    });
    // Protocol failures can happen before turn/start, when the main path is
    // awaiting a request rather than this promise. Register a handler now so
    // that early child exit cannot become an unhandled rejection.
    void completed.catch(() => {});

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      completeReject(error);
    };
    const write = async (message: JsonRpcMessage) => {
      await child.stdin.write(`${JSON.stringify(message)}\n`);
      await child.stdin.flush?.();
    };
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = ++requestId;
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      void response.catch(() => {});
      try {
        await write({ id, method, params });
      } catch {
        pending.delete(id);
        throw new AITransientError('Codex app-server request write failed.');
      }
      return response;
    };

    const onMessage = (message: JsonRpcMessage) => {
      if (message.method && (typeof message.id === 'number' || typeof message.id === 'string')) {
        fail(new AITransientError(`Codex app-server requested a disallowed client action (${message.method}).`));
        return;
      }
      if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new AITransientError('Codex app-server rejected a protocol request.'));
        else waiter.resolve(message.result);
        return;
      }
      if (!message.method) return;
      const params = isRecord(message.params) ? message.params : {};
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (params.turnId && turnId && params.turnId !== turnId) return;

      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = isRecord(params.item) ? params.item : {};
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          if (message.method === 'item/completed') finalText = item.text.trim();
          return;
        }
        if (item.type === 'userMessage' || item.type === 'reasoning') return;
        fail(new AITransientError(`Codex app-server returned a disallowed execution item (${String(item.type ?? 'unknown')}).`));
        return;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
        const tokens = isRecord(tokenUsage.last)
          ? tokenUsage.last
          : isRecord(tokenUsage.total) ? tokenUsage.total : {};
        usage = {
          inputTokens: finiteNumber(tokens.inputTokens),
          outputTokens: finiteNumber(tokens.outputTokens),
          totalTokens: finiteNumber(tokens.totalTokens),
        };
        return;
      }
      if (message.method === 'turn/completed') {
        const turn = isRecord(params.turn) ? params.turn : {};
        const items = Array.isArray(turn.items) ? turn.items : [];
        for (const item of items) {
          if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') finalText = item.text.trim();
        }
        if (turn.status !== 'completed') {
          const turnError = isRecord(turn.error) ? turn.error : {};
          const errorInfo = turnError.codexErrorInfo;
          if (errorInfo === 'unauthorized' || errorInfo === 'badRequest') {
            fail(new AIConfigError(
              'Codex app-server rejected the subscription request.',
              errorInfo === 'unauthorized'
                ? 'Run `codex login` and choose Sign in with ChatGPT.'
                : 'Check the configured Codex model and request shape.',
            ));
          } else {
            fail(new AITransientError('Codex app-server turn failed.'));
          }
          return;
        }
        if (!settled) {
          settled = true;
          completeResolve();
        }
      }
    };

    const pump = async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_PROTOCOL_BYTES) throw new Error('response exceeded size limit');
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES) throw new Error('response exceeded size limit');
            const parsed = JSON.parse(line) as unknown;
            if (!isRecord(parsed)) throw new Error('invalid JSON-RPC message');
            onMessage(parsed as JsonRpcMessage);
          }
        }
        if (!settled) fail(new AITransientError('Codex app-server exited before completing the turn.'));
      } catch {
        fail(new AITransientError('Codex app-server returned an invalid protocol response.'));
      }
    };
    void pump();
    // Drain stderr without exposing provider or credential-bearing output.
    void (async () => {
      const reader = child.stderr.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    })().catch(() => {});

    const abort = () => {
      if (threadId && turnId) void write({ id: ++requestId, method: 'turn/interrupt', params: { threadId, turnId } }).catch(() => {});
      fail(new AITransientError('Codex app-server request was aborted.'));
    };
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);

    try {
      await request('initialize', {
        clientInfo: { name: 'gbrain', title: 'GBrain', version: '0.1.0' },
      });
      await write({ method: 'initialized', params: {} });
      const account = nestedRecord(await request('account/read', { refreshToken: false }), 'account');
      if (account?.type !== 'chatgpt') {
        throw new AIConfigError('Codex is not signed in with ChatGPT; run `codex login` and choose Sign in with ChatGPT.');
      }
      const thread = nestedRecord(await request('thread/start', {
        model: this.modelId,
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: 'Act only as a text synthesis model. Do not invoke tools, inspect files, or execute commands.',
      }), 'thread');
      threadId = typeof thread?.id === 'string' ? thread.id : undefined;
      if (!threadId) throw new AITransientError('Codex app-server did not return a thread id.');
      const promptText = [renderCodexPrompt(options.prompt), tools.length ? toolPrompt(tools) : '']
        .filter(Boolean)
        .join('\n\n');
      const turn = nestedRecord(await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: promptText }],
        ...(tools.length > 0
          ? { outputSchema: toolEnvelopeSchema(tools) }
          : jsonFormat?.schema ? { outputSchema: jsonFormat.schema } : {}),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }), 'turn');
      turnId = typeof turn?.id === 'string' ? turn.id : undefined;
      if (!turnId) throw new AITransientError('Codex app-server did not return a turn id.');
      await completed;
      if (!finalText) {
        throw new AITransientError('Codex app-server completed with no final assistant text.');
      }
      if (tools.length > 0) {
        let envelope: unknown;
        try { envelope = JSON.parse(finalText); } catch {
          throw new AITransientError('Codex app-server returned an invalid tool envelope.');
        }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
          throw new AITransientError('Codex app-server returned an invalid tool envelope.');
        }
        const value = envelope as Record<string, unknown>;
        const text = typeof value.text === 'string' ? value.text.trim() : '';
        const call = value.tool_call;
        if (call !== null && call !== undefined) {
          if (!call || typeof call !== 'object' || Array.isArray(call)) {
            throw new AITransientError('Codex app-server returned an invalid tool envelope.');
          }
          const toolCall = call as Record<string, unknown>;
          const knownNames = new Set(tools.map(tool => tool.name));
          if (typeof toolCall.name !== 'string' || !knownNames.has(toolCall.name)) {
            throw new AITransientError(`Codex app-server requested unknown GBrain tool "${String(toolCall.name ?? '')}".`);
          }
          let toolInput: unknown;
          if (typeof toolCall.input_json === 'string') {
            try { toolInput = JSON.parse(toolCall.input_json); } catch { /* rejected below */ }
          }
          if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
            throw new AITransientError('Codex app-server returned invalid GBrain tool input.');
          }
          const toolCallId = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : 'toolu_codex_0';
          return {
            content: [{
              type: 'tool-call',
              toolCallId,
              toolName: toolCall.name,
              input: JSON.stringify(toolInput),
            }],
            finishReason: 'tool-calls',
            usage: usage as { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined },
            warnings: [],
          };
        }
        if (!text) throw new AITransientError('Codex app-server tool envelope contained no final answer or tool call.');
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          usage: usage as { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined },
          warnings: [],
        };
      }
      if (jsonFormat) {
        try { finalText = JSON.stringify(JSON.parse(finalText)); } catch {
          throw new AITransientError('Codex app-server returned invalid JSON for a structured response.');
        }
      }
      return {
        content: [{ type: 'text', text: finalText }],
        finishReason: 'stop',
        usage: usage as { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined },
        warnings: [],
      };
    } catch (error) {
      if (error instanceof AIConfigError || error instanceof AITransientError) throw error;
      throw new AITransientError('Codex app-server request failed.');
    } finally {
      // Prevent child shutdown from rejecting the completion promise after an
      // earlier configuration/protocol error has already won this call.
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', abort);
      for (const waiter of pending.values()) waiter.reject(new AITransientError('Codex app-server request ended.'));
      pending.clear();
      child.stdin.end?.();
      try { child.kill(); } catch { /* already exited */ }
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  async doStream(): Promise<never> {
    throw new Error('Codex app-server adapter does not support streaming; use doGenerate.');
  }
}
