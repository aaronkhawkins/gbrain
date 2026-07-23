/**
 * Complete identity for vectors stored in the primary text embedding column.
 *
 * v1 signatures (`<provider:model>:<dims>`) did not bind the column or the
 * document-side preprocessing contract. They remain parseable for diagnostics
 * but are intentionally not accepted as proof that a vector space is safe.
 */

export const EMBEDDING_SIGNATURE_VERSION = 2;
export const PRIMARY_EMBEDDING_COLUMN = 'embedding';

export interface EmbeddingProvenance {
  version: typeof EMBEDDING_SIGNATURE_VERSION;
  model: string;
  dimensions: number;
  column: string;
  preprocessing: string;
}

export interface LegacyEmbeddingProvenance {
  version: 1;
  model: string;
  dimensions: number;
  column: null;
  preprocessing: null;
}

export type ParsedEmbeddingProvenance =
  | EmbeddingProvenance
  | LegacyEmbeddingProvenance;

/**
 * Name the document-side preprocessing that created stored vectors.
 * Query-side encoding is deliberately different for asymmetric providers,
 * but compatibility is anchored to how the persisted corpus was encoded.
 */
export function documentPreprocessingSignature(model: string): string {
  if (
    model === 'nvidia:nvidia/nemotron-3-embed-1b'
    || model.startsWith('nvidia-nim:')
    || model.startsWith('nvidia:nvidia/')
  ) {
    return 'text-document-v1;input_type=passage';
  }
  if (
    model.startsWith('zeroentropyai:')
    || model.startsWith('voyage:')
  ) {
    return 'text-document-v1;input_type=document';
  }
  if (model.startsWith('minimax:')) {
    return 'text-document-v1;type=db';
  }
  return 'text-document-v1';
}

export function buildEmbeddingSignature(
  input: Omit<EmbeddingProvenance, 'version'>,
): string {
  return [
    `v${EMBEDDING_SIGNATURE_VERSION}`,
    `model=${encodeURIComponent(input.model)}`,
    `dimensions=${input.dimensions}`,
    `column=${encodeURIComponent(input.column)}`,
    `preprocessing=${encodeURIComponent(input.preprocessing)}`,
  ].join('|');
}

export function parseEmbeddingSignature(
  signature: string,
): ParsedEmbeddingProvenance | null {
  if (signature.startsWith(`v${EMBEDDING_SIGNATURE_VERSION}|`)) {
    const fields = new Map<string, string>();
    for (const part of signature.split('|').slice(1)) {
      const equals = part.indexOf('=');
      if (equals <= 0) return null;
      fields.set(part.slice(0, equals), decodeURIComponent(part.slice(equals + 1)));
    }
    const model = fields.get('model');
    const dimensions = Number(fields.get('dimensions'));
    const column = fields.get('column');
    const preprocessing = fields.get('preprocessing');
    if (
      !model
      || !Number.isInteger(dimensions)
      || dimensions <= 0
      || !column
      || !preprocessing
    ) {
      return null;
    }
    return {
      version: EMBEDDING_SIGNATURE_VERSION,
      model,
      dimensions,
      column,
      preprocessing,
    };
  }

  const separator = signature.lastIndexOf(':');
  if (separator <= 0) return null;
  const model = signature.slice(0, separator);
  const dimensions = Number(signature.slice(separator + 1));
  if (!model || !Number.isInteger(dimensions) || dimensions <= 0) return null;
  return {
    version: 1,
    model,
    dimensions,
    column: null,
    preprocessing: null,
  };
}

export function embeddingModelFromSignature(signature: string): string | undefined {
  return parseEmbeddingSignature(signature)?.model;
}
