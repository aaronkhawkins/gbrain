/**
 * `gbrain observe` — native operational observer.
 *
 *   gbrain observe serve [--bind ADDR] [--port N] [--refresh-ms N]
 *   gbrain observe snapshot [--json]
 *
 * serve: long-running process, probe-only DB, /metrics + /healthz.
 * snapshot: one-shot operational JSON (also available as status --section operational).
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import {
  buildReadOnlyOperationalSnapshot,
  serializeOperationalSnapshot,
} from '../core/observability/snapshot.ts';
import {
  resolveObserverBind,
  startObserverServer,
  assertSafeBind,
  assertObserverTiming,
} from '../core/observability/observer-server.ts';
import type { ObservabilityConfig } from '../core/observability/types.ts';

export const OBSERVE_HELP = `gbrain observe — per-brain operational observer

Usage:
  gbrain observe serve [--bind ADDR] [--port N] [--refresh-ms N] [--collect-timeout-ms N]
  gbrain observe snapshot [--json]
  gbrain observe --help

serve binds a private OpenMetrics endpoint for Prometheus scrape.
Uses enforced read-only DB sessions (never applies migrations).

Environment:
  GBRAIN_HOME     Isolates config + local runtime evidence per brain
  GBRAIN_OBSERVE_BIND / GBRAIN_OBSERVE_PORT  Override bind defaults
`;

function parseFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) return i + 1 < args.length ? args[i + 1] : '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

function readObs(cfg: GBrainConfig | null): ObservabilityConfig {
  return (cfg as { observability?: ObservabilityConfig } | null)?.observability ?? {};
}

export interface RunObserveResult {
  exitCode: 0 | 1 | 2;
}

/**
 * CLI entry. For `serve`, this function does not return until the process
 * is signalled (or tests call the returned handle).
 */
export async function runObserve(
  engine: BrainEngine | null,
  args: string[],
  opts: {
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    /** When true, serve returns the server handle instead of blocking. */
    returnServer?: boolean;
  } = {},
): Promise<RunObserveResult & { server?: Awaited<ReturnType<typeof startObserverServer>> }> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    stdout(OBSERVE_HELP);
    return { exitCode: 0 };
  }

  const sub = args[0];
  const rest = args.slice(1);
  const cfg = loadConfig();

  if (sub === 'snapshot') {
    const json = rest.includes('--json') || true; // always JSON for machine use
    void json;
    try {
      const snap = await buildReadOnlyOperationalSnapshot({
        engine,
        config: cfg,
        onCollectorError: (adapterId, error) => {
          stderr(`gbrain observe: collector ${adapterId} failed: ${(error as Error).message}\n`);
        },
      });
      stdout(serializeOperationalSnapshot(snap) + '\n');
      return { exitCode: 0 };
    } catch (err) {
      stderr(`gbrain observe snapshot failed: ${(err as Error).message}\n`);
      return { exitCode: 1 };
    }
  }

  if (sub === 'serve') {
    const obs = readObs(cfg);
    const defaults = resolveObserverBind(obs.observer);
    const bind =
      parseFlag(rest, '--bind') ??
      process.env.GBRAIN_OBSERVE_BIND ??
      defaults.bind;
    const portRaw =
      parseFlag(rest, '--port') ??
      process.env.GBRAIN_OBSERVE_PORT ??
      String(defaults.port);
    const port = Number(portRaw);
    if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      stderr(`gbrain observe serve: invalid --port ${portRaw}\n`);
      return { exitCode: 2 };
    }
    const refreshMs = Number(parseFlag(rest, '--refresh-ms') ?? defaults.refreshMs);
    const collectTimeoutMs = Number(
      parseFlag(rest, '--collect-timeout-ms') ?? defaults.collectTimeoutMs,
    );
    const allowPublic =
      rest.includes('--allow-public-bind') || defaults.allowPublicBind;

    try {
      assertSafeBind(bind, allowPublic);
      assertObserverTiming(refreshMs, collectTimeoutMs);
    } catch (err) {
      const message = (err as Error).message
        .replace('observer: refreshMs', 'gbrain observe serve: invalid --refresh-ms; value')
        .replace('observer: collectTimeoutMs', 'gbrain observe serve: invalid --collect-timeout-ms; value');
      stderr(`${message}\n`);
      return { exitCode: 2 };
    }

    try {
      const server = await startObserverServer({
        engine,
        config: cfg,
        bind,
        port,
        refreshMs,
        collectTimeoutMs,
        allowPublicBind: allowPublic,
      });
      stderr(`gbrain observe: serving metrics at ${server.url}/metrics (brain=${server.getCached()?.brain})\n`);

      if (opts.returnServer) {
        return { exitCode: 0, server };
      }

      await new Promise<void>((resolve) => {
        const stop = () => {
          void server.close().finally(() => resolve());
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return { exitCode: 0 };
    } catch (err) {
      stderr(`gbrain observe serve failed: ${(err as Error).message}\n`);
      return { exitCode: 1 };
    }
  }

  stderr(`gbrain observe: unknown subcommand ${JSON.stringify(sub)}\n${OBSERVE_HELP}`);
  return { exitCode: 2 };
}
