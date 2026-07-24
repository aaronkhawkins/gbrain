import type {
  Operation,
  ParamDef,
  ParamDefComposition,
} from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Convert a single ParamDef to a JSON Schema fragment. Recursive on `items`.
 *
 * Single source of truth for ParamDef→JSON Schema mapping. Consumed by:
 * - buildToolDefs (stdio MCP server.ts via tool-defs.ts)
 * - serve-http.ts tools/list handler (HTTP MCP path)
 * - brain-allowlist.ts paramsToInputSchema (subagent tool registry)
 *
 * The three call sites previously each had their own inline destructure that
 * drifted from each other (live HTTP MCP path dropped `items` entirely in
 * v0.32 PR review). Centralizing here closes the bug class at the
 * architecture level instead of patching one site at a time.
 *
 * Key ordering (type, description, enum, const, default, items, properties,
 * required, oneOf, not) is intentional —
 * matches the pre-v0.34 inline mappers so JSON.stringify output stays
 * byte-stable for ParamDefs that do not use the additive object-contract
 * fields.
 */
function paramDefCompositionToSchema(
  composition: ParamDefComposition,
): Record<string, unknown> {
  return {
    ...(composition.type ? { type: composition.type } : {}),
    ...(composition.properties ? {
      properties: Object.fromEntries(
        Object.entries(composition.properties).map(([key, value]) => [
          key,
          paramDefToSchema(value),
        ]),
      ),
    } : {}),
    ...(composition.required ? { required: composition.required } : {}),
    ...(composition.oneOf ? {
      oneOf: composition.oneOf.map(paramDefCompositionToSchema),
    } : {}),
    ...(composition.not ? {
      not: paramDefCompositionToSchema(composition.not),
    } : {}),
  };
}

export function paramDefToSchema(p: ParamDef): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.const !== undefined ? { const: p.const } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: paramDefToSchema(p.items) } : {}),
    ...(p.properties ? {
      properties: Object.fromEntries(
        Object.entries(p.properties).map(([key, value]) => [
          key,
          paramDefToSchema(value),
        ]),
      ),
      required: Object.entries(p.properties)
        .filter(([, value]) => value.required)
        .map(([key]) => key),
    } : {}),
    ...(p.oneOf ? {
      oneOf: p.oneOf.map(paramDefCompositionToSchema),
    } : {}),
    ...(p.not ? {
      not: paramDefCompositionToSchema(p.not),
    } : {}),
  };
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}
