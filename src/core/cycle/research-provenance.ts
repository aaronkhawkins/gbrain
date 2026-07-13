/** Pure normalization for the bookmark-research provenance boundary. */

export const BIRDCLAW_INTAKE_ADAPTER = 'birdclaw-bookmarks-to-brain';
export const BIRDCLAW_BOOKMARK_KIND = 'x-bookmark';
export const BIRDCLAW_RESEARCH_POLICY = 'birdclaw-research-v1';

export interface ResearchProvenanceFacts {
  intakeAdapter?: string;
  contentKind?: string;
  conceptSynthesisCandidate: boolean;
  researchPolicy?: string;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizedTrue(value: unknown): boolean {
  return value === true || normalizedString(value) === 'true';
}

export function normalizeResearchProvenance(
  frontmatter: Record<string, unknown> | null | undefined,
): ResearchProvenanceFacts {
  return {
    intakeAdapter: normalizedString(frontmatter?.intake_adapter),
    contentKind: normalizedString(frontmatter?.content_kind),
    conceptSynthesisCandidate: normalizedTrue(frontmatter?.concept_synthesis_candidate),
    researchPolicy: normalizedString(frontmatter?.research_policy),
  };
}

export function hasResearchPolicy(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return normalizeResearchProvenance(frontmatter).researchPolicy === BIRDCLAW_RESEARCH_POLICY;
}
