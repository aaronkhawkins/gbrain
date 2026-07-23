import type { BrainEngine } from './engine.ts';
import type { ChunkInput, Page, PageInput } from './types.ts';
import { chunkText } from './chunkers/recursive.ts';
import { serializeMarkdown } from './markdown.ts';
import {
  readGeneratedOutputDigest,
  resolveGeneratedOutputPath,
  writeGeneratedOutput,
} from './generated-output-writer.ts';

/**
 * Compatibility adapter for pre-U6 callers. The authoritative writer is now
 * generated-output-writer; this module no longer has a DB-writing path.
 */
export async function putGeneratedSearchablePage(
  engine: BrainEngine,
  slug: string,
  page: PageInput,
  opts?: { sourceId?: string; brainDir?: string },
): Promise<Page> {
  const sourceId = opts?.sourceId ?? 'default';
  const markdown = serializeMarkdown(
    page.frontmatter ?? {},
    page.compiled_truth,
    page.timeline ?? '',
    { type: page.type, title: page.title, tags: [] },
  );
  const path = await resolveGeneratedOutputPath(engine, slug, {
    sourceId,
    brainDir: opts?.brainDir,
  });
  const result = await writeGeneratedOutput(engine, slug, markdown, {
    sourceId,
    brainDir: opts?.brainDir,
    expectedDigest: readGeneratedOutputDigest(path),
    noEmbed: true,
  });
  if (result.status === 'conflict' || result.status === 'file_only') {
    throw new Error(result.error ?? `generated output ${result.status}`);
  }
  const written = await engine.getPage(slug, { sourceId });
  if (!written) throw new Error(`generated output projection missing: ${sourceId}/${slug}`);
  return written;
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
