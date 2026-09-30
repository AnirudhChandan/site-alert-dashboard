/**
 * Patrol compliance report — sheet rows 6 and 7 as a picture.
 *
 * For one calendar day (server-local time), per checkpoint:
 *   visits  – every time a person was seen there (rule 'person_seen')
 *   gaps    – periods with nobody, from the timer alerts this dashboard raised.
 *             A gap starts `threshold` before the alert fired (that's when the
 *             last visit was) and ends when it was resolved (or now).
 *   compliance – % of elapsed time NOT in a gap, for day / night / total.
 */
import { db } from './db.ts'
import { LABEL, LABEL_HI, SEVERITY, REASONS, REASON } from './rules.ts'

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const DAY_FROM = 6, DAY_TO = 18   // 06:00–18:00 = day shift; the rest = night
const H = 3_600_000

export function patrolReport(dayStr?: string) {
  const d = dayStr ? new Date(`${dayStr}T00:00:00`) : new Date()
  d.setHours(0, 0, 0, 0)
  const start = d.getTime(), end = start + 24 * H, now = Date.now(), upto = Math.min(end, now)
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  const dayWin: [number, number] = [start + DAY_FROM * H, start + DAY_TO * H]
  const nightWins: [number, number][] = [[start, dayWin[0]], [dayWin[1], end]]

  const cps: any[] = db.prepare(`
    SELECT c.*, k.name, k.location FROM checkpoints c LEFT JOIN cameras k ON k.id = c.camera_id`).all()
  const visits: any[] = db.prepare(`
    SELECT camera_id, ts FROM alerts WHERE rule = 'person_seen' AND ts >= ? AND ts < ? ORDER BY ts`).all(start, end)
  const timers: any[] = db.prepare(`
    SELECT camera_id, ts, resolved_at, raw FROM alerts
    WHERE rule IN ('patrol_missed', 'post_unmanned') AND ts < ? AND (resolved_at IS NULL OR resolved_at > ?)`).all(end, start)

  const checkpoints = cps.map(cp => {
    const gaps = timers
      .filter(t => t.camera_id === cp.camera_id)
      .map(t => {
        const thr = (JSON.parse(t.raw).threshold_min ?? cp.threshold_min) * 60_000
        return [Math.max(start, t.ts - thr), Math.min(upto, t.resolved_at ?? now)] as [number, number]
      })
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0])
      // Overlapping gaps must be MERGED, not added. The AI Box sends "Security Person
      // absent" again and again while the guard is away, and each one opens a gap over
      // the same stretch of time. Adding them counted that time several times over and
      // produced compliance below zero.
      .reduce((acc: [number, number][], g) => {
        const last = acc[acc.length - 1]
        if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1])
        else acc.push([g[0], g[1]])
        return acc
      }, [])
    const pct = (wins: [number, number][]) => {
      const elapsed = wins.reduce((s, [w0, w1]) => s + overlap(w0, w1, start, upto), 0)
      const inGap   = wins.reduce((s, [w0, w1]) => s + gaps.reduce((g, [a, b]) => g + overlap(a, b, w0, w1), 0), 0)
      if (!elapsed) return null                                       // shift hasn't started
      return Math.max(0, Math.min(100, Math.round((1 - inGap / elapsed) * 100)))
    }
    return {
      camera_id: cp.camera_id, name: cp.name ?? cp.camera_id, location: cp.location,
      rule: cp.rule, threshold_min: cp.threshold_min,
      visits: visits.filter(v => v.camera_id === cp.camera_id).map(v => v.ts),
      gaps,
      compliance: { day: pct([dayWin]), night: pct(nightWins), total: pct([[start, end]]) },
    }
  })

  const pad = (n: number) => String(n).padStart(2, '0')
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, start, end, upto, checkpoints }
}

// ---- periods ---------------------------------------------------------------------
export const PERIODS = ['hour', 'today', 'yesterday', 'week', '7d', 'month', '30d', '90d', 'custom']
export const GROUPS = ['hour', 'day', 'week', 'month'] as const
type Group = typeof GROUPS[number]
const MAX_BUCKETS = 400

