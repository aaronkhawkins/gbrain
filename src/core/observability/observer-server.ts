/**
 * Native per-brain observer HTTP server.
 *
 * Exposes only:
 *   GET /healthz  — liveness
 *   GET /metrics  — OpenMetrics snapshot (cached)
 *
 * Forces probe-only DB use (caller responsibility). Rejects public binds
 * unless allow_public_bind is set. Never runs Doctor or mutates state.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { buildOperationalSnapshot, serializeOperationalSnapshot } from './snapshot.ts';
import { renderOpenMetrics, scanOpenMetricsForProhibited } from './openmetrics.ts';
import type { ObservabilityConfig, OperationalSnapshot } from './types.ts';

export interface ObserverServerOptions {
  engine: BrainEngine | null;
  config: GBrainConfig | null;
  bind: string;
  port: number;
  refreshMs?: number;
  collectTimeoutMs?: number;
  allowPublicBind?: boolean;
  /** Injected snapshot builder (tests). */
  buildSnapshot?: () => Promise<OperationalSnapshot>;
  now?: () => Date;
}

export interface ObserverServer {
  url: string;
  close: () => Promise<void>;
  /** Force-refresh the cache (tests). */
  refresh: () => Promise<OperationalSnapshot>;
  getCached: () => OperationalSnapshot | null;
}

const PUBLIC_BINDS = new Set(['0.0.0.0', '::', '[::]', '*']);

export function assertSafeBind(bind: string, allowPublic: boolean): void {
  const normalized = bind.trim().toLowerCase();
  if (!allowPublic && (PUBLIC_BINDS.has(normalized) || normalized === '')) {
    throw new Error(
      `observer: public/wildcard bind ${JSON.stringify(bind)} rejected; ` +
      `set observability.observer.allow_public_bind=true only for local tests`,
    );
  }
}

export function resolveObserverBind(obs?: ObservabilityConfig['observer']): {
  bind: string;
  port: number;
  refreshMs: number;
  collectTimeoutMs: number;
  allowPublicBind: boolean;
} {
  return {
    bind: obs?.bind ?? '127.0.0.1',
    port: obs?.port ?? 9108,
    refreshMs: obs?.refresh_ms ?? 30_000,
    collectTimeoutMs: obs?.collect_timeout_ms ?? 15_000,
    allowPublicBind: obs?.allow_public_bind === true,
  };
}

export async function startObserverServer(opts: ObserverServerOptions): Promise<ObserverServer> {
  assertSafeBind(opts.bind, opts.allowPublicBind === true);
  const refreshMs = opts.refreshMs ?? 30_000;
  const collectTimeoutMs = opts.collectTimeoutMs ?? 15_000;
  const nowFn = opts.now ?? (() => new Date());

  let cached: OperationalSnapshot | null = null;
  let cachedMetrics: string | null = null;
  let refreshing: Promise<OperationalSnapshot> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const build = opts.buildSnapshot ?? (async () =>
    buildOperationalSnapshot({
      engine: opts.engine,
      config: opts.config,
      now: nowFn(),
      collectTimeoutMs,
    }));

  async function refresh(): Promise<OperationalSnapshot> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const snap = await build();
        snap.observer = {
          bind: opts.bind,
          port: opts.port,
          snapshot_age_ms: 0,
        };
        const metrics = renderOpenMetrics(snap);
        const prohibited = scanOpenMetricsForProhibited(metrics);
        if (prohibited.length > 0) {
          throw new Error(`observer: prohibited content in metrics: ${prohibited.join(',')}`);
        }
        cached = snap;
        cachedMetrics = metrics;
        return snap;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // Prime cache before accepting scrapes.
  await refresh();

  timer = setInterval(() => {
    void refresh().catch(() => {
      /* keep last good cache; Prometheus staleness via timestamp */
    });
  }, refreshMs);
  // Don't keep the process alive solely for the refresh timer when tests close.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Input-free: ignore body, query string side effects, methods other than GET/HEAD.
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed\n');
      return;
    }

    const url = req.url?.split('?')[0] ?? '/';

    if (url === '/healthz' || url === '/health') {
      const ok = cached != null;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(JSON.stringify({
        ok,
        brain: cached?.brain ?? null,
        generated_at: cached?.generated_at ?? null,
        state: cached?.state ?? 'unknown',
      }) + '\n');
      return;
    }

    if (url === '/metrics') {
      // Serve cached snapshot only — scrapes never trigger unbounded collection.
      if (!cachedMetrics || !cached) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('# no snapshot yet\n');
        return;
      }
      const ageMs = Date.now() - Date.parse(cached.generated_at);
      // Re-stamp observer age in JSON path only; metrics timestamp is generation time.
      void ageMs;
      res.writeHead(200, {
        'content-type': 'application/openmetrics-text; version=1.0.0; charset=utf-8',
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(cachedMetrics);
      return;
    }

    if (url === '/snapshot.json') {
      if (!cached) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"no_snapshot"}\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(serializeOperationalSnapshot(cached) + '\n');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bind, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const url = `http://${opts.bind}:${port}`;

  return {
    url,
    getCached: () => cached,
    refresh,
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
