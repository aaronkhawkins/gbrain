# Quality Convention

Cross-cutting quality rules for all brain-writing skills.

## Citations (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

A citation has two responsibilities: **identity** and **navigation**. Naming a
database row, message ID, document node, filename, or hash is not enough when a
deterministic route to the underlying source exists. The reader must be able to
follow the citation back to a brain source record or authoritative source
system without reconstructing a command by hand.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)`
- **Synthesis:** `[Source: compiled from {sources}]`

### Navigable provenance (MANDATORY when available)

- **Brain pages:** use vault-root wikilinks such as
  `[[sources/docbank/vault/document-42|Contract]]`. Do not write
  `[Contract](sources/...)` from nested notes; Markdown resolves it relative to
  the current directory in Obsidian.
- **Web sources:** link the canonical URL directly.
- **Source systems with local bridges:** include the deterministic action URI
  supplied by that integration plus a link to its brain source record.
- **Email/message archives:** link the raw message action when the archive
  exposes a stable message ID. Do not copy the raw body into the brain merely
  to make it navigable.
- **Versioned documents:** open the cited immutable version, not silently the
  current version.
- **Unavailable navigation:** retain the identity citation and explicitly mark
  `navigation unavailable`; never guess a URL or identifier.

An identity-only citation with an available deterministic source route is a
broken citation.

### Source precedence (highest to lowest)

1. User's direct statements (highest authority)
2. Compiled truth (brain's synthesized understanding)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search)

## Back-Linking (MANDATORY)

Every mention of a person or company WITH a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them.

Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- context`

An unlinked mention is a broken brain.

## Notability Gate

Before creating a new brain page, check notability:

- **People:** Will you interact again? Relevant to work/interests?
- **Companies:** Relevant to work/investments/interests?
- **Concepts:** Reusable mental model? Worth referencing again?

When in doubt, DON'T create. A 400-follower person who tweeted once is not notable.
