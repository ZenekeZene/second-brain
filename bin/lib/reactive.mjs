/**
 * Reactive compilation thresholds and trigger logic.
 * Shared by bin/reactive.mjs, bin/ingest.mjs, and bin/telegram-bot.mjs.
 *
 * Override defaults with env vars:
 *   REACTIVE_THRESHOLD_ITEMS=5
 *   REACTIVE_THRESHOLD_HOURS=48
 */

export const THRESHOLD_ITEMS = parseInt(process.env.REACTIVE_THRESHOLD_ITEMS || '5', 10);
export const THRESHOLD_HOURS = parseInt(process.env.REACTIVE_THRESHOLD_HOURS || '48', 10);

/**
 * Returns a trigger descriptor if compilation should run, or null if not.
 * @param {{ pending: any[], lastCompile: string|null }} state
 * @returns {{ reason: 'count'|'time', pending: number, threshold: number, hours?: number } | null}
 */
export function shouldCompile(state) {
  const pending = (state.pending || []).length;
  if (pending === 0) return null;

  if (pending >= THRESHOLD_ITEMS) {
    return { reason: 'count', pending, threshold: THRESHOLD_ITEMS };
  }

  const hours = state.lastCompile
    ? (Date.now() - new Date(state.lastCompile).getTime()) / 3_600_000
    : Infinity;

  if (hours >= THRESHOLD_HOURS) {
    return { reason: 'time', pending, hours: Math.floor(hours), threshold: THRESHOLD_HOURS };
  }

  return null;
}

/**
 * Human-readable description of the trigger.
 */
export function triggerMessage(trigger) {
  return trigger.reason === 'count'
    ? `${trigger.pending} items pending (threshold: ${trigger.threshold})`
    : `${trigger.hours}h since last compile (threshold: ${trigger.threshold}h)`;
}
