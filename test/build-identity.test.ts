import { describe, expect, test } from 'bun:test';
import {
  getBuildIdentity,
  managedForkUpgradeGuard,
  type BuildIdentity,
} from '../src/core/build-identity.ts';
import { VERSION } from '../src/version.ts';

describe('build identity', () => {
  test('the pinned fork reports a four-part release version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(VERSION).toBe('0.42.59.0');
  });

  test('source/upstream fallback is explicit and safe', () => {
    const identity = getBuildIdentity();
    expect(identity.channel).toBe('upstream');
    expect(identity.managed_fork).toBe(false);
    expect(identity.upgrade_posture).toBe('upstream-managed');
    expect(identity).not.toHaveProperty('path');
  });

  test('managed fork guard blocks generic upstream replacement', () => {
    const fork: BuildIdentity = {
      channel: 'aaronkhawkins/gbrain',
      tag: 'research-v1',
      sha: '0123456789abcdef',
      upstream_base: 'v0.42.59.0',
      clean: true,
      artifact: 'compiled',
      managed_fork: true,
      upgrade_posture: 'fork-managed',
    };
    const verdict = managedForkUpgradeGuard(fork);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('fork-managed');
    expect(verdict.reason).not.toContain('/Users/');
  });
});
