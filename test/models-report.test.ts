import { describe, expect, test } from 'bun:test';
import {
  buildModelsReport,
  parseModelsSubcommand,
} from '../src/commands/models.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import { withEnv } from './helpers/with-env.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private readonly config = new Map<string, string>();

  set(key: string, value: string): void {
    this.config.set(key, value);
  }

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }
}

function task(report: Awaited<ReturnType<typeof buildModelsReport>>, key: string) {
  const entry = report.per_task.find(candidate => candidate.key === key);
  if (!entry) throw new Error(`missing model report entry for ${key}`);
  return entry;
}

describe('models command routing report', () => {
  test('accepts doctor argv with and without the leading models token', () => {
    expect(parseModelsSubcommand(['doctor'])).toBe('doctor');
    expect(parseModelsSubcommand(['models', 'doctor'])).toBe('doctor');
  });

  test('shows the native cognition routes with their resolved providers', async () => {
    const engine = new StubEngine();
    engine.set('models.dream.extract_atoms', 'vllm:local-extractor');
    engine.set('models.dream.synthesize_concepts', 'openai:gpt-5.2');

    const report = await buildModelsReport(engine as never);

    expect(task(report, 'models.dream.extract_atoms')).toMatchObject({
      resolved: 'vllm:local-extractor',
      source: 'config: models.dream.extract_atoms',
    });
    expect(task(report, 'models.dream.synthesize_concepts')).toMatchObject({
      resolved: 'openai:gpt-5.2',
      source: 'config: models.dream.synthesize_concepts',
    });
  });

  test('attributes per-task resolution using resolveModel precedence', async () => {
    await withEnv({ GBRAIN_MODEL: 'openai:gpt-env' }, async () => {
      const taskConfig = new StubEngine();
      taskConfig.set('models.dream.extract_atoms', 'vllm:task');
      taskConfig.set('models.default', 'openai:global');
      taskConfig.set('models.tier.utility', 'anthropic:tier');
      expect(task(await buildModelsReport(taskConfig as never), 'models.dream.extract_atoms').source)
        .toBe('config: models.dream.extract_atoms');

      const globalConfig = new StubEngine();
      globalConfig.set('models.default', 'openai:global');
      globalConfig.set('models.tier.utility', 'anthropic:tier');
      expect(task(await buildModelsReport(globalConfig as never), 'models.dream.extract_atoms').source)
        .toBe('config: models.default');

      const tierConfig = new StubEngine();
      tierConfig.set('models.tier.utility', 'anthropic:tier');
      expect(task(await buildModelsReport(tierConfig as never), 'models.dream.extract_atoms').source)
        .toBe('config: models.tier.utility');

      const envConfig = new StubEngine();
      expect(task(await buildModelsReport(envConfig as never), 'models.dream.extract_atoms')).toMatchObject({
        resolved: 'openai:gpt-env',
        source: 'env: GBRAIN_MODEL',
      });
    });
  });

  test('attributes the tier default when no config or env route wins', async () => {
    await withEnv({ GBRAIN_MODEL: undefined }, async () => {
      const report = await buildModelsReport(new StubEngine() as never);
      expect(task(report, 'models.dream.extract_atoms')).toMatchObject({
        resolved: TIER_DEFAULTS.utility,
        source: 'default: tier.utility',
      });
    });
  });
});
