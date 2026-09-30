/**
 * The patrol / absent-from-post timers are the only real business logic here,
 * and a bug in them means a security lapse goes unreported. So they get a test.
 * Run: npm test   (uses data-test/, never the live data/)
 */
// console.assert only PRINTS a failure; make a failed assertion fail the run too.
console.assert = (cond?: unknown, ...msg: unknown[]) => { if (!cond) { process.exitCode = 1; console.error('FAIL:', ...msg) } }

import { rmSync, mkdirSync } from 'node:fs'
process.env.DATA_DIR = 'data-test'          // never touch the live database
rmSync('data-test', { recursive: true, force: true })

const { db } = await import('./db.ts')
const { checkTimers, touchCheckpoint, addCheckpoint } = await import('./patrol.ts')

const MIN = 60_000
const T0 = Date.parse('2026-09-04T20:00:00Z')
const openCount = (cam: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM alerts WHERE camera_id = ? AND resolved_at IS NULL`).get(cam) as any).n
const total = (cam: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM alerts WHERE camera_id = ?`).get(cam) as any).n

addCheckpoint.run({ camera_id: 'East Corner', rule: 'patrol_missed', threshold_min: 60, last_seen_at: T0 })

// Inside the window: silent.
console.assert(checkTimers(T0 + 59 * MIN).length === 0, 'must not fire before the threshold')
console.assert(total('East Corner') === 0, 'no alert yet at 59 min')

// Past the window: exactly one alert.
console.assert(checkTimers(T0 + 61 * MIN).length === 1, 'must fire once past the threshold')
console.assert(total('East Corner') === 1, 'exactly one alert at 61 min')

// Still quiet at 90 and 200 min: must NOT pile up duplicates.
checkTimers(T0 + 90 * MIN)
checkTimers(T0 + 200 * MIN)
console.assert(total('East Corner') === 1, 'must not double-fire while the lapse stands')

// A restart replays checkTimers on boot — same guard must hold.
checkTimers(T0 + 201 * MIN)
console.assert(total('East Corner') === 1, 'restart must not duplicate a standing alert')

// Guard finally shows up: alert resolves and the clock resets.
touchCheckpoint('East Corner', T0 + 210 * MIN)
console.assert(openCount('East Corner') === 0, 'a visit must clear the standing alert')
console.assert(checkTimers(T0 + 260 * MIN).length === 0, 'clock resets on visit — 50 min is under 60')

// A second, separate lapse must raise a NEW alert (not stay silent forever).
console.assert(checkTimers(T0 + 275 * MIN).length === 1, 'a fresh lapse must fire again')
console.assert(total('East Corner') === 2, 'two distinct lapses, two alerts')

// Muting suppresses without losing the clock.
db.prepare(`UPDATE checkpoints SET muted_until = ? WHERE camera_id = ?`).run(T0 + 400 * MIN, 'East Corner')
touchCheckpoint('East Corner', T0 + 280 * MIN)
console.assert(checkTimers(T0 + 350 * MIN).length === 0, 'muted checkpoint must stay quiet')

const failed = process.exitCode
console.log(failed ? 'FAIL' : 'all patrol timer assertions passed')

