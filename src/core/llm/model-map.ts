export interface ClaudeModelMapping {
  anthropicModel: string;
  copilotModel: string;
  equivalence: 'exact' | 'versionless-alias';
  rationale: string;
}

const CLAUDE_MODEL_MAPPINGS: Record<string, ClaudeModelMapping> = {
  'claude-haiku-4-5-20251001': {
    anthropicModel: 'claude-haiku-4-5-20251001',
    copilotModel: 'claude-haiku-4.5',
    equivalence: 'versionless-alias',
    rationale: 'Copilot exposes Claude Haiku 4.5 without Anthropic date suffixes.',
  },
  'claude-haiku-4-5': {
    anthropicModel: 'claude-haiku-4-5',
    copilotModel: 'claude-haiku-4.5',
    equivalence: 'versionless-alias',
    rationale: 'Copilot model naming uses dotted Claude family versions.',
  },
  'claude-opus-4-5': {
    anthropicModel: 'claude-opus-4-5',
    copilotModel: 'claude-opus-4.5',
    equivalence: 'versionless-alias',
    rationale: 'Copilot exposes Claude Opus 4.5 using dotted version naming.',
  },
  'anthropic/claude-sonnet-4-20250514': {
    anthropicModel: 'anthropic/claude-sonnet-4-20250514',
    copilotModel: 'claude-sonnet-4',
    equivalence: 'versionless-alias',
    rationale: 'Copilot exposes Claude Sonnet 4 without Anthropic provider/date prefixes.',
  },
  'anthropic/claude-sonnet-4': {
    anthropicModel: 'anthropic/claude-sonnet-4',
    copilotModel: 'claude-sonnet-4',
    equivalence: 'exact',
    rationale: 'The existing Sonnet 4 intent maps directly to Copilot Claude Sonnet 4.',
  },
};

export function getClaudeModelMapping(anthropicModel: string): ClaudeModelMapping {
  const mapping = CLAUDE_MODEL_MAPPINGS[anthropicModel];
  if (!mapping) {
    throw new Error(`No GitHub Copilot model mapping registered for Claude model: ${anthropicModel}`);
  }
  return mapping;
}

export function resolveCopilotClaudeModel(anthropicModel: string): string {
  return getClaudeModelMapping(anthropicModel).copilotModel;
}

export function listClaudeModelMappings(): ClaudeModelMapping[] {
  return Object.values(CLAUDE_MODEL_MAPPINGS);
}
