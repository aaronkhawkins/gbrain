import {
  BIRDCLAW_BOOKMARK_KIND,
  BIRDCLAW_INTAKE_ADAPTER,
  BIRDCLAW_RESEARCH_POLICY,
  normalizeResearchProvenance,
} from './research-provenance.ts';

export const EXTRACTABLE_PAGE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original', 'media',
] as const;

export type ExtractionResponsePolicy = 'json' | 'labeled';

export interface ExtractionCandidate {
  type: string;
  frontmatter?: Record<string, unknown> | null;
}

export interface ExtractionAdmission {
  eligible: boolean;
  researchPolicy?: typeof BIRDCLAW_RESEARCH_POLICY;
  repairClass?: 'birdclaw-non-bookmark';
}

/**
 * The one admission policy shared by discovery, backlog and status callers.
 * Ordinary upstream page types retain their existing eligibility. BirdClaw
 * owns only explicitly marked X-bookmark media; its digests/source pages are
 * a repair class, never extraction input.
 */
export function classifyExtractionCandidate(candidate: ExtractionCandidate): ExtractionAdmission {
  if (!EXTRACTABLE_PAGE_TYPES.includes(candidate.type as typeof EXTRACTABLE_PAGE_TYPES[number])) {
    return { eligible: false };
  }
  const atomExtraction = candidate.frontmatter?.atom_extraction;
  if (
    atomExtraction === false ||
    (typeof atomExtraction === 'string' && atomExtraction.toLowerCase() === 'false')
  ) {
    return { eligible: false };
  }
  const facts = normalizeResearchProvenance(candidate.frontmatter);
  const birdclawOwned = facts.intakeAdapter === BIRDCLAW_INTAKE_ADAPTER;
  const researchBookmark = birdclawOwned &&
    candidate.type === 'media' &&
    facts.contentKind === BIRDCLAW_BOOKMARK_KIND &&
    facts.conceptSynthesisCandidate;
  if (researchBookmark) return { eligible: true, researchPolicy: BIRDCLAW_RESEARCH_POLICY };
  if (birdclawOwned) return { eligible: false, repairClass: 'birdclaw-non-bookmark' };
  return { eligible: candidate.type !== 'media' };
}

/** SQL equivalent of classifyExtractionCandidate; keep callers from drifting. */
export function extractionAdmissionSql(alias = 'p'): string {
  return `(
    lower(COALESCE(${alias}.frontmatter->>'atom_extraction', 'true')) <> 'false'
    AND (
      (${alias}.type <> 'media'
        AND COALESCE(${alias}.frontmatter->>'intake_adapter', '') <> '${BIRDCLAW_INTAKE_ADAPTER}')
      OR (
        ${alias}.type = 'media'
        AND ${alias}.frontmatter->>'intake_adapter' = '${BIRDCLAW_INTAKE_ADAPTER}'
        AND ${alias}.frontmatter->>'content_kind' = '${BIRDCLAW_BOOKMARK_KIND}'
        AND lower(COALESCE(${alias}.frontmatter->>'concept_synthesis_candidate', '')) = 'true'
      )
    )
  )`;
}

/** Labeled output is a narrow OpenCode compatibility rule for marked research. */
export function extractionResponsePolicy(researchPolicy: string | undefined, model: string): ExtractionResponsePolicy {
  return researchPolicy === BIRDCLAW_RESEARCH_POLICY && model.startsWith('opencode-server:')
    ? 'labeled'
    : 'json';
}
