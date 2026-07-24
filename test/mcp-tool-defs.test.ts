/**
 * Regression test for the MCP tool-def extraction (v0.16.0 Lane 1A).
 *
 * Before v0.15 the mapping lived inline in src/mcp/server.ts. After the
 * extraction, buildToolDefs is the single source of truth; the subagent tool
 * registry calls it with a filtered OPERATIONS subset. This test pins the
 * extracted output to the pre-extraction shape byte-for-byte so we don't
 * silently drift the MCP-facing tool schema.
 */

import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs, paramDefToSchema } from '../src/mcp/tool-defs.ts';
import type { ParamDef } from '../src/core/operations.ts';

// Reference shape — mirrors the canonical `paramDefToSchema` helper from
// src/mcp/tool-defs.ts. Drift between the helper and this reference fails
// the byte-equality test loudly.
//
// v0.34 update: paramDefToSchema is recursive on `items` so nested
// array-of-arrays preserves the inner shape on the MCP wire. The reference
// below mirrors that recursion. The previous shallow `{ items: { type:
// v.items.type } }` (legacy buildToolDefs) silently dropped nested items
// — explicit fixture assertions below catch the drift class.
//
// `default` is included to match paramDefToSchema; no current op uses
// `default:` at the ParamDef level so the round-trip is unchanged for
// every existing operation, but new ops that add a default get it on the
// wire automatically.
type ParamDefLike = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  const?: unknown;
  default?: unknown;
  items?: ParamDefLike;
  properties?: Record<string, ParamDefLike & { required?: boolean }>;
  oneOf?: ParamDefCompositionLike[];
  not?: ParamDefCompositionLike;
};
type ParamDefCompositionLike = {
  type?: ParamDefLike['type'];
  properties?: Record<string, ParamDefLike>;
  required?: string[];
  oneOf?: ParamDefCompositionLike[];
  not?: ParamDefCompositionLike;
};
function referenceCompositionToSchema(
  composition: ParamDefCompositionLike,
): Record<string, unknown> {
  return {
    ...(composition.type ? { type: composition.type } : {}),
    ...(composition.properties ? {
      properties: Object.fromEntries(
        Object.entries(composition.properties).map(([key, value]) => [
          key,
          referenceParamDefToSchema(value),
        ]),
      ),
    } : {}),
    ...(composition.required ? { required: composition.required } : {}),
    ...(composition.oneOf ? {
      oneOf: composition.oneOf.map(referenceCompositionToSchema),
    } : {}),
    ...(composition.not ? {
      not: referenceCompositionToSchema(composition.not),
    } : {}),
  };
}
function referenceParamDefToSchema(p: ParamDefLike): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.const !== undefined ? { const: p.const } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: referenceParamDefToSchema(p.items) } : {}),
    ...(p.properties ? {
      properties: Object.fromEntries(
        Object.entries(p.properties).map(([key, value]) => [
          key,
          referenceParamDefToSchema(value),
        ]),
      ),
      required: Object.entries(p.properties)
        .filter(([, value]) => value.required)
        .map(([key]) => key),
    } : {}),
    ...(p.oneOf ? {
      oneOf: p.oneOf.map(referenceCompositionToSchema),
    } : {}),
    ...(p.not ? {
      not: referenceCompositionToSchema(p.not),
    } : {}),
  };
}
function legacyInlineMap(ops: typeof operations) {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, referenceParamDefToSchema(v)]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

