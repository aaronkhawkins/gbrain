import {
  BIRDCLAW_BOOKMARK_KIND,
  BIRDCLAW_INTAKE_ADAPTER,
  BIRDCLAW_RESEARCH_POLICY,
  normalizeResearchProvenance,
} from './research-provenance.ts';

export const EXTRACTABLE_PAGE_TYPES = [
  'meeting', 'source', 'article', 'video', 'book', 'original', 'media',
] as const;

export interface ExtractionCandidate {
  type: string;
  frontmatter?: Record<string, unknown> | null;
}

export interface ExtractionAdmission {
  eligible: boolean;
  researchPolicy?: typeof BIRDCLAW_RESEARCH_POLICY;
  repairClass?: 'birdclaw-non-bookmark';
}

export const BIRDCLAW_RESEARCH_ENABLED_KEY = 'research.birdclaw.enabled';

/** Read the brain-local opt-out in the same query as candidate discovery. */
export function birdclawResearchEnabledSql(): string {
  return `lower(trim(COALESCE((SELECT value FROM config WHERE key = '${BIRDCLAW_RESEARCH_ENABLED_KEY}'), 'true'))) <> 'false'`;
}

/**
 * The one admission policy shared by discovery, backlog and status callers.
 * Ordinary upstream page types retain their existing eligibility. BirdClaw
 * owns only explicitly marked X-bookmark media; its digests/source pages are
 * a repair class, never extraction input.
 */
export function classifyExtractionCandidate(candidate: ExtractionCandidate, birdclawEnabled = true): ExtractionAdmission {
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
  if (birdclawOwned && !birdclawEnabled) return { eligible: false };
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
        AND ${birdclawResearchEnabledSql()}
        AND ${alias}.frontmatter->>'intake_adapter' = '${BIRDCLAW_INTAKE_ADAPTER}'
        AND ${alias}.frontmatter->>'content_kind' = '${BIRDCLAW_BOOKMARK_KIND}'
        AND lower(COALESCE(${alias}.frontmatter->>'concept_synthesis_candidate', '')) = 'true'
      )
    )
  )`;
}
