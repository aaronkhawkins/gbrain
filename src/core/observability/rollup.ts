/**
 * Deterministic brain-level rollup over required work items.
 *
 * Order (required items only):
 *   any failed → failed
 *   else any unknown → unknown
 *   else any degraded → degraded
 *   else healthy
 *
 * Disabled and optional items never affect the rollup.
 */

import type { OperationalState, WorkObservation } from './types.ts';
import { OPERATIONAL_STATES } from './types.ts';

const STATE_SET: ReadonlySet<string> = new Set(OPERATIONAL_STATES);

export function isOperationalState(value: unknown): value is OperationalState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/**
 * Roll up required, enabled items into one brain state.
 */
export function rollupBrainState(items: readonly WorkObservation[]): OperationalState {
  const required = items.filter((i) => i.required && i.enabled && i.state !== 'disabled');
  if (required.length === 0) {
    // No required work configured: report healthy only if nothing is failed/unknown
    // among optional observed items; otherwise surface the worst optional signal
    // as degraded (visibility without inventing required work).
    if (items.some((i) => i.enabled && i.state === 'failed')) return 'degraded';
    if (items.some((i) => i.enabled && i.state === 'unknown')) return 'unknown';
    return 'healthy';
  }
  if (required.some((i) => i.state === 'failed')) return 'failed';
  if (required.some((i) => i.state === 'unknown')) return 'unknown';
  if (required.some((i) => i.state === 'degraded')) return 'degraded';
  return 'healthy';
}

/** Rank for comparisons (higher = worse for required rollup). */
export function stateSeverity(state: OperationalState): number {
  switch (state) {
    case 'failed': return 4;
    case 'unknown': return 3;
    case 'degraded': return 2;
    case 'healthy': return 1;
    case 'disabled': return 0;
  }
}