describe('buildToolDefs', () => {
  test('output equals pre-extraction inline mapping byte-for-byte', () => {
    const extracted = buildToolDefs(operations);
    const inline = legacyInlineMap(operations);
    expect(JSON.stringify(extracted)).toBe(JSON.stringify(inline));
  });

  test('preserves operation count', () => {
    expect(buildToolDefs(operations).length).toBe(operations.length);
  });

  test('accepts an arbitrary Operation subset (for subagent tool registry)', () => {
    const subset = operations.slice(0, 3);
    const defs = buildToolDefs(subset);
    expect(defs.length).toBe(3);
    expect(defs.map(d => d.name)).toEqual(subset.map(o => o.name));
  });

  test('empty input returns empty array', () => {
    expect(buildToolDefs([])).toEqual([]);
  });

  test('every def has object inputSchema with properties + required array', () => {
    for (const def of buildToolDefs(operations)) {
      expect(def.inputSchema.type).toBe('object');
      expect(typeof def.inputSchema.properties).toBe('object');
      expect(Array.isArray(def.inputSchema.required)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural array-items guard (v0.34 fix wave).
//
// JSON Schema strict-mode validators (Gemini Pro strict, OpenAI structured
// outputs) reject `type: 'array'` without `items`. Pre-v0.34 this happened
// in production: `extract_facts.entity_hints` and `handle_to_tweet`'s
// `candidates` both shipped as bare arrays.
//
// This recursive guard walks every tool def's inputSchema and fails the
// suite with a property path if any array lacks `items.type`. Drift-proof
// against future ops adding bare arrays.
// ---------------------------------------------------------------------------

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: SchemaNode[];
  not?: SchemaNode;
  [k: string]: unknown;
}

function matchesSchema(value: unknown, schema: SchemaNode): boolean {
  if (schema.type === 'object' && (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'number' && typeof value !== 'number') return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;

  if (schema.required) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!schema.required.every(key => Object.hasOwn(value, key))) return false;
  }
  if (
    schema.properties &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !matchesSchema(
        (value as Record<string, unknown>)[key],
        child,
      )) return false;
    }
  }
  if (schema.oneOf) {
    if (schema.oneOf.filter(branch => matchesSchema(value, branch)).length !== 1) return false;
  }
  if (schema.not && matchesSchema(value, schema.not)) return false;
  return true;
}

function findArrayWithoutItems(node: SchemaNode, path: string[]): string[] {
  const violations: string[] = [];
  if (node && typeof node === 'object') {
    if (node.type === 'array') {
      if (!node.items || typeof node.items !== 'object') {
        violations.push(`${path.join('.') || '<root>'} (array missing items)`);
      } else if (!('type' in node.items)) {
        violations.push(`${path.join('.') || '<root>'}.items (items missing type)`);
      } else {
        violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
      }
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, child] of Object.entries(node.properties)) {
        violations.push(...findArrayWithoutItems(child as SchemaNode, [...path, k]));
      }
    }
    if (node.items && typeof node.items === 'object' && node.type !== 'array') {
      violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
    }
  }
  return violations;
}

