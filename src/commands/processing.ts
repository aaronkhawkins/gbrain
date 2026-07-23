import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import {
  finishProcessingReceipt,
  listProcessingRegistrations,
  registerProcessor,
  startProcessingReceipt,
  type ProcessingOutcome,
} from '../core/processing-receipts.ts';

export const PROCESSING_HELP = `gbrain processing — generic external-processor receipts

Usage:
  gbrain processing register --key KEY --version V --cadence-seconds N --runbook KEY [--required] [--grace-seconds N] [--repair-job NAME]
  gbrain processing start --key KEY --version V --scope OPAQUE --fingerprint SHA256
  gbrain processing finish --key KEY --version V --scope OPAQUE --fingerprint SHA256 --outcome completed|partial|failed|skipped [--input-count N] [--output-count N] [--backlog-count N] [--reason CODE] [--lineage-kind KIND] [--lineage-id OPAQUE]
  gbrain processing list
  gbrain processing repair plan --key KEY
  gbrain processing repair dispatch --key KEY --yes

This contract stores operational metadata only. Do not pass content, URLs,
prompts, model output, raw errors, or credentials.
`;

function flag(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw new Error(`missing ${name}`);
  return value;
}

function intFlag(args: string[], name: string, fallback?: number): number | undefined {
  const raw = flag(args, name);
  if (raw == null) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

const REPAIR_JOB_ALLOWLIST = new Set([
  'noop',
  'autopilot-cycle',
  'embed',
  'extract-conversation-facts',
  'ingest_capture',
]);

export async function runProcessing(
  engine: BrainEngine,
  args: string[],
): Promise<{ exitCode: 0 | 1 | 2 }> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(PROCESSING_HELP);
    return { exitCode: 0 };
  }
  try {
    const [sub, ...rest] = args;
    if (sub === 'register') {
      const row = await registerProcessor(engine, {
        key: flag(rest, '--key', true)!,
        version: flag(rest, '--version', true)!,
        cadenceSeconds: intFlag(rest, '--cadence-seconds')!,
        graceSeconds: intFlag(rest, '--grace-seconds', 0),
        backlogWarn: intFlag(rest, '--backlog-warn'),
        backlogFail: intFlag(rest, '--backlog-fail'),
        runbook: flag(rest, '--runbook', true)!,
        repairJobName: flag(rest, '--repair-job') ?? null,
        required: rest.includes('--required'),
        enabled: !rest.includes('--disabled'),
      });
      process.stdout.write(JSON.stringify(row) + '\n');
      return { exitCode: 0 };
    }
    if (sub === 'start') {
      const row = await startProcessingReceipt(engine, {
        processorKey: flag(rest, '--key', true)!,
        processorVersion: flag(rest, '--version', true)!,
        scopeId: flag(rest, '--scope', true)!,
        inputFingerprint: flag(rest, '--fingerprint', true)!,
      });
      process.stdout.write(JSON.stringify(row) + '\n');
      return { exitCode: 0 };
    }
    if (sub === 'finish') {
      const row = await finishProcessingReceipt(engine, {
        processorKey: flag(rest, '--key', true)!,
        processorVersion: flag(rest, '--version', true)!,
        scopeId: flag(rest, '--scope', true)!,
        inputFingerprint: flag(rest, '--fingerprint', true)!,
        outcome: flag(rest, '--outcome', true)! as Exclude<ProcessingOutcome, 'running'>,
        inputCount: intFlag(rest, '--input-count'),
        outputCount: intFlag(rest, '--output-count'),
        backlogCount: intFlag(rest, '--backlog-count'),
        reasonCode: flag(rest, '--reason') ?? null,
        lineageKind: flag(rest, '--lineage-kind') ?? null,
        lineageId: flag(rest, '--lineage-id') ?? null,
      });
      process.stdout.write(JSON.stringify(row) + '\n');
      return { exitCode: 0 };
    }
    if (sub === 'list') {
      process.stdout.write(JSON.stringify(await listProcessingRegistrations(engine)) + '\n');
      return { exitCode: 0 };
    }
    if (sub === 'repair') {
      const [action, ...repairArgs] = rest;
      const key = flag(repairArgs, '--key', true)!;
      const registration = (await listProcessingRegistrations(engine))
        .find((row) => row.processor_key === key);
      if (!registration) throw new Error('processor is not registered');
      const repairJob = registration.repair_job_name;
      const supported = repairJob != null && REPAIR_JOB_ALLOWLIST.has(repairJob);
      const plan = {
        processor_key: key,
        runbook: registration.runbook,
        dispatch_supported: supported,
        repair_job: supported ? repairJob : null,
      };
      if (action === 'plan') {
        process.stdout.write(JSON.stringify(plan) + '\n');
        return { exitCode: 0 };
      }
      if (action !== 'dispatch') throw new Error('repair action must be plan or dispatch');
      if (!repairArgs.includes('--yes')) throw new Error('repair dispatch requires --yes');
      if (!supported || !repairJob) throw new Error('registered repair has no supported handler');
      const queue = new MinionQueue(engine);
      const job = await queue.add(
        repairJob,
        { processor_key: key },
        { idempotency_key: `processing-repair:${key}` },
        { allowProtectedSubmit: true },
      );
      await engine.executeRaw(
        `UPDATE processing_receipts SET repair_job_id = $2
          WHERE id = (
            SELECT id FROM processing_receipts
             WHERE processor_key = $1
             ORDER BY COALESCE(finished_at, started_at) DESC, id DESC LIMIT 1
          )`,
        [key, job.id],
      );
      process.stdout.write(JSON.stringify({ ...plan, job_id: job.id }) + '\n');
      return { exitCode: 0 };
    }
    throw new Error(`unknown processing subcommand: ${sub}`);
  } catch (error) {
    process.stderr.write(`gbrain processing: ${(error as Error).message}\n`);
    return { exitCode: 2 };
  }
}