// ---- patrol REPORT: overlapping gaps must merge, compliance must stay in 0–100 ----
// The AI Box repeats "Security Person absent" while the guard is away. Each opens a
// gap over the same stretch; adding them used to push compliance below zero.
{
  const { patrolReport } = await import('./report.ts')
  const day = new Date(); day.setHours(0, 0, 0, 0)
  const D0 = day.getTime(), H = 3_600_000
  addCheckpoint.run({ camera_id: 'box1/ch8', rule: 'post_unmanned', threshold_min: 15, last_seen_at: D0 })
  const ins = db.prepare(`INSERT INTO alerts (camera_id, rule, severity, ts, raw, resolved_at) VALUES (?,?,?,?,?,?)`)
  // three absence events 10 min apart, all resolved when the guard returns at 03:00
  for (const m of [0, 10, 20]) ins.run('box1/ch8', 'post_unmanned', 'high', D0 + 2 * H + m * 60_000, '{}', D0 + 3 * H)
  const rep = patrolReport(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`)
  const cp = rep.checkpoints.find((c: any) => c.camera_id === 'box1/ch8')
  console.assert(cp.gaps.length === 1, `overlapping gaps must merge into one, got ${cp.gaps.length}`)
  for (const k of ['day', 'night', 'total'] as const) {
    const v = cp.compliance[k]
    console.assert(v === null || (v >= 0 && v <= 100), `compliance.${k} must be 0–100, got ${v}`)
  }
}
console.log(process.exitCode ? 'FAIL (report)' : 'patrol report assertions passed')

// ---- analytics PERIODS: exact edges, and like-for-like comparisons ----
{
  const { resolvePeriod, analytics } = await import('./report.ts')
  const at = (s: string) => new Date(s).getTime()
  const NOW = at('2026-09-16T10:30:00')                         // a Wednesday
  const eq = (got: number, want: string, msg: string) => console.assert(got === at(want), `${msg}: got ${new Date(got).toString()}`)
  let p = resolvePeriod({ period: 'today' }, NOW)
  eq(p.from, '2026-09-16T00:00:00', 'today starts at midnight'); eq(p.prevEnd, '2026-09-15T10:30:00', 'today compares with yesterday until the same time')
  console.assert(p.group === 'hour' && p.buckets.length === 11, `today is shown by hour, 11 bars so far, got ${p.group} ${p.buckets.length}`)
  p = resolvePeriod({ period: 'yesterday' }, NOW)
  eq(p.from, '2026-09-15T00:00:00', 'yesterday starts'); eq(p.to, '2026-09-16T00:00:00', 'yesterday ends at midnight'); eq(p.prevStart, '2026-09-14T00:00:00', 'compared with the day before')
  p = resolvePeriod({ period: 'week' }, NOW)
  eq(p.from, '2026-09-14T00:00:00', 'a week starts on Monday'); eq(p.prevEnd, '2026-09-09T10:30:00', 'compared with last week until the same moment')
  p = resolvePeriod({ period: 'month' }, NOW)
  eq(p.from, '2026-09-01T00:00:00', 'this month starts on the 1st'); eq(p.prevStart, '2026-08-01T00:00:00', 'compared with last month')
  eq(p.prevEnd, '2026-08-16T10:30:00', '...until the same day and time')
  p = resolvePeriod({ days: '7' }, NOW)
  console.assert(p.key === '7d', 'old ?days=7 links still work'); eq(p.from, '2026-09-10T00:00:00', 'last 7 days includes today')
  p = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-10' }, NOW)
  eq(p.from, '2026-09-01T00:00:00', 'custom from'); eq(p.to, '2026-09-11T00:00:00', 'custom includes the whole last day')
  eq(p.prevStart, '2026-08-22T00:00:00', 'custom compares with the same number of days before')
  console.assert(p.group === 'day' && p.buckets.length === 10, 'ten days, shown by day')
  console.assert(resolvePeriod({ period: 'custom', from: '2026-09-10', to: '2026-09-01' }, NOW).key === '7d', 'back-to-front dates fall back to 7 days')
  console.assert(resolvePeriod({ period: 'custom', from: 'x' }, NOW).key === '7d', 'nonsense dates fall back to 7 days')
  console.assert(resolvePeriod({ period: '../etc' }, NOW).key === '7d', 'unknown periods fall back to 7 days')
  p = resolvePeriod({ period: '90d' }, NOW)
  console.assert(p.group === 'week' && new Date(p.buckets[0]).getDay() === 1, '90 days is shown by week, weeks start Monday')
  p = resolvePeriod({ period: '90d', group: 'hour' }, NOW)
  console.assert(p.group === 'day' && p.buckets.length === 90, `too many hourly bars becomes daily, got ${p.group} ${p.buckets.length}`)
  p = resolvePeriod({ period: 'week', group: 'day' }, NOW)
  console.assert(p.group === 'day' && p.buckets.length === 3, 'Mon, Tue, Wed so far')

  const a = analytics({ period: '30d' })
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)
  console.assert(sum(a.series) === a.totals.alerts, `bars over time add up to the total (${sum(a.series)} vs ${a.totals.alerts})`)
  console.assert(a.byType.every((t: any) => sum(t.series) === t.alerts), 'each type\'s bars add up to its count')
  console.assert(a.series.length === a.buckets.length, 'one bar per bucket')
}
console.log(process.exitCode ? 'FAIL (periods)' : 'analytics period assertions passed')
