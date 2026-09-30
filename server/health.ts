/**
 * Is the AI Box still doing its job? The most dangerous failure is a quiet one: if the box
 * stops sending, the dashboard looks exactly like a calm night.
 *
 *   unreachable  the box has not answered the live-picture requests for 3 minutes
 *                (only known when AIBOX_PASS is set and pictures come from the box)
 *   silent       no alert or patrol signal of any kind for SILENT_MINUTES (default 180)
 *
 * Both count from when this server started, so a restart never raises a stale warning.
 */
export const UNREACHABLE_MIN = 3

export type Health = { state: 'ok' | 'silent' | 'unreachable'; since: number; silentMin: number }

export function healthState(o: { now: number; start: number; lastEvent: number; contactAt: number; watching: boolean; silentMin: number }): Health {
  const lastContact = Math.max(o.contactAt, o.start)
  if (o.watching && o.now - lastContact > UNREACHABLE_MIN * 60_000) return { state: 'unreachable', since: lastContact, silentMin: o.silentMin }
  const lastSignal = Math.max(o.lastEvent, o.start)
  if (o.now - lastSignal > o.silentMin * 60_000) return { state: 'silent', since: lastSignal, silentMin: o.silentMin }
  return { state: 'ok', since: lastSignal, silentMin: o.silentMin }
}
