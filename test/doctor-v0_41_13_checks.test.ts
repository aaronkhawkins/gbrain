/**
 * v0.41.16.0 — Targeted assertions for the 3 new doctor checks.
 *
 * Spawns `bun src/cli.ts doctor --json --fast` as a subprocess and
 * parses the JSON envelope to verify:
 *
 *   - conversation_format_coverage
 *   - progressive_batch_audit_health
 *   - conversation_parser_probe_health
 *
 * are present with stable shapes. The full doctor surface is covered
 * by test/doctor.test.ts; this file is a structural regression guard
 * for the 3 new v0.41.16.0 checks.
 *
 * Spawning the subprocess matches the actual user experience (`gbrain
 * doctor`) and avoids the in-process env/stdout-capture brittleness
 * that bit the original test draft.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import { computeConversationFormatCoverageCheck } from '../src/commands/doctor.ts';

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}
interface DoctorEnvelope {
  schema_version: number;
  status: 'healthy' | 'unhealthy';
  health_score: number;
  checks: DoctorCheck[];
}

function runDoctor(): DoctorEnvelope {
  const result = spawnSync(
    process.execPath, // bun
    ['src/cli.ts', 'doctor', '--json', '--fast'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  if (result.error) throw result.error;
  // Doctor's JSON envelope is the LAST line in stdout (CLI may print
  // banners on stderr; --json sends the envelope to stdout).
  const stdout = result.stdout ?? '';
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const jsonLine = lines.reverse().find((l) => l.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error(
      `No JSON envelope found in doctor output. stdout=${stdout.slice(0, 500)} stderr=${(result.stderr ?? '').slice(0, 500)}`,
    );
  }
  return JSON.parse(jsonLine) as DoctorEnvelope;
}

describe('doctor — v0.41.16.0 new checks emit', () => {
  test('all 3 new checks present in JSON envelope', () => {
    const env = runDoctor();
    const checkNames = env.checks.map((c) => c.name);
    // conversation_format_coverage may not appear in --fast mode (it
    // requires DB access); progressive_batch_audit_health and
    // conversation_parser_probe_health do not need DB.
    expect(checkNames).toContain('progressive_batch_audit_health');
    expect(checkNames).toContain('conversation_parser_probe_health');
  });

  test('progressive_batch_audit_health shape', () => {
    const env = runDoctor();
    const check = env.checks.find(
      (c) => c.name === 'progressive_batch_audit_health',
    );
    expect(check).toBeDefined();
    expect(['ok', 'warn', 'fail']).toContain(check!.status);
    expect(typeof check!.message).toBe('string');
    expect(check!.message.length).toBeGreaterThan(0);
  });

  test('conversation_parser_probe_health shape + opt-in hint', () => {
    const env = runDoctor();
    const check = env.checks.find(
      (c) => c.name === 'conversation_parser_probe_health',
    );
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('opt-in');
    expect(check!.message).toContain(
      'autopilot.conversation_parser_probe.enabled true',
    );
  });

  test('schema_version is stable (2 at v0.41.16.0)', () => {
    const env = runDoctor();
    expect(env.schema_version).toBe(2);
  });
});

function coveragePage(
  slug: string,
  body: string,
  frontmatter: Record<string, unknown> = {},
  type: Page['type'] = 'conversation',
): Page {
  return {
    id: 1,
    slug,
    type,
    title: slug,
    compiled_truth: body,
    timeline: '',
    frontmatter,
    created_at: new Date(),
    updated_at: new Date(),
  } as Page;
}

describe('conversation_format_coverage eligibility', () => {
  test('excludes curated summaries while retaining actionable raw misses', async () => {
    const pages = [
      coveragePage(
        'conversations/curated',
        '**Alice** (2024-03-15 9:00 AM): this would parse',
        { format: 'curated-summary' },
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        coveragePage(`conversations/raw-miss-${i + 1}`, 'unknown raw turn layout')),
      coveragePage(
        'conversations/raw-hit',
        '**Alice** (2024-03-15 9:00 AM): hello',
      ),
    ];
    const engine = {
      listPages: async ({ type }: { type?: string }) =>
        type === 'conversation' ? pages : [],
    } as unknown as BrainEngine;

    const check = await computeConversationFormatCoverageCheck(engine);

    expect(check.status).toBe('warn');
    expect(check.message).toContain('7/8 conversation pages');
    expect(check.message).not.toContain('conversations/curated');
    expect(check.message).toContain('conversations/raw-miss-1');
    expect(check.message).toContain('conversations/raw-miss-5');
    expect(check.message).not.toContain('conversations/raw-miss-6');
    expect(check.message).toContain('(+2 more)');
  });

  test('reports not applicable when every sampled page opts out', async () => {
    const engine = {
      listPages: async ({ type }: { type?: string }) =>
        type === 'conversation'
          ? [coveragePage('conversations/curated', 'summary', { format: 'curated-summary' })]
          : [],
    } as unknown as BrainEngine;

    const check = await computeConversationFormatCoverageCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No eligible conversation-type pages');
  });

  test('samples later conversation types when earlier types fill their 50-page caps', async () => {
    const types = [
      'conversation',
      'meeting',
      'slack',
      'email',
      'imessage',
      'imessage-daily',
    ] as const;
    const pagesByType = new Map<string, Page[]>(
      types.map((type, typeIndex) => [
        type,
        Array.from({ length: 50 }, (_, pageIndex) => {
          const isLaterType = typeIndex >= 4;
          return coveragePage(
            `${type}/page-${pageIndex + 1}`,
            isLaterType
              ? 'unknown raw turn layout'
              : '**Alice** (2024-03-15 9:00 AM): hello',
            {},
            type,
          );
        }),
      ]),
    );
    const engine = {
      listPages: async ({ type, limit }: { type?: string; limit?: number }) =>
        (pagesByType.get(type ?? '') ?? []).slice(0, limit),
    } as unknown as BrainEngine;

    const check = await computeConversationFormatCoverageCheck(engine);

    expect(check.status).toBe('warn');
    expect(check.message).toContain('66/200 conversation pages');
    expect(check.message).toContain('imessage/page-1');
    expect(check.message).toContain('imessage-daily/page-1');
  });
});
