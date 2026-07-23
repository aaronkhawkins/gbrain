/**
 * Scheduler-owned recurring Minion registrations.
 *
 * This is the shared contract between the autopilot scheduler and operational
 * expected-work discovery. Event-driven handlers (for example embed-backfill)
 * deliberately do not appear here.
 */

export const AUTOPILOT_SOURCE_FLOOR_MINUTES = 60;
export const AUTOPILOT_GLOBAL_FLOOR_MINUTES = 60;
export const AUTOPILOT_GLOBAL_FLOOR_CONFIG_KEY = 'autopilot.global_floor_min';
export const AUTOPILOT_RECURRING_GRACE_SECONDS = 30 * 60;

export interface RecurringMinionRegistration {
  name: string;
  required: boolean;
  cadence_seconds: number;
  grace_seconds: number;
  scope: { type: 'global' } | { type: 'source'; source_id: string };
}

export function getAutopilotRecurringRegistrations(opts: {
  scheduledSourceIds: readonly string[];
  globalFloorMinutes?: number;
}): RecurringMinionRegistration[] {
  const globalFloorMinutes = positiveMinutes(
    opts.globalFloorMinutes,
    AUTOPILOT_GLOBAL_FLOOR_MINUTES,
  );
  const sources = [...new Set(opts.scheduledSourceIds)].sort();
  const sourceRegistrations: RecurringMinionRegistration[] =
    sources.length > 0
      ? sources.map((sourceId) => ({
          name: 'autopilot-cycle',
          required: true,
          cadence_seconds: AUTOPILOT_SOURCE_FLOOR_MINUTES * 60,
          grace_seconds: AUTOPILOT_RECURRING_GRACE_SECONDS,
          scope: { type: 'source' as const, source_id: sourceId },
        }))
      : [{
          // Fresh/legacy single-source brains use the scheduler's unscoped
          // fallback job until a local-path source registration exists.
          name: 'autopilot-cycle',
          required: true,
          cadence_seconds: AUTOPILOT_SOURCE_FLOOR_MINUTES * 60,
          grace_seconds: AUTOPILOT_RECURRING_GRACE_SECONDS,
          scope: { type: 'global' as const },
        }];

  return [
    ...sourceRegistrations,
    {
      name: 'autopilot-global-maintenance',
      required: true,
      cadence_seconds: globalFloorMinutes * 60,
      grace_seconds: AUTOPILOT_RECURRING_GRACE_SECONDS,
      scope: { type: 'global' },
    },
  ];
}

function positiveMinutes(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 1 ? Math.floor(value!) : fallback;
}
