/**
 * Real-Postgres operational snapshot seam (U3).
 *
 * Skips when DATABASE_URL is unset (unit CI). Does not run the full E2E suite.
 */
import { describe, test, expect } from 'bun:test';

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('operational snapshot (postgres)', () => {
  test('builds a content-free snapshot from a live engine', async () => {
    const { createEngine } = await import('../../src/core/engine-factory.ts');
    const { buildOperationalSnapshot, serializeOperationalSnapshot } =
      await import('../../src/core/observability/snapshot.ts');
    const { scanOpenMetricsForProhibited } =
      await import('../../src/core/observability/openmetrics.ts');
    const { renderOpenMetrics } =
      await import('../../src/core/observability/openmetrics.ts');

    const url = process.env.DATABASE_URL!;
    const cfg = { engine: 'postgres' as const, database_url: url };
    const engine = await createEngine(cfg);
    await engine.connect(cfg);
    try {
      // probe-only posture: do not force migrations here
      const snap = await buildOperationalSnapshot({
        engine,
        config: cfg,
        brainId: 'e2e_ops',
        collectTimeoutMs: 20_000,
      });
      expect(snap.schema_version).toBe(1);
      expect(snap.brain).toBe('e2e_ops');
      expect(snap.items.length).toBeGreaterThan(0);
      expect(['healthy', 'degraded', 'failed', 'unknown', 'disabled']).toContain(snap.state);

      const json = serializeOperationalSnapshot(snap);
      expect(json).not.toMatch(/postgres:\/\/[^\s]+@/i);
      expect(JSON.parse(json).items[0].key).toBeTruthy();

      const metrics = renderOpenMetrics(snap);
      expect(scanOpenMetricsForProhibited(metrics)).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });
});
