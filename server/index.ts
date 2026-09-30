import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { db, insertAlert, getAlert, ackAlert, unackAlert, upsertCamera, setNote, setReason, nearby } from './db.ts'
import { normalize } from './normalize.ts'
import { LABEL, LABEL_HI, SEVERITY, REASONS, reasonFits } from './rules.ts'
import { healthState, type Health } from './health.ts'
import { checkTimers, touchCheckpoint, isCheckpoint, addCheckpoint } from './patrol.ts'
import { seedSite, GUARDS } from './seed.ts'
import { startLive, liveOk } from './live.ts'
import { aiboxOk, snapshot, frames, hlsFetch, boxContact } from './aibox.ts'
import { patrolReport, analytics, incidentHtml } from './report.ts'
import { readFileSync } from 'node:fs'
import * as auth from './auth.ts'
import { findAlerts, alertsBook, patrolBook, analyticsBook, toCsv, toXlsx, toPrintHtml, htmlToPdf } from './export.ts'

// Printed on start and shown in the dashboard header, so a screenshot always says
// which build is running. Bumped whenever the code changes meaningfully.
export const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version

// 8090, not 8080: Ganz CORTROL's own server takes 8080 on the guard-room PC.
const PORT = Number(process.env.PORT ?? 8090)
const app = Fastify({ bodyLimit: 20 * 1024 * 1024 })   // snapshots can arrive inline

// The AI Box's real payload format is still unknown (round 2 of the plan). Fastify
// would 415 anything that isn't JSON, which could silently bounce the very first
// real event. So: take every content type as raw bytes and never reject a POST.
/**
 * Body parsing, once, for every route.
 *
 * The AI Box leaves holes in its own template when a token has no value — the
 * PATROLLING rules have no camera channel, so they arrive as `"channel": ,`.
 * Fastify's built-in JSON parser rejects that before any of our code runs, so we
 * replace it: try strict JSON, then JSON with the holes filled, then hand the raw
 * text on to coerce(). Ordinary API calls (ack, note) still get a normal object.
 */
const repair = (text: string) => text.replace(/:\s*(?=[,}\]])/g, ': null')
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: any, done) => {
  const text = String(body ?? '')
  if (!text.trim()) return done(null, {})
  try { return done(null, JSON.parse(text)) } catch {}
  try { return done(null, JSON.parse(repair(text))) } catch {}
  done(null, text)                       // give up here; coerce() files it as unknown
})
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

/**
 * Turn whatever survived the parser into something normalize() can read.
 *   - an object                                → as-is
 *   - form-encoded                             → key/value object
 *   - anything else (multipart with a JPEG, XML, unparseable text) → the bytes go
 *     to data/raw/ untouched and an 'unknown' alert surfaces it in the dashboard.
 */
