/**
 * Lifetime of a forming lobby (`WAITING_TIMEOUT_MINUTES`, default 5, floored
 * at 1). The store stamps it as each lobby's deadline; the service logs it.
 */
export function waitingTimeoutMinutes(): number {
  return Math.max(1, Number(process.env.WAITING_TIMEOUT_MINUTES ?? 5) || 5);
}
