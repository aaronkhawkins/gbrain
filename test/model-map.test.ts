import { describe, expect, test } from 'bun:test';
import {
  getClaudeModelMapping,
  listClaudeModelMappings,
  resolveCopilotClaudeModel,
} from '../src/core/llm/model-map.ts';

describe('claude model map', () => {
  test('maps current runtime haiku model to copilot haiku 4.5', () => {
    expect(resolveCopilotClaudeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    expect(getClaudeModelMapping('claude-haiku-4-5-20251001').equivalence).toBe('versionless-alias');
  });

  test('maps benchmark and eval models without tier drift', () => {
    expect(resolveCopilotClaudeModel('claude-haiku-4-5')).toBe('claude-haiku-4.5');
    expect(resolveCopilotClaudeModel('claude-opus-4-5')).toBe('claude-opus-4.5');
    expect(resolveCopilotClaudeModel('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  test('tracks all supported mappings in one place', () => {
    expect(listClaudeModelMappings().map(m => m.anthropicModel)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'anthropic/claude-sonnet-4-20250514',
      'anthropic/claude-sonnet-4',
    ]);
  });

  test('throws for unmapped model ids', () => {
    expect(() => resolveCopilotClaudeModel('claude-sonnet-4-5-20250101')).toThrow(
      'No GitHub Copilot model mapping registered',
    );
  });
});
