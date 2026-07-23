/**
 * Deployment contract checks (U9) — launchd template + runbooks present,
 * content-free.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

describe('Phase 1A deployment contract', () => {
  test('launchd template exists and is parameterized', () => {
    const path = join(ROOT, 'ops/launchd/ai.gbrain.observer.plist.template');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('{{GBRAIN_HOME}}');
    expect(body).toContain('{{BIND}}');
    expect(body).toContain('{{PORT}}');
    expect(body).toContain('observe');
    expect(body).toContain('serve');
    // No hard-coded secrets / personal paths.
    expect(body).not.toMatch(/postgres:\/\//i);
    expect(body).not.toMatch(/password/i);
  });

  test('operator guide and runbooks exist', () => {
    const files = [
      'docs/guides/observability-operator.md',
      'docs/operations/phase-1a-observability-acceptance.md',
      'docs/runbooks/observability/observer-missing.md',
      'docs/runbooks/observability/missed-work.md',
      'docs/runbooks/observability/backlog.md',
      'docs/runbooks/observability/embedding.md',
    ];
    for (const f of files) {
      const p = join(ROOT, f);
      expect(existsSync(p)).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body.length).toBeGreaterThan(100);
      // Reject live connection strings; allow educational `postgres://` mentions.
      expect(body).not.toMatch(/postgres:\/\/[^\s"'`]+@/i);
    }
  });
});
