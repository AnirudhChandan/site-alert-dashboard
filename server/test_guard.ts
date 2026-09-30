/**
 * The guard-facing safety nets: the "AI Box silent" warning, the one-tap reasons,
 * and the database upgrade that adds the reason column on a PC that already has data.
 * Run: npm test   (uses data-test-guard/, never the live data/)
 */
console.assert = (cond?: unknown, ...msg: unknown[]) => { if (!cond) { process.exitCode = 1; console.error('FAIL:', ...msg) } }

import { rmSync, mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
const ok = (cond: unknown, msg: string) => console.assert(cond, msg)

// ---- AI Box silent / not answering ----
const { healthState } = await import('./health.ts')
const MIN = 60_000, T = 1_800_000_000_000
const base = { now: T, start: T - 600 * MIN, lastEvent: T - 10 * MIN, contactAt: T - 5_000, watching: true, silentMin: 180 }
ok(healthState(base).state === 'ok', 'recent signal and box answering: all fine')
ok(healthState({ ...base, lastEvent: T - 181 * MIN }).state === 'silent', 'no signal for over 3 hours: silent')
ok(healthState({ ...base, lastEvent: T - 179 * MIN }).state === 'ok', 'just under 3 hours: not yet')
ok(healthState({ ...base, lastEvent: T - 181 * MIN }).since === T - 181 * MIN, 'the warning says since when')
ok(healthState({ ...base, lastEvent: 0, start: T - 30 * MIN }).state === 'ok', 'a server started 30 minutes ago does not call the box silent')
ok(healthState({ ...base, lastEvent: 0, start: T - 200 * MIN }).state === 'silent', '...but 3 hours after starting with nothing received, it does')
ok(healthState({ ...base, contactAt: T - 4 * MIN }).state === 'unreachable', 'box not answering for 4 minutes: unreachable')
ok(healthState({ ...base, contactAt: T - 4 * MIN, lastEvent: T - 500 * MIN }).state === 'unreachable', 'not answering outranks silent')
ok(healthState({ ...base, contactAt: 0, watching: false }).state === 'ok', 'without an AI Box login nothing is claimed about reachability')
ok(healthState({ ...base, contactAt: 0, start: T - 2 * MIN }).state === 'ok', 'a just-started server gives the box time to answer')

// ---- reasons ----
const { REASONS, reasonFits } = await import('./rules.ts')
ok(reasonFits('visitor', 'intrusion', 'false_alarm'), 'visitor explains a false intrusion')
ok(!reasonFits('visitor', 'intrusion', 'action_taken'), 'a "why it was fine" reason cannot be saved on a real problem')
ok(!reasonFits('chased', 'car_driveway', 'action_taken'), '"animal chased away" does not fit a parked car')
ok(reasonFits('chased', 'animal', 'action_taken') && reasonFits('camera', 'animal', 'false_alarm'), 'type-specific and general reasons both fit')
ok(!reasonFits('../x', 'animal', 'false_alarm') && !reasonFits(null, 'animal', 'false_alarm'), 'unknown codes are refused')
ok(new Set(REASONS.map(r => r.code)).size === REASONS.length, 'reason codes are unique')
for (const rule of ['slip_fall', 'intrusion', 'post_unmanned', 'patrol_missed', 'ppe_missing', 'car_driveway', 'animal', 'unknown'])
  for (const outcome of ['false_alarm', 'action_taken']) {
    const n = REASONS.filter(r => reasonFits(r.code, rule, outcome)).length
    ok(n >= 2 && n <= 6, `${rule} / ${outcome} offers a short list of reasons (got ${n})`)
  }

// ---- an existing database (made before reasons existed) gets the column, and keeps its data ----
rmSync('data-test-guard', { recursive: true, force: true }); mkdirSync('data-test-guard')
const old = new Database('data-test-guard/alerts.db')
old.exec(`CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL,
  ts INTEGER NOT NULL, snapshot TEXT, raw TEXT NOT NULL, ack_by TEXT, ack_at INTEGER, outcome TEXT, note TEXT, resolved_at INTEGER)`)
old.prepare(`INSERT INTO alerts (camera_id, rule, severity, ts, raw, ack_by, ack_at, outcome) VALUES ('box1/ch2','animal','medium',1,'{}','Ramesh',2,'false_alarm')`).run()
old.close()
process.env.DATA_DIR = 'data-test-guard'
const D = await import('./db.ts')
ok((D.db.prepare(`PRAGMA table_info(alerts)`).all() as any[]).some(c => c.name === 'reason'), 'the reason column is added to an old database')
D.setReason.run({ id: 1, reason: 'pet' })
ok((D.getAlert.get(1) as any).reason === 'pet' && (D.getAlert.get(1) as any).ack_by === 'Ramesh', 'old alerts keep their data and can take a reason')
D.unackAlert.run(1)
ok((D.getAlert.get(1) as any).reason === null, 'undoing a check clears its reason too')
D.setReason.run({ id: 1, reason: 'pet' })
ok((D.getAlert.get(1) as any).reason === null, 'an unchecked alert cannot be given a reason')

console.log(process.exitCode ? 'FAIL (guard)' : 'guard feature assertions passed')
