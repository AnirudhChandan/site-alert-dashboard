import { db, insertAlert } from './db.ts'
import { SEVERITY } from './rules.ts'

/**
 * The timer rules — sheet rows 6 (Security Alertness) and 7 (Patrolling Route).
 *
 * The AI Box has no detector for these. It only ever says "person seen at the east
 * corner". The requirement is a timer over the ABSENCE of those events, so the
 * logic lives here. All state is in SQLite, never in memory, so the timers are
 * correct across a server restart.
 */

const openAlert = db.prepare(`
  SELECT id FROM alerts
  WHERE camera_id = ? AND rule = ? AND resolved_at IS NULL
  LIMIT 1
`)

const resolveOpen = db.prepare(`
  UPDATE alerts SET resolved_at = ?
  WHERE camera_id = ? AND rule = ? AND resolved_at IS NULL
`)

// MAX(): a late-arriving older event must never move "last seen" backwards.
const touch = db.prepare(`UPDATE checkpoints SET last_seen_at = MAX(last_seen_at, ?) WHERE camera_id = ?`)
const allCheckpoints = db.prepare(`SELECT * FROM checkpoints`)

export const addCheckpoint = db.prepare(`
  INSERT INTO checkpoints (camera_id, rule, threshold_min, last_seen_at)
  VALUES (@camera_id, @rule, @threshold_min, @last_seen_at)
  ON CONFLICT(camera_id) DO UPDATE SET
    rule = excluded.rule, threshold_min = excluded.threshold_min
`)

export const isCheckpoint = (camera_id: string): boolean =>
  !!db.prepare(`SELECT 1 FROM checkpoints WHERE camera_id = ?`).get(camera_id)

/** A guard was seen here: reset the clock and clear any standing alert. */
export function touchCheckpoint(camera_id: string, now = Date.now()): boolean {
  const cp: any = db.prepare(`SELECT rule FROM checkpoints WHERE camera_id = ?`).get(camera_id)
  if (!cp) return false
  touch.run(now, camera_id)
  resolveOpen.run(now, camera_id, cp.rule)
  return true
}

/**
 * Raise an alert for every checkpoint that has gone quiet past its threshold.
 * Returns the alert ids raised on this pass — empty on a normal tick.
 *
 * `now` is a parameter so this is testable without waiting 61 real minutes.
 */
export function checkTimers(now = Date.now()): number[] {
  const raised: number[] = []
  for (const cp of allCheckpoints.all() as any[]) {
    if (cp.muted_until && cp.muted_until > now) continue
    if (now - cp.last_seen_at <= cp.threshold_min * 60_000) continue
    // Already standing? Do not fire a second time for the same lapse.
    if (openAlert.get(cp.camera_id, cp.rule)) continue

    const info = insertAlert.run({
      camera_id: cp.camera_id,
      rule: cp.rule,
      severity: (SEVERITY as any)[cp.rule],
      ts: now,
      snapshot: null,
      raw: JSON.stringify({
        generated_by: 'dashboard-timer',
        reason: `no activity for ${Math.round((now - cp.last_seen_at) / 60_000)} min`,
        threshold_min: cp.threshold_min,
      }),
    })
    raised.push(Number(info.lastInsertRowid))
  }
  return raised
}
