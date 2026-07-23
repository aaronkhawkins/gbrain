/**
 * Generic link-extraction backlog evidence using the engine-owned watermark.
 */

import type { BrainEngine } from '../../engine.ts';
import type { ExpectedWorkEntry, WorkEvidence } from '../types.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../link-extraction.ts';
import type { CollectorOpts } from './index.ts';
import {
  finiteNumber,
  sourceIdsForScope,
  unavailableEvidence,
} from './helpers.ts';

interface CountRow {
  source_id: string;
  count: number | string;
}

export async function collectLinkEvidence(
  entries: ExpectedWorkEntry[],
  engine: BrainEngine | null,
  opts: CollectorOpts,
): Promise<Map<string, WorkEvidence | null>> {
  const out = new Map<string, WorkEvidence | null>();
  if (!engine) {
    for (const entry of entries) out.set(entry.key, unavailableEvidence('db_unreachable'));
    return out;
  }

  const sourceGrant = sourceIdsForScope(opts);
  const allowed = sourceGrant ? new Set(sourceGrant) : null;
  const scopedEntries = allowed
    ? entries.filter((entry) => allowed.has(entry.selector))
    : entries;
  for (const entry of entries) {
    if (!scopedEntries.includes(entry)) {
      out.set(entry.key, unavailableEvidence('evidence_unavailable'));
    }
  }
  if (scopedEntries.length === 0) return out;

  const sourceIds = [...new Set(scopedEntries.map((entry) => entry.selector))];
  try {
    const rows = await engine.executeRaw<CountRow>(
      `SELECT source_id, COUNT(*)::int AS count
         FROM pages
        WHERE source_id = ANY($1::text[])
          AND deleted_at IS NULL
          AND (
            links_extracted_at IS NULL
            OR links_extracted_at < $2::timestamptz
            OR updated_at > links_extracted_at
          )
        GROUP BY source_id`,
      [sourceIds, LINK_EXTRACTOR_VERSION_TS],
    );
    const counts = new Map(rows.map((row) => [row.source_id, finiteNumber(row.count)]));
    for (const entry of scopedEntries) {
      out.set(entry.key, backlogEvidence(counts.get(entry.selector) ?? 0));
    }
    return out;
  } catch {
    // Fall through to isolated reads so one bad source can remain unknown
    // without discarding healthy evidence from its siblings.
  }

  for (const entry of scopedEntries) {
    try {
      const backlog = typeof engine.countStalePagesForExtraction === 'function'
        ? await engine.countStalePagesForExtraction({
          sourceId: entry.selector,
          versionTs: LINK_EXTRACTOR_VERSION_TS,
        })
        : finiteNumber((await engine.executeRaw<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count
             FROM pages
            WHERE source_id = $1
              AND deleted_at IS NULL
              AND (
                links_extracted_at IS NULL
                OR links_extracted_at < $2::timestamptz
                OR updated_at > links_extracted_at
              )`,
          [entry.selector, LINK_EXTRACTOR_VERSION_TS],
        ))[0]?.count);
      out.set(entry.key, backlogEvidence(backlog));
    } catch {
      out.set(entry.key, unavailableEvidence('evidence_unavailable'));
    }
  }
  return out;
}

function backlogEvidence(backlog: number): WorkEvidence {
  return {
    last_attempt_at: null,
    last_success_at: null,
    backlog_items: backlog,
    oldest_pending_age_seconds: null,
    recent_failures: 0,
  };
}