function coerce(body: any, contentType = ''): any {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
  const text = buf.toString('utf8')
  if (contentType.includes('x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(text))
  mkdirSync('data/raw', { recursive: true })
  const file = `data/raw/${Date.now()}-${randomUUID().slice(0, 8)}.bin`
  writeFileSync(file, buf)
  return { _unparsed: true, content_type: contentType, bytes: buf.length, raw_file: file,
           preview: text.slice(0, 2000) }
}

seedSite({ upsertCamera, addCheckpoint, db })

/**
 * Every request passes this gate first.
 *   /events            only from the AI Box (and this PC). Logged, so a "500" from the box is never a mystery.
 *   /login, /api/login open to all.
 *   everything else    a signed-in account, or this PC itself (the guard-room screen needs no password,
 *                      so it still comes up by itself after a power cut). Set KIOSK_LOCAL=0 to require it there too.
 * Viewers (head office) can look at everything and change nothing.
 */
const EVENT_SOURCES = auth.eventSources()
const PUBLIC = new Set(['/login', '/api/login', '/api/version'])
const KIOSK_LOCAL = process.env.KIOSK_LOCAL !== '0'
app.decorateRequest('user', null)
app.addHook('onRequest', async (req: any, reply) => {
  reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'same-origin')
  // The route the router actually matched, never the raw address: the router decodes %xx, so
  // "/api/%61lerts/1/ack" reaches the ack handler while not starting with "/api/alerts/".
  const route: string = req.routeOptions.url ?? ''
  const ip = auth.cleanIp(req.ip)
  if (route === '/events') {
    console.log(`[${new Date().toLocaleTimeString()}] event from ${ip}  ${req.headers['content-type'] ?? 'no content-type'}`)
    if (EVENT_SOURCES.has(ip)) return
    console.error(`!! refused: alerts are only accepted from ${[...EVENT_SOURCES].join(', ')}.\n   If ${ip} really is the AI Box, add  EVENTS_ALLOW=${ip}  to .env and restart.`)
    return reply.code(403).send({ ok: false, error: 'not an allowed alert source' })
  }
  req.user = auth.sessionUser(auth.readCookie(req.headers.cookie))
          ?? (KIOSK_LOCAL && auth.isLoopback(req.ip) ? auth.KIOSK : null)
  // Browsers only add a custom header to requests our own page makes, so another website
  // cannot make someone's browser press buttons here.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-mes'] !== '1')
    return reply.code(403).send({ ok: false, error: 'missing x-mes header' })
  if (PUBLIC.has(route)) return
  if (!req.user) {
    if (req.method === 'GET' && String(req.headers.accept).includes('text/html'))
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`)
    return reply.code(401).send({ ok: false, error: 'sign in first' })
  }
  if (req.method === 'POST' && route.startsWith('/api/alerts/') && req.user.role !== 'guard')
    return reply.code(403).send({ ok: false, error: 'this account can view but not change alerts' })
})

// --- signing in ---
const LOGIN_HTML = resolve('public/login.html')
app.get('/login', (_req, reply) => reply.type('text/html').header('cache-control', 'no-store').send(readFileSync(LOGIN_HTML)))
app.post('/api/login', async (req: any, reply) => {
  const r = await auth.login(req.body?.username, req.body?.password, auth.cleanIp(req.ip))
  if (!r.ok) {
    console.log(`[${new Date().toLocaleTimeString()}] sign-in refused for "${String(req.body?.username ?? '').slice(0, 32)}" from ${auth.cleanIp(req.ip)}${'locked' in r ? ' (locked)' : ''}`)
    return 'locked' in r ? reply.code(429).send({ ok: false, locked: r.locked }) : reply.code(401).send({ ok: false })
  }
  console.log(`[${new Date().toLocaleTimeString()}] ${r.user.username} (${r.user.role}) signed in from ${auth.cleanIp(req.ip)}`)
  return reply.header('set-cookie', auth.sessionCookie(r.token)).send({ ok: true, user: r.user })
})
app.post('/api/logout', async (req: any, reply) => {
  const token = auth.readCookie(req.headers.cookie)
  if (token) auth.endSession(token)
  return reply.header('set-cookie', auth.clearedCookie).send({ ok: true })
})
app.get('/api/me', async (req: any) => req.user)
// Which build is running — open to all, so the launcher and doctor can check it even when this PC must sign in.
app.get('/api/version', async () => ({ ok: true, version: VERSION }))
setInterval(() => auth.pruneSessions(), 3_600_000).unref()
app.setErrorHandler((err: any, req, reply) => {
  console.error(`!! ${req.method} ${req.url} failed: ${err.message}`)
  if (req.url === '/events') console.error('   body:', JSON.stringify(req.body)?.slice(0, 500))
  reply.code(err.statusCode ?? 500).send({ ok: false, error: err.message })
})

// --- live push to browsers (SSE: one-directional, auto-reconnects, no library) ---
// Each open screen remembers its sign-in, so a signed-out or switched-off account stops receiving at once.
const clients = new Map<any, string | null>()
const send = (msg: string) => {
  for (const [r, token] of clients) {
    if (token && !auth.sessionUser(token)) { clients.delete(r); r.raw.end(); continue }
    r.raw.write(msg)
  }
}
/** A new alert, or (update) a change to one every open screen should show: checked, undone, a reason, a note. */
const push = (id: number, update = false) => {
  const row: any = getAlert.get(id)
  if (row) send(`data: ${JSON.stringify(update ? { ...row, _update: true } : row)}\n\n`)
}

// ---- is the AI Box still sending? ----
const STARTED = Date.now()
const SILENT_MIN = Number(process.env.SILENT_MINUTES) || 180
let lastBoxEvent = 0, lastHealth: Health['state'] = 'ok'
const health = () => healthState({ now: Date.now(), start: STARTED, lastEvent: lastBoxEvent, contactAt: boxContact.at,
                                   watching: aiboxOk && boxContact.polling, silentMin: SILENT_MIN })
function checkHealth() {
  const h = health()
  if (h.state === lastHealth) return
  lastHealth = h.state
  console.log(`[${new Date().toLocaleTimeString()}] AI Box: ${h.state === 'ok' ? 'signals arriving again' : h.state === 'silent'
    ? `SILENT — nothing received since ${new Date(h.since).toLocaleTimeString()}` : 'NOT ANSWERING'}`)
  send(`event: health\ndata: ${JSON.stringify(h)}\n\n`)
}

app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  reply.raw.write(`: connected\n\nevent: health\ndata: ${JSON.stringify(health())}\n\n`)
  clients.set(reply, (req as any).user.kiosk ? null : auth.readCookie(req.headers.cookie))
  req.raw.on('close', () => clients.delete(reply))
})

// --- the integration point: the Ganz AI Box posts here ---
app.post('/events', async (req: any, reply) => {
  const a = normalize(coerce(req.body, req.headers['content-type']))
  lastBoxEvent = Date.now(); checkHealth()

  // A checkpoint camera's job is to reset the patrol clock. A guard walking his
  // round is not an intrusion, so it is logged quietly rather than as an alarm.
  // Exception: the AI Box has its own "Security Person absent" rule — that is an
  // absence, not a sighting, and must never reset the clock.
  if (isCheckpoint(a.camera_id) && a.rule !== 'post_unmanned') {
    touchCheckpoint(a.camera_id, a.ts)
    a.rule = 'person_seen'
    a.severity = SEVERITY.person_seen
  }

  const info = insertAlert.run(a)
  const id = Number(info.lastInsertRowid)
  push(id)
  attachSnapshot(id, a.camera_id, a.ts, a.snapshot)   // in the background; the reply doesn't wait
  return reply.send({ ok: true, id, rule: a.rule })
})

// The action message cannot carry an image, but the box keeps the last minute of
// frames: fetch the one closest to the event and update the card in place.
const setSnapshot = db.prepare('UPDATE alerts SET snapshot = ? WHERE id = ? AND snapshot IS NULL')
async function attachSnapshot(id: number, camera_id: string, ts: number, already: string | null) {
  const ch = Number(camera_id.match(/\/ch(\d+)$/)?.[1])
  if (already || !aiboxOk || !ch) return
  const jpg = await snapshot(ch, ts)
  if (!jpg) return
  const file = `${id}-${randomUUID().slice(0, 8)}.jpg`
  writeFileSync(`data/snapshots/${file}`, jpg)
  setSnapshot.run(file, id)
  push(id, true)
}

// --- dashboard API ---
app.get('/api/alerts', async (req: any) => findAlerts({ limit: 200, ...req.query }, 5000))

// Downloads. Viewers may download too; it changes nothing.
app.get('/export/:what', async (req: any, reply) => {
  const { what } = req.params, fmt = String(req.query.format ?? 'xlsx')
  const book = what === 'alerts' ? alertsBook(req.query)
    : what === 'patrol' ? patrolBook(req.query.day)
    : what === 'analytics' ? analyticsBook(req.query) : null
  if (!book || !['xlsx', 'csv', 'pdf', 'print'].includes(fmt)) return reply.code(404).send({ ok: false, error: 'no such download' })
  const by = req.user.kiosk ? 'guard-room PC' : req.user.name
  if (fmt === 'print') return reply.type('text/html').send(toPrintHtml(book, by, true))
  let file: Buffer | string | null = null
  if (fmt === 'pdf' && !(file = await htmlToPdf(toPrintHtml(book, by))))
    return reply.code(503).send({ ok: false, error: 'this computer cannot make PDF files; use Print instead' })
  reply.header('content-disposition', `attachment; filename="${book.file}.${fmt}"`).header('cache-control', 'no-store')
  if (fmt === 'pdf') return reply.type('application/pdf').send(file)
  return fmt === 'csv'
    ? reply.type('text/csv; charset=utf-8').send(toCsv(book))
    : reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(toXlsx(book, by))
})

app.post('/api/alerts/:id/note', async (req: any, reply) => {
  const note = String(req.body?.note ?? '').slice(0, 2000)
  setNote.run({ id: Number(req.params.id), note })
  push(Number(req.params.id), true)
  return getAlert.get(Number(req.params.id))
})

app.get('/api/analytics', async (req: any) => analytics(req.query))

app.get('/report/:id', async (req: any, reply) => {
  const a: any = getAlert.get(Number(req.params.id))
  if (!a) return reply.code(404).send('no such alert')
  reply.type('text/html').send(incidentHtml(a, nearby.all({ camera_id: a.camera_id, id: a.id, ts: a.ts }), LABEL, LABEL_HI))
})

app.post('/api/alerts/:id/ack', async (req: any, reply) => {
  const { outcome, note } = req.body ?? {}
  // A signed-in guard is recorded by account name. The shared guard-room screen has no
  // account, so there the guard on duty picks their name from the list.
  const ack_by = req.user.kiosk ? String(req.body?.ack_by ?? '').trim().slice(0, 60) : req.user.name
  const id = Number(req.params.id), row: any = getAlert.get(id), reason = req.body?.reason ?? null
  if (!row) return reply.code(404).send({ error: 'no such alert' })
  if (!ack_by) return reply.code(400).send({ error: 'ack_by required' })
  if (!['action_taken', 'false_alarm'].includes(outcome)) return reply.code(400).send({ error: 'outcome must be action_taken or false_alarm' })
  if (reason !== null && !reasonFits(reason, row.rule, outcome)) return reply.code(400).send({ error: 'that reason does not fit this alert' })
  ackAlert.run({ id, ack_by, outcome, reason, note: typeof note === 'string' ? note.slice(0, 2000) : null, ack_at: Date.now() })
  push(id, true)
  return getAlert.get(id)
})

// The one-tap reason, just after marking (or later, from "Add reason"). null clears it.
app.post('/api/alerts/:id/reason', async (req: any, reply) => {
  const id = Number(req.params.id), row: any = getAlert.get(id), reason = req.body?.reason ?? null
  if (!row) return reply.code(404).send({ error: 'no such alert' })
  if (!row.ack_at) return reply.code(400).send({ error: 'mark the alert first' })
  if (reason !== null && !reasonFits(reason, row.rule, row.outcome)) return reply.code(400).send({ error: 'that reason does not fit this alert' })
  setReason.run({ id, reason })
  push(id, true)
  return getAlert.get(id)
})

app.get('/api/meta', async (req: any) => ({
  me: req.user,
  labels: LABEL,
  labels_hi: LABEL_HI,   // spoken announcements
  severity: SEVERITY,
  cameras: db.prepare('SELECT * FROM cameras ORDER BY id').all(),   // ch1..ch8, then the patrol points
  checkpoints: db.prepare('SELECT * FROM checkpoints').all(),
  version: VERSION,
  guards: GUARDS,
  reasons: REASONS,
  health: health(),
  live: liveOk,                                                               // thumbnails available?
}))

app.post('/api/alerts/:id/unack', async (req: any) => {
  unackAlert.run(Number(req.params.id))
  push(Number(req.params.id), true)
  return getAlert.get(Number(req.params.id))
})

app.get('/api/patrol', async (req: any) => patrolReport(req.query.day))

// Real live video: proxy the AI Box's HLS stream, adding the bearer token the browser cannot hold.
app.get('/hls/*', async (req: any, reply) => {
  if (!aiboxOk) return reply.code(404).send()
  const r = await hlsFetch(req.params['*'])
  if (!r?.ok) return reply.code(502).send()
  reply.header('content-type', r.headers.get('content-type') ?? 'application/vnd.apple.mpegurl')
       .header('cache-control', 'no-store')
  return reply.send(Buffer.from(await r.arrayBuffer()))
})
app.register(fastifyStatic, { root: resolve('node_modules/hls.js/dist'), prefix: '/vendor/', decorateReply: false })

app.register(fastifyStatic, { root: resolve('data/snapshots'), prefix: '/snapshots/' })
mkdirSync('data/live', { recursive: true })
if (aiboxOk) {
  // Live frames come straight from memory (see aibox.ts `frames`); no files, no Windows rename locks.
  app.get('/live/:name', (req: any, reply) => {
    const f = frames.get(req.params.name)
    if (!f) return reply.code(404).send()
    reply.type('image/jpeg').header('cache-control', 'no-store').send(f.jpg)
  })
} else {
  app.register(fastifyStatic, { root: resolve('data/live'), prefix: '/live/', decorateReply: false,
                                maxAge: 0, cacheControl: true, lastModified: false, etag: false })
}
startLive()
app.register(fastifyStatic, { root: resolve('public'), decorateReply: false })

// One timer for both rules. A minute is fine — thresholds are in tens of minutes.
setInterval(() => { checkTimers().forEach(id => push(id)); checkHealth() }, 60_000).unref()
checkTimers().forEach(id => push(id))   // catch a lapse that began while the server was down

// Close the database before Node tears down, otherwise the native driver's
// destructor runs too late and prints a scary assertion that hides the real error.
process.on('exit', () => { try { db.close() } catch {} })
// A security dashboard must not die because one background task hiccupped. Log it, carry on.
process.on('uncaughtException', e => console.error('!! uncaught:', e.message))
process.on('unhandledRejection', e => console.error('!! unhandled:', (e as any)?.message ?? e))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`\nSite alert dashboard  v${VERSION}\ndashboard  http://localhost:${PORT}\nevents in  POST /events`))
  .catch((e: any) => {
    console.error(e.code === 'EADDRINUSE'
      ? `\nPort ${PORT} is already in use on this PC (CORTROL uses 8080).\nOpen .env and set  PORT=${PORT + 10}  then run npm start again.\n`
      : `\nCould not start: ${e.message}\n`)
    process.exit(1)
  })