const midnight = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const addDays = (ts: number, n: number) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime() }
const addMonths = (ts: number, n: number) => { const d = new Date(ts); d.setMonth(d.getMonth() + n); return d.getTime() }
const parseDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00`).getTime() : NaN
const shortDay = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

/** Start of the hour / day / week (Monday) / month that `ts` falls in, and the start of the next one. */
function align(g: Group, ts: number) {
  const d = new Date(ts)
  if (g === 'hour') d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0)
  if (g === 'week') d.setDate(d.getDate() - (d.getDay() + 6) % 7)
  if (g === 'month') d.setDate(1)
  return d.getTime()
}
const nextBucket = (g: Group, ts: number) =>
  g === 'hour' ? ts + H : g === 'day' ? addDays(ts, 1) : g === 'week' ? addDays(ts, 7) : addMonths(ts, 1)

/**
 * Turns ?period=today (or ?period=custom&from=2026-09-01&to=2026-09-10) into exact times.
 *
 * Every period is compared with the one just before it, cut to the same length —
 * "this week until Wednesday 3 pm" against "last week until Wednesday 3 pm" — so a
 * comparison is never a whole week against half of one. `group` is how the "over
 * time" chart is split; left out, it is picked from the length of the period.
 */
export function resolvePeriod(q: any = {}, now = Date.now()): any {
  let key = String(q.period ?? ({ 1: 'today', 7: '7d', 30: '30d' } as any)[q.days] ?? '7d')
  if (!PERIODS.includes(key)) key = '7d'
  const today = midnight(now)
  let from = 0, to = now, prevStart = 0
  let label: [string, string], when: [string, string], prev: [string, string]      // [English, Hindi]
  const lastN = (n: number) => {
    from = addDays(today, -(n - 1)); prevStart = addDays(from, -n)
    label = [`Last ${n} days`, `पिछले ${n} दिन`]; when = [`in the last ${n} days`, `पिछले ${n} दिनों में`]
    prev = [`the ${n} days before`, `उससे पहले के ${n} दिनों`]
  }
  switch (key) {
    case 'hour':
      from = now - H; prevStart = from - H
      label = ['Last hour', 'पिछला एक घंटा']; when = ['in the last hour', 'पिछले एक घंटे में']; prev = ['the hour before', 'उससे पहले के घंटे']
      break
    case 'today':
      from = today; prevStart = addDays(today, -1)
      label = ['Today', 'आज']; when = ['today so far', 'आज अब तक']; prev = ['yesterday by this time', 'कल इस समय तक']
      break
    case 'yesterday':
      from = addDays(today, -1); to = today; prevStart = addDays(from, -1)
      label = ['Yesterday', 'कल']; when = ['yesterday', 'कल']; prev = ['the day before', 'परसों']
      break
    case 'week':
      from = align('week', now); prevStart = addDays(from, -7)
      label = ['This week', 'इस हफ़्ते']; when = ['this week so far', 'इस हफ़्ते अब तक']; prev = ['last week by this time', 'पिछले हफ़्ते इस समय तक']
      break
    case 'month':
      from = align('month', now); prevStart = addMonths(from, -1)
      label = ['This month', 'इस महीने']; when = ['this month so far', 'इस महीने अब तक']; prev = ['last month by this time', 'पिछले महीने इस समय तक']
      break
    case '30d': lastN(30); break
    case '90d': lastN(90); break
    case 'custom': {
      const a = parseDay(q.from), b = parseDay(q.to)
      if (!(a <= b)) return resolvePeriod({ period: '7d', group: q.group }, now)          // missing or back-to-front dates
      from = Math.max(a, addDays(b, -366)); to = Math.min(addDays(b, 1), now)
      if (to <= from) return resolvePeriod({ period: 'today', group: q.group }, now)     // dates in the future
      prevStart = from - (to - from)
      const range = from === midnight(b) ? shortDay(from) : `${shortDay(from)} – ${shortDay(b)}`
      label = [range, range]; when = [`between ${shortDay(from)} and ${shortDay(b)}`, `${shortDay(from)} से ${shortDay(b)} के बीच`]
      prev = ['the same number of days before', 'उससे पहले के उतने ही दिनों']
      if (from === midnight(b)) when = [`on ${shortDay(from)}`, `${shortDay(from)} को`]
      break
    }
    default: lastN(7)
  }
  const prevEnd = Math.min(prevStart + (to - from), from)
  const len = to - from
  let group: Group = (GROUPS as readonly string[]).includes(q.group) ? q.group
    : len <= 2 * 24 * H ? 'hour' : len <= 62 * 24 * H ? 'day' : len <= 200 * 24 * H ? 'week' : 'month'
  const bucketsFor = (g: Group) => {
    const out: number[] = []
    for (let b = align(g, from); b < to && out.length <= MAX_BUCKETS; b = nextBucket(g, b)) out.push(b)
    return out
  }
  let buckets = bucketsFor(group)
  while (buckets.length > MAX_BUCKETS && group !== 'month') buckets = bucketsFor(group = GROUPS[GROUPS.indexOf(group) + 1])
  return {
    key, from, to, prevStart, prevEnd, group, buckets, live: to === now,
    label: { en: label![0], hi: label![1] }, when: { en: when![0], hi: when![1] }, prev: { en: prev![0], hi: prev![1] },
  }
}

/**
 * The Analytics page, computed in one place so every number on screen agrees.
 *
 * `q` picks the period — see resolvePeriod.
 *
 * Alongside the numbers it writes the summary sentences, in English and Hindi,
 * so the explanation is produced from the same figures the charts draw.
 */

const ALERT_RULES = (Object.keys(SEVERITY) as (keyof typeof SEVERITY)[]).filter(r => SEVERITY[r] !== 'info')

export function analytics(q: any = {}, now = Date.now()) {
  const P = resolvePeriod(q, now)
  const { from: start, to: end, prevStart, prevEnd, buckets, group } = P

  // Nothing before the first alert ever recorded can be compared — the system was
  // not running. Treating that as "zero alerts" or "100% patrols" would be a lie.
  const firstTs = (db.prepare(`SELECT MIN(ts) AS t FROM alerts`).get() as any)?.t ?? now
  const hasPrev = firstTs < prevEnd

  const rows: any[] = db.prepare(`
    SELECT a.id, a.camera_id, a.rule, a.severity, a.ts, a.ack_at, a.ack_by, a.outcome, a.reason, c.name AS camera_name
    FROM alerts a LEFT JOIN cameras c ON c.id = a.camera_id
    WHERE a.ts >= ? AND a.ts < ? AND a.severity != 'info' ORDER BY a.ts`).all(prevStart, end)
  const cur = rows.filter(r => r.ts >= start)
  const prev = rows.filter(r => r.ts >= prevStart && r.ts < prevEnd)

  const sum = (rs: any[]) => {
    const acked = rs.filter(r => r.ack_at)
    const real = rs.filter(r => r.outcome === 'action_taken').length
    const fals = rs.filter(r => r.outcome === 'false_alarm').length
    return {
      alerts: rs.length, real, falseAlarms: fals, open: rs.length - acked.length, checked: acked.length,
      falseRate: acked.length ? Math.round(fals / acked.length * 100) : null,
      avgResponseMin: acked.length ? round1(acked.reduce((s, r) => s + (r.ack_at - r.ts), 0) / acked.length / 60_000) : null,
    }
  }

  // Patrol compliance averaged over the days that the system was actually running.
  const patrolOver = (from: number, to: number) => {
    const vals: number[] = []
    for (let t = midnight(from); t < to; t = addDays(t, 1)) {
      if (addDays(t, 1) <= firstTs) continue
      const rep = patrolReport(ymd(new Date(t)))
      for (const c of rep.checkpoints) if (c.compliance.total != null) vals.push(c.compliance.total)
    }
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null
  }

  const totals = { ...sum(cur), patrol: patrolOver(start, end) }
  const before = hasPrev ? { ...sum(prev), patrol: patrolOver(prevStart, prevEnd) } : null

  // "Over time": how many in each hour / day / week / month of the period.
  const series = (rs: any[]) => {
    const out = buckets.map(() => 0)
    for (const r of rs) {
      let lo = 0, hi = buckets.length - 1                   // last bucket starting at or before r.ts
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (buckets[mid] <= r.ts) lo = mid; else hi = mid - 1 }
      out[lo]++
    }
    return out
  }
  const peakHour = (rs: any[]) => {
    if (!rs.length) return null
    const hrs = Array.from({ length: 24 }, (_, h) => rs.filter(r => new Date(r.ts).getHours() === h).length)
    return hrs.indexOf(Math.max(...hrs))
  }
  const busiest = (rs: any[]) => {
    const m = new Map<string, { id: string; name: string; count: number }>()
    for (const r of rs) {
      const e = m.get(r.camera_id) ?? { id: r.camera_id, name: r.camera_name ?? r.camera_id, count: 0 }
      e.count++; m.set(r.camera_id, e)
    }
    return [...m.values()].sort((a, b) => b.count - a.count)
  }

  const byType = ALERT_RULES.map(rule => {
    const rs = cur.filter(r => r.rule === rule)
    return {
      rule, severity: SEVERITY[rule], label: LABEL[rule], label_hi: LABEL_HI[rule],
      ...sum(rs),
      prev: hasPrev ? prev.filter(r => r.rule === rule).length : null,
      share: cur.length ? Math.round(rs.length / cur.length * 100) : 0,
      series: series(rs),
      peakHour: peakHour(rs),
      busiest: busiest(rs)[0] ?? null,
    }
  }).sort((a, b) => b.alerts - a.alerts)

  const byHour = Array.from({ length: 24 }, (_, h) => cur.filter(r => new Date(r.ts).getHours() === h).length)

  const cams: any[] = db.prepare(`SELECT id, name FROM cameras ORDER BY id`).all()
  const byCamera = cams
    .map(c => { const rs = cur.filter(r => r.camera_id === c.id); return { id: c.id, name: c.name, ...sum(rs) } })
    .filter(c => c.alerts > 0 || /\/ch\d+$/.test(c.id))          // every real camera, plus any other source with alerts
    .sort((a, b) => b.alerts - a.alerts)

  const mins = cur.filter(r => r.ack_at).map(r => (r.ack_at - r.ts) / 60_000)
  const response = {
    within2: mins.filter(m => m < 2).length,
    within5: mins.filter(m => m >= 2 && m < 5).length,
    within15: mins.filter(m => m >= 5 && m < 15).length,
    over15: mins.filter(m => m >= 15).length,
    never: totals.open,
  }

  const guards = new Map<string, any[]>()
  for (const r of cur) if (r.ack_by) guards.set(r.ack_by, [...(guards.get(r.ack_by) ?? []), r])
  const byGuard = [...guards.entries()]
    .map(([name, rs]) => ({ name, ...sum(rs) }))
    .sort((a, b) => b.checked - a.checked)

  // Why false alarms happen, and what guards did about real ones — from the one-tap reasons.
  const reasonsFor = (outcome: string) => {
    const rs = cur.filter(r => r.outcome === outcome)
    return {
      total: rs.length, given: rs.filter(r => r.reason).length,
      items: REASONS.filter(x => x.outcome === outcome)
        .map(x => ({ code: x.code, en: x.en, hi: x.hi, count: rs.filter(r => r.reason === x.code).length }))
        .filter(x => x.count).sort((a, b) => b.count - a.count),
    }
  }
  const reasons = { false_alarm: reasonsFor('false_alarm'), action_taken: reasonsFor('action_taken') }

  const heat = cams.filter(c => /\/ch\d+$/.test(c.id)).map(c => ({ camera_id: c.id, name: c.name,
    hours: Array.from({ length: 24 }, (_, h) => cur.filter(r => r.camera_id === c.id && new Date(r.ts).getHours() === h).length) }))

  return {
    period: { key: P.key, from: start, to: end, live: P.live, group, label: P.label, when: P.when, prev: P.prev },
    start, end, prevStart, prevEnd, hasPrev, buckets, group, series: series(cur),
    totals, before, byType, byHour, byCamera, response, byGuard, reasons,
    heat, heat_max: Math.max(1, ...heat.flatMap(r => r.hours)),
    insights: { en: insightsEn(), hi: insightsHi() },
  }

  // ---- the plain-language summary ----------------------------------------
  function topCam() { return byCamera.find(c => c.alerts > 0) ?? null }
  function topType() { return byType.find(t => t.alerts > 0) ?? null }
  function peak() { return byHour.some(n => n) ? byHour.indexOf(Math.max(...byHour)) : null }

  function insightsEn(): string[] {
    const out: string[] = []
    const n = totals.alerts
    const when = P.when.en, prevWords = P.prev.en
    if (n === 0) {
      out.push(`No alerts at all ${when}. Everything has been quiet.`)
    } else {
      let s = `There ${n === 1 ? 'was 1 alert' : `were ${n} alerts`} ${when}`
      if (before) {
        const d = n - before.alerts
        s += d > 0 ? ` — ${d} more than ${prevWords}` : d < 0 ? ` — ${-d} fewer than ${prevWords}` : ` — the same as ${prevWords}`
      }
      out.push(s + '.')
    }
    const tt = topType()
    if (tt && n >= 3) out.push(`The most common alert was “${tt.label}”, ${plural(tt.alerts, 'time')} (${tt.share}% of all alerts).`)
    if (totals.checked) {
      const c = totals.checked, r = totals.real, f = totals.falseAlarms
      const what = f === 0 ? (c === 1 ? 'it was a real problem' : 'all were real problems')
                 : r === 0 ? (c === 1 ? 'it was a false alarm' : 'all were false alarms')
                 : `${r} ${r === 1 ? 'was a real problem' : 'were real problems'} and ${plural(f, 'false alarm')} (${totals.falseRate}%)`
      out.push(`Guards checked ${plural(c, 'alert')}: ${what}.`)
    }
    const topFalse = reasons.false_alarm.items[0]
    if (topFalse && reasons.false_alarm.given >= 3)
      out.push(`The most common reason for a false alarm was “${topFalse.en}” (${topFalse.count} of ${reasons.false_alarm.given} with a reason).`)
    if (totals.open) out.push(`${plural(totals.open, 'alert')} ${totals.open === 1 ? 'has' : 'have'} not been checked by anyone yet.`)
    if (totals.avgResponseMin != null) out.push(`On average, a guard checked an alert ${totals.avgResponseMin} minutes after it appeared.`)
    const ph = peak()
    if (ph != null && n >= 3) out.push(`Alerts came most often between ${hourEn(ph)} and ${hourEn((ph + 1) % 24)}.`)
    const tc = topCam()
    if (tc && n >= 3) {
      let s = `${tc.name} raised the most alerts (${tc.alerts}).`
      if (tc.checked >= 3 && (tc.falseRate ?? 0) >= 50) s += ` Most of those turned out to be false alarms, so that camera may need adjusting.`
      out.push(s)
    }
    const falls = byType.find(t => t.rule === 'slip_fall')?.alerts ?? 0
    if (falls) out.push(`${falls === 1 ? 'A resident fall was' : `${falls} resident falls were`} detected — please make sure each one was followed up.`)
    if (totals.patrol != null) out.push(`Guards kept to the patrol schedule ${totals.patrol}% of the time.`)
    return out
  }

  function insightsHi(): string[] {
    const out: string[] = []
    const n = totals.alerts
    const when = P.when.hi, prevWords = P.prev.hi
    if (n === 0) {
      out.push(`${when} कोई भी सूचना नहीं आई। सब शांत रहा।`)
    } else {
      let s = `${when} ${n} सूचनाएँ आईं`
      if (before) {
        const d = n - before.alerts
        s += d > 0 ? ` — ${prevWords} से ${d} ज़्यादा` : d < 0 ? ` — ${prevWords} से ${-d} कम` : ` — ${prevWords} जितनी ही`
      }
      out.push(s + '।')
    }
    const tt = topType()
    if (tt && n >= 3) out.push(`सबसे ज़्यादा सूचना थी “${tt.label_hi}” — ${tt.alerts} बार (सभी सूचनाओं का ${tt.share}%)।`)
    if (totals.checked) {
      const c = totals.checked, r = totals.real, f = totals.falseAlarms
      const what = f === 0 ? 'सभी असली समस्याएँ थीं' : r === 0 ? 'सभी झूठी निकलीं'
                 : `${r} असली समस्याएँ थीं और ${f} झूठी निकलीं (${totals.falseRate}%)`
      out.push(`गार्डों ने ${c} सूचनाएँ जाँचीं: ${what}।`)
    }
    const topFalse = reasons.false_alarm.items[0]
    if (topFalse && reasons.false_alarm.given >= 3)
      out.push(`झूठी सूचना की सबसे आम वजह थी “${topFalse.hi}” (वजह वाली ${reasons.false_alarm.given} में से ${topFalse.count})।`)
    if (totals.open) out.push(`${totals.open} सूचनाएँ अभी तक किसी ने नहीं जाँचीं।`)
    if (totals.avgResponseMin != null) out.push(`औसतन, सूचना आने के ${totals.avgResponseMin} मिनट बाद गार्ड ने उसे जाँचा।`)
    const ph = peak()
    if (ph != null && n >= 3) out.push(`सबसे ज़्यादा सूचनाएँ ${hourHi(ph)} से ${hourHi((ph + 1) % 24)} के बीच आईं।`)
    const tc = topCam()
    if (tc && n >= 3) {
      let s = `सबसे ज़्यादा सूचनाएँ ${tc.name} से आईं (${tc.alerts})।`
      if (tc.checked >= 3 && (tc.falseRate ?? 0) >= 50) s += ` इनमें से ज़्यादातर झूठी निकलीं, इसलिए इस कैमरे को ठीक करने की ज़रूरत हो सकती है।`
      out.push(s)
    }
    const falls = byType.find(t => t.rule === 'slip_fall')?.alerts ?? 0
    if (falls) out.push(`${falls} बार किसी व्यक्ति के गिरने की सूचना आई — कृपया सुनिश्चित करें कि हर बार मदद की गई।`)
    if (totals.patrol != null) out.push(`गार्डों ने ${totals.patrol}% समय गश्त का नियम निभाया।`)
    return out
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
function hourEn(h: number) {
  if (h === 0) return 'midnight'
  if (h === 12) return 'noon'
  return h < 12 ? `${h} am` : `${h - 12} pm`
}
function hourHi(h: number) {
  const part = h < 4 ? 'रात' : h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${part} ${h12} बजे`
}

