/**
 * Retrieval component evidence — embedding identity gate (not semantic canary).
 * Phase 1C owns end-to-end retrieval proof; Phase 1A only reports identity.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { unavailableEvidence } from './helpers.ts';

export async function collectRetrievalEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();

  if (opts.config?.embedding_disabled === true) {
    for (const e of entries) {
      out.set(e.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: null,
        oldest_pending_age_seconds: null,
        recent_failures: null,
        force_state: 'disabled',
        force_reason: 'embedding_disabled',
      });
    }
    return out;
  }

  if (!engine) {
    for (const e of entries) out.set(e.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  if (!opts.config) {
    for (const e of entries) out.set(e.key, unavailableEvidence('evidence_unavailable'));
    return out;
  }

  try {
    const { resolveEmbeddingColumn } = await import('../../search/embedding-column.ts');
    const { inspectEmbeddingIdentity } = await import('../../search/embedding-identity.ts');
    const resolved = resolveEmbeddingColumn(undefined, opts.config);
    const diag = await inspectEmbeddingIdentity(engine, resolved);
    const nowIso = opts.now.toISOString();

    for (const e of entries) {
      if (diag.status === 'incompatible') {
        out.set(e.key, {
          last_attempt_at: nowIso,
          last_success_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: diag.disagreements.length,
          force_state: 'failed',
          force_reason: 'embedding_mismatch',
        });
      } else if (diag.status === 'empty' || diag.status === 'unselected') {
        out.set(e.key, {
          last_attempt_at: nowIso,
          last_success_at: null,
          backlog_items: diag.observed.embeddedChunks === 0 ? 1 : 0,
          oldest_pending_age_seconds: null,
          recent_failures: 0,
          force_state: 'unknown',
          force_reason: 'evidence_unavailable',
        });
      } else if (diag.status === 'unknown') {
        out.set(e.key, {
          last_attempt_at: nowIso,
          last_success_at: null,
          backlog_items: null,
          oldest_pending_age_seconds: null,
          recent_failures: 0,
          force_state: 'unknown',
          force_reason: 'evidence_unavailable',
        });
      } else {
        out.set(e.key, {
          last_attempt_at: nowIso,
          last_success_at: nowIso,
          backlog_items: 0,
          oldest_pending_age_seconds: null,
          recent_failures: 0,
          force_state: 'healthy',
          force_reason: 'ok',
        });
      }
    }
  } catch {
    for (const e of entries) out.set(e.key, unavailableEvidence('evidence_unavailable'));
  }

  return out;
}
