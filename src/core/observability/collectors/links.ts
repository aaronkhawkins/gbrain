/**
 * Generic link-extraction backlog evidence using the engine-owned watermark.
 */

import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../link-extraction.ts';

export async function collectLinkEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  _opts: { config?: GBrainConfig | null; now: Date },
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) out.set(entry.key, unknownEvidence('db_unreachable'));
    return out;
  }

  for (const entry of entries) {
    try {
      const backlog = await engine.countStalePagesForExtraction({
        sourceId: entry.selector,
        versionTs: LINK_EXTRACTOR_VERSION_TS,
      });
      out.set(entry.key, {
        last_attempt_at: null,
        last_success_at: null,
        backlog_items: backlog,
        oldest_pending_age_seconds: null,
        recent_failures: 0,
      });
    } catch {
      out.set(entry.key, unknownEvidence('evidence_unavailable'));
    }
  }
  return out;
}

function unknownEvidence(
  reason: 'db_unreachable' | 'evidence_unavailable',
): WorkEvidence {
  return {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: null,
    oldest_pending_age_seconds: null,
    recent_failures: null,
    force_state: 'unknown',
    force_reason: reason,
  };
}