describe('paramDefToSchema structural guard', () => {
  test('every operation inputSchema array has items.type set (no bare arrays)', () => {
    const allViolations: string[] = [];
    for (const def of buildToolDefs(operations)) {
      const v = findArrayWithoutItems(def.inputSchema as SchemaNode, [def.name]);
      allViolations.push(...v);
    }
    expect(allViolations).toEqual([]);
  });

  test('extract_facts.entity_hints declares items.type as string', () => {
    const def = buildToolDefs(operations).find(d => d.name === 'extract_facts');
    expect(def).toBeDefined();
    const eh = (def!.inputSchema.properties as Record<string, SchemaNode>).entity_hints;
    expect(eh.type).toBe('array');
    expect(eh.items).toBeDefined();
    expect((eh.items as SchemaNode).type).toBe('string');
  });

  test('paramDefToSchema recursively propagates nested items.items.type', () => {
    // Synthetic ParamDef: array-of-arrays-of-strings. No current op uses
    // this shape, so this test pins the contract for future ops and proves
    // the helper recurses (closes the v0.32 nested-drop bug class).
    const nested: ParamDef = {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    };
    const schema = paramDefToSchema(nested) as SchemaNode;
    expect(schema.type).toBe('array');
    expect((schema.items as SchemaNode).type).toBe('array');
    expect(((schema.items as SchemaNode).items as SchemaNode).type).toBe('string');
  });

  test('paramDefToSchema preserves description on nested items', () => {
    const p: ParamDef = {
      type: 'array',
      description: 'outer',
      items: {
        type: 'string',
        description: 'inner',
      },
    };
    const schema = paramDefToSchema(p) as SchemaNode;
    expect(schema.description).toBe('outer');
    expect((schema.items as SchemaNode).description).toBe('inner');
  });

  test('paramDefToSchema recursively maps object properties and required fields', () => {
    const p: ParamDef = {
      type: 'object',
      properties: {
        version: { type: 'string', const: 'v1', required: true },
        mode: { type: 'string', enum: ['one', 'two'] },
        nested: {
          type: 'object',
          required: true,
          properties: {
            enabled: { type: 'boolean', required: true },
          },
        },
      },
    };

    expect(paramDefToSchema(p)).toEqual({
      type: 'object',
      properties: {
        version: { type: 'string', const: 'v1' },
        mode: { type: 'string', enum: ['one', 'two'] },
        nested: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
          required: ['enabled'],
        },
      },
      required: ['version', 'nested'],
    });
  });

  test('submit_native_intake publishes the complete NativeIntakeEnvelope v1 schema', () => {
    const def = buildToolDefs(operations).find(d => d.name === 'submit_native_intake');
    expect(def).toBeDefined();

    expect(def!.inputSchema.properties.envelope).toEqual({
      type: 'object',
      description: 'Versioned NativeIntakeEnvelope payload',
      properties: {
        api_version: { type: 'string', const: 'gbrain-native-intake-v1' },
        brain_id: { type: 'string' },
        source_id: { type: 'string' },
        target_source_id: { type: 'string' },
        source_kind: { type: 'string' },
        source_uri: { type: 'string' },
        received_at: { type: 'string' },
        source_created_at: { type: 'string' },
        content_type: {
          type: 'string',
          enum: [
            'text/markdown',
            'text/plain',
            'text/html',
            'application/pdf',
            'application/json',
            'image/*',
            'audio/*',
            'video/*',
            'unknown',
          ],
        },
        content: { type: 'string' },
        content_hash: { type: 'string' },
        external_id: { type: 'string' },
        posture: {
          type: 'string',
          enum: ['canonical', 'inbox', 'research', 'session-evidence'],
        },
        promotion_boundary: {
          type: 'object',
          properties: {
            target_posture: { type: 'string', const: 'canonical' },
            authority: { type: 'string', enum: ['operator', 'policy'] },
            policy_id: { type: 'string' },
          },
          required: ['target_posture', 'authority'],
          oneOf: [
            {
              properties: {
                authority: { type: 'string', const: 'policy' },
              },
              required: ['policy_id'],
            },
            {
              properties: {
                authority: { type: 'string', const: 'operator' },
              },
              not: { required: ['policy_id'] },
            },
          ],
        },
        idempotency_key: { type: 'string' },
        untrusted_payload: { type: 'boolean' },
        metadata: { type: 'object' },
      },
      required: [
        'api_version',
        'brain_id',
        'source_id',
        'target_source_id',
        'source_kind',
        'source_uri',
        'received_at',
        'content_type',
        'content',
        'content_hash',
        'external_id',
        'posture',
        'idempotency_key',
      ],
      oneOf: [
        {
          properties: {
            posture: { type: 'string', const: 'canonical' },
          },
          not: { required: ['promotion_boundary'] },
        },
        {
          properties: {
            posture: {
              type: 'string',
              enum: ['inbox', 'research', 'session-evidence'],
            },
          },
          required: ['promotion_boundary'],
        },
      ],
    });
  });

  test('submit_native_intake schema enforces posture and authority combinations', () => {
    const def = buildToolDefs(operations).find(d => d.name === 'submit_native_intake');
    const envelope = def!.inputSchema.properties.envelope as SchemaNode;
    const base = {
      api_version: 'gbrain-native-intake-v1',
      brain_id: 'brain',
      source_id: 'producer',
      target_source_id: 'target',
      source_kind: 'test',
      source_uri: 'test://item',
      received_at: '2026-07-23T00:00:00.000Z',
      content_type: 'text/plain',
      content: 'content',
      content_hash: 'hash',
      external_id: 'item',
      idempotency_key: 'item',
    };
    const policyBoundary = {
      target_posture: 'canonical',
      authority: 'policy',
      policy_id: 'reviewed-evidence',
    };
    const operatorBoundary = {
      target_posture: 'canonical',
      authority: 'operator',
    };

    for (const posture of ['inbox', 'research', 'session-evidence']) {
      expect(matchesSchema(
        { ...base, posture, promotion_boundary: policyBoundary },
        envelope,
      )).toBe(true);
      expect(matchesSchema(
        { ...base, posture, promotion_boundary: operatorBoundary },
        envelope,
      )).toBe(true);
      expect(matchesSchema({ ...base, posture }, envelope)).toBe(false);
    }

    expect(matchesSchema({ ...base, posture: 'canonical' }, envelope)).toBe(true);
    expect(matchesSchema({
      ...base,
      posture: 'canonical',
      promotion_boundary: operatorBoundary,
    }, envelope)).toBe(false);
    expect(matchesSchema({
      ...base,
      posture: 'research',
      promotion_boundary: {
        target_posture: 'canonical',
        authority: 'policy',
      },
    }, envelope)).toBe(false);
    expect(matchesSchema({
      ...base,
      posture: 'research',
      promotion_boundary: {
        ...operatorBoundary,
        policy_id: 'not-applicable',
      },
    }, envelope)).toBe(false);
  });
});
