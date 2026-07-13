import type { BrainEngine } from './engine.ts';
import type { ChunkInput, Page, PageInput } from './types.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';

/**
 * Opt-in writer for pages produced inside dream phases.
 *
 * `putPage` intentionally remains a low-level page primitive. Dream output,
 * however, is user-facing knowledge and must enter the same deterministic
 * markdown chunk lifecycle as imported pages. Embeddings are deliberately
 * omitted: `upsertChunks` preserves an embedding when text is unchanged and
 * clears it when text changes, allowing the existing bounded stale-embedding
 * worker to perform provider egress later.
 */
export async function putGeneratedSearchablePage(
  engine: BrainEngine,
  slug: string,
  page: PageInput,
  opts?: { sourceId?: string },
): Promise<Page> {
  const chunks = generatedPageChunks(page);
  const sourceId = opts?.sourceId ?? 'default';

  return engine.transaction(async (tx) => {
    const written = await tx.putPage(slug, {
      ...page,
      page_kind: page.page_kind ?? 'markdown',
      chunker_version: MARKDOWN_CHUNKER_VERSION,
    }, { sourceId });

    // upsertChunks([]) removes obsolete chunks. Keeping this in the same
    // transaction as putPage prevents a rewritten page from exposing stale
    // search text after a crash.
    await tx.upsertChunks(slug, chunks, {
      sourceId,
      auditSite: 'upsertChunks',
    });
    return written;
  });
}

export function generatedPageChunks(page: Pick<PageInput, 'compiled_truth' | 'timeline'>): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  appendChunks(chunks, page.compiled_truth, 'compiled_truth');
  appendChunks(chunks, page.timeline ?? '', 'timeline');
  return chunks;
}

function appendChunks(
  target: ChunkInput[],
  text: string,
  source: 'compiled_truth' | 'timeline',
): void {
  if (!text.trim()) return;
  for (const chunk of chunkText(text)) {
    target.push({
      chunk_index: target.length,
      chunk_text: chunk.text,
      chunk_source: source,
      token_count: Math.ceil(chunk.text.length / 4),
      embedding: undefined,
    });
  }
}
