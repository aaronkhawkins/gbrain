import type { BrainEngine } from './engine.ts';
import { extractionAdmissionSql } from './cycle/bookmark-extraction-policy.ts';
import {
  BIRDCLAW_INTAKE_ADAPTER,
  BIRDCLAW_RESEARCH_POLICY,
} from './cycle/research-provenance.ts';

export interface ResearchSourceHealth {
  source_id: string;
  eligible_bookmarks: number;
  backlog: number;
  native_atoms: number;
  native_concepts: number;
  legacy_pages: number;
  newest_bookmark_at: string | null;
  newest_native_at: string | null;
  recent_failures_24h: number;
}

export interface ResearchHealth {
  policy: typeof BIRDCLAW_RESEARCH_POLICY;
  intake_adapter: typeof BIRDCLAW_INTAKE_ADAPTER;
  generated_at: string;
  sources: ResearchSourceHealth[];
  totals: Omit<ResearchSourceHealth, 'source_id' | 'newest_bookmark_at' | 'newest_native_at'>;
  newest_bookmark_at: string | null;
  newest_native_at: string | null;
}

type AggregateRow = {
  source_id: string;
  eligible_bookmarks: string | number;
  backlog: string | number;
  native_atoms: string | number;
  native_concepts: string | number;
  legacy_pages: string | number;
  newest_bookmark_at: string | Date | null;
  newest_native_at: string | Date | null;
  recent_failures_24h: string | number;
};

const asNumber = (value: string | number): number => Number(value) || 0;
const asIso = (value: string | Date | null): string | null =>
  value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;

/**
 * Read-only, aggregate-only research health. The optional source list is
 * applied to every CTE and is the source-isolation boundary for remote callers.
 */
export async function collectResearchHealth(
  engine: BrainEngine,
  sourceIds?: string[],
): Promise<ResearchHealth> {
  const scoped = Array.isArray(sourceIds);
  const scope = scoped ? 'AND p.source_id = ANY($1::text[])' : '';
  const jobSource = "CASE WHEN j.name = 'extract-atoms-drain' THEN j.data->>'sourceId' ELSE j.data->>'source_id' END";
  const jobScope = scoped ? `AND COALESCE(${jobSource}, '') = ANY($1::text[])` : '';
  const rows = await engine.executeRaw<AggregateRow>(
    `WITH eligible AS (
       SELECT p.source_id, p.content_hash, p.updated_at
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND p.type = 'media'
          AND ${extractionAdmissionSql('p')}
          ${scope}
     ), eligible_counts AS (
       SELECT e.source_id,
              COUNT(DISTINCT e.content_hash)::text AS eligible_bookmarks,
              COUNT(DISTINCT e.content_hash) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM pages a
                 WHERE a.source_id = e.source_id AND a.type = 'atom' AND a.deleted_at IS NULL
                   AND a.frontmatter->>'source_hash' = substring(e.content_hash from 1 for 16)
              ))::text AS backlog,
              MAX(e.updated_at) AS newest_bookmark_at
         FROM eligible e
        GROUP BY e.source_id
     ), native AS (
       SELECT p.source_id, p.type, p.updated_at
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND p.frontmatter->>'research_policy' = '${BIRDCLAW_RESEARCH_POLICY}'
          ${scope}
     ), native_counts AS (
       SELECT n.source_id,
              COUNT(*) FILTER (WHERE n.type = 'atom')::text AS native_atoms,
              COUNT(*) FILTER (WHERE n.type = 'concept')::text AS native_concepts,
              MAX(n.updated_at) AS newest_native_at
         FROM native n
        GROUP BY n.source_id
     ), legacy AS (
       SELECT p.source_id, COUNT(*)::text AS count
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND p.frontmatter->>'generated_by' = 'research-wiki-v1'
          ${scope}
        GROUP BY p.source_id
     ), failures AS (
       SELECT COALESCE(${jobSource}, 'default') AS source_id,
              COUNT(*)::text AS count
         FROM minion_jobs j
        WHERE j.status IN ('failed', 'dead')
          AND j.created_at >= NOW() - INTERVAL '24 hours'
          AND j.name IN ('autopilot-cycle', 'extract-atoms-drain')
          ${jobScope}
        GROUP BY COALESCE(${jobSource}, 'default')
     ), source_ids AS (
       SELECT source_id FROM eligible_counts
       UNION SELECT source_id FROM native_counts
       UNION SELECT source_id FROM legacy
       UNION SELECT source_id FROM failures
     )
     SELECT s.source_id,
            COALESCE(e.eligible_bookmarks, '0') AS eligible_bookmarks,
            COALESCE(e.backlog, '0') AS backlog,
            COALESCE(n.native_atoms, '0') AS native_atoms,
            COALESCE(n.native_concepts, '0') AS native_concepts,
            COALESCE(l.count, '0') AS legacy_pages,
            e.newest_bookmark_at,
            n.newest_native_at,
            COALESCE(f.count, '0') AS recent_failures_24h
       FROM source_ids s
       LEFT JOIN eligible_counts e ON e.source_id = s.source_id
       LEFT JOIN native_counts n ON n.source_id = s.source_id
       LEFT JOIN legacy l ON l.source_id = s.source_id
       LEFT JOIN failures f ON f.source_id = s.source_id
      ORDER BY s.source_id`,
    scoped ? [sourceIds] : [],
  );

  const sources = rows.map((row) => ({
    source_id: row.source_id,
    eligible_bookmarks: asNumber(row.eligible_bookmarks),
    backlog: asNumber(row.backlog),
    native_atoms: asNumber(row.native_atoms),
    native_concepts: asNumber(row.native_concepts),
    legacy_pages: asNumber(row.legacy_pages),
    newest_bookmark_at: asIso(row.newest_bookmark_at),
    newest_native_at: asIso(row.newest_native_at),
    recent_failures_24h: asNumber(row.recent_failures_24h),
  }));
  const total = (key: keyof Pick<ResearchSourceHealth, 'eligible_bookmarks' | 'backlog' | 'native_atoms' | 'native_concepts' | 'legacy_pages' | 'recent_failures_24h'>) =>
    sources.reduce((sum, row) => sum + row[key], 0);
  const newest = (key: 'newest_bookmark_at' | 'newest_native_at') =>
    sources.map((row) => row[key]).filter((v): v is string => v !== null).sort().at(-1) ?? null;

  return {
    policy: BIRDCLAW_RESEARCH_POLICY,
    intake_adapter: BIRDCLAW_INTAKE_ADAPTER,
    generated_at: new Date().toISOString(),
    sources,
    totals: {
      eligible_bookmarks: total('eligible_bookmarks'),
      backlog: total('backlog'),
      native_atoms: total('native_atoms'),
      native_concepts: total('native_concepts'),
      legacy_pages: total('legacy_pages'),
      recent_failures_24h: total('recent_failures_24h'),
    },
    newest_bookmark_at: newest('newest_bookmark_at'),
    newest_native_at: newest('newest_native_at'),
  };
}
