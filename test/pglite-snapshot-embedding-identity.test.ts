import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { getPGLiteSchema } from '../src/core/pglite-schema.ts';

describe('PGLite snapshot embedding identity', () => {
  test('schema hash changes with embedding width or model', () => {
    const hash = (dimensions: number, model: string) =>
      computeSnapshotSchemaHash(MIGRATIONS, getPGLiteSchema(dimensions, model), crypto);

    const legacy = hash(1536, 'openai:text-embedding-3-large');
    expect(hash(1280, 'zeroentropyai:zembed-1')).not.toBe(legacy);
    expect(hash(1536, 'another-provider:same-width')).not.toBe(legacy);
  });
});
