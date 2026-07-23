import type { Page } from '../types.ts';

export const CURATED_SUMMARY_FORMAT = 'curated-summary';

export function isConversationParserEligible(
  page: Pick<Page, 'frontmatter'> | undefined,
): boolean {
  return page?.frontmatter?.format !== CURATED_SUMMARY_FORMAT;
}