/**
 * A print-ready incident report for one alert. Written for the people who read it —
 * a committee member, an insurer, a police officer — not for an engineer. Every
 * heading appears in English and Hindi, and the top of the page is one plain
 * sentence saying what happened. The browser's Print → Save as PDF is the PDF.
 */
export function incidentHtml(a: any, others: any[], labels: Record<string, string>,
                             labelsHi: Record<string, string> = {}) {
  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const dt = (ts: number) => new Date(ts).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' })
  const tm = (ts: number) => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  const snap = a.snapshot ? (a.snapshot.startsWith('http') ? a.snapshot : `/snapshots/${a.snapshot}`) : null
  const raw = (() => { try { return JSON.parse(a.raw) } catch { return {} } })()
  const where = esc(a.location && !/TBC/.test(a.location) ? a.location : (a.camera_name ?? a.camera_id))
  const what = esc(labels[a.rule] ?? a.rule)
  const whatHi = esc(labelsHi[a.rule] ?? '')
  const mins = a.ack_at ? Math.round((a.ack_at - a.ts) / 60_000) : null
  const byTimer = raw.generated_by === 'dashboard-timer'

  // One plain sentence, so nobody has to read a table to understand the incident.
  const summary = byTimer
    ? `On ${dt(a.ts)}, the system raised <b>${what}</b> at <b>${where}</b>, because ${esc(raw.reason ?? 'the expected activity did not happen')}.`
    : `On ${dt(a.ts)}, the CCTV system detected <b>${what}</b> at <b>${where}</b>.`
  const outcome = !a.ack_at
    ? `<span class="warn">This alert has not been marked as handled by anyone.</span>`
    : a.outcome === 'false_alarm'
    ? `It was checked by <b>${esc(a.ack_by)}</b> after ${mins} minute${mins === 1 ? '' : 's'} and found to be a <b>false alarm</b>${
        REASON[a.reason] ? ` (${esc(REASON[a.reason].en)})` : ''}.`
    : `It was checked by <b>${esc(a.ack_by)}</b> after ${mins} minute${mins === 1 ? '' : 's'}, who confirmed a <b>real problem</b> and acted on it${
        REASON[a.reason] ? `: <b>${esc(REASON[a.reason].en.toLowerCase())}</b>` : ''}.`

  const row = (en: string, hi: string, v: any) =>
    `<tr><th>${en}<small>${hi}</small></th><td>${v}</td></tr>`

  // The timeline is what an insurer or the police actually want: who knew what, when.
  const steps = [
    [a.ts, byTimer ? 'System raised the alert' : 'Camera detected it', 'सूचना दर्ज हुई'],
    ...(a.ack_at ? [[a.ack_at, `${esc(a.ack_by)} marked it ${a.outcome === 'false_alarm' ? 'a false alarm' : 'handled'}`, 'गार्ड ने जाँच की']] : []),
    ...(a.resolved_at ? [[a.resolved_at, 'Situation returned to normal', 'स्थिति सामान्य हुई']] : []),
  ] as [number, string, string][]

  return `<!doctype html><meta charset="utf-8"><title>Incident #${a.id} — Demo Estate</title>
<style>
  body{font:14.5px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;color:#111;margin:0;padding:36px 44px;max-width:880px}
  .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:8px}
  .hd h1{font-size:26px;margin:0}
  .hd small{display:block;color:#555;font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;margin-top:3px}
  .ref{text-align:right;font-size:11.5px;color:#555}.ref b{display:block;font-size:22px;color:#111;letter-spacing:.5px}
  .lead{font-size:16px;line-height:1.65;background:#f6f7f9;border-left:4px solid #111;padding:14px 18px;margin:20px 0 6px}
  .lead p{margin:0 0 8px}.lead p:last-child{margin:0}
  .warn{color:#b3261e;font-weight:600}
  h2{font-size:12.5px;letter-spacing:.9px;text-transform:uppercase;color:#555;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:5px}
  h2 span{text-transform:none;letter-spacing:0;color:#999;font-weight:400;margin-left:8px}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #e6e6e6;vertical-align:top}
  th{width:210px;color:#555;font-weight:600}
  th small{display:block;font-weight:400;color:#999;font-size:11.5px}
  .sev{display:inline-block;padding:2px 9px;border-radius:5px;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;border:1.5px solid #111}
  img{max-width:100%;border:1px solid #bbb;border-radius:6px;margin-top:6px}
  .tl{list-style:none;padding:0;margin:6px 0 0}
  .tl li{position:relative;padding:0 0 14px 26px;border-left:2px solid #ddd;margin-left:6px}
  .tl li:last-child{border-left-color:transparent;padding-bottom:0}
  .tl li::before{content:'';position:absolute;left:-7px;top:5px;width:12px;height:12px;border-radius:50%;background:#111}
  .tl b{font-variant-numeric:tabular-nums;margin-right:10px}
  .tl small{color:#999;margin-left:8px}
  .sig{display:flex;gap:44px;margin-top:52px}
  .sig div{flex:1;border-top:1px solid #111;padding-top:7px;font-size:12px;color:#555}
  .sig div small{display:block;color:#999}
  .foot{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:10px}
  .bar{position:fixed;top:12px;right:14px}
  .bar button{padding:9px 16px;font:inherit;cursor:pointer;border-radius:6px;border:1px solid #111;background:#111;color:#fff}
  @media print{.bar{display:none}body{padding:0;max-width:none}}
</style>
<div class="bar"><button onclick="print()">Print / Save as PDF</button></div>

<div class="hd">
  <div><h1>Incident Report</h1><small>Demo Estate · Security operations</small></div>
  <div class="ref">Reference<b>INC-${String(a.id).padStart(5, '0')}</b></div>
</div>

<div class="lead"><p>${summary}</p><p>${outcome}</p></div>

<h2>Details <span>विवरण</span></h2>
<table>
${row('What happened', whatHi || 'घटना', `${what} &nbsp; <span class="sev">${esc(a.severity)}</span>`)}
${row('Where', 'स्थान', `${where}${a.camera_name && a.camera_name !== where ? ` <small style="color:#888">(${esc(a.camera_name)})</small>` : ''}`)}
${row('Date and time', 'दिनांक और समय', dt(a.ts))}
${row('How it was detected', 'कैसे पता चला', byTimer
    ? `Automatically by the dashboard — ${esc(raw.reason ?? 'expected activity did not happen')}`
    : 'Ganz AI Box video analytics')}
${row('Checked by', 'किसने जाँच की', a.ack_at ? `${esc(a.ack_by)}, at ${dt(a.ack_at)}` : '<i>Nobody yet</i>')}
${row('Time taken to respond', 'प्रतिक्रिया समय', mins === null ? '—' : `${mins} minute${mins === 1 ? '' : 's'}`)}
${row('Outcome', 'परिणाम', !a.ack_at ? '<i>Not yet decided</i>'
    : a.outcome === 'false_alarm' ? 'False alarm — nothing was wrong'
    : 'Real problem — action was taken')}
${row('What the guard wrote', 'गार्ड की टिप्पणी', a.note ? esc(a.note) : '<i>Nothing written</i>')}
</table>

<h2>Photograph at the moment of detection <span>घटना के समय की तस्वीर</span></h2>
${snap ? `<img src="${snap}" alt="snapshot">`
       : '<p style="color:#888"><i>No photograph is available for this event.</i></p>'}

<h2>Sequence of events <span>घटनाक्रम</span></h2>
<ul class="tl">${steps.map(([ts, en, hi]) =>
  `<li><b>${tm(ts)}</b>${en}<small>${hi}</small></li>`).join('')}</ul>

<h2>Anything else seen on this camera within 30 minutes <span>उसी कैमरे की अन्य घटनाएँ</span></h2>
${others.length
  ? `<table>${others.map(o => `<tr><td style="width:110px">${tm(o.ts)}</td><td>${esc(labels[o.rule] ?? o.rule)}</td>
      <td>${o.ack_by ? `${esc(o.ack_by)} — ${o.outcome === 'false_alarm' ? 'false alarm' : 'action taken'}` : '<i>not checked</i>'}</td></tr>`).join('')}</table>`
  : '<p style="color:#888"><i>Nothing else was recorded on this camera in that window.</i></p>'}

<div class="sig">
  <div>Security supervisor — signature / date<small>सुरक्षा पर्यवेक्षक — हस्ताक्षर / दिनांक</small></div>
  <div>Property manager — signature / date<small>प्रॉपर्टी मैनेजर — हस्ताक्षर / दिनांक</small></div>
</div>
<div class="foot">Generated ${dt(Date.now())} · Site security alert dashboard · Alert id ${a.id}</div>`
}
