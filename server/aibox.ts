/**
 * Ganz AI Box HTTP API client (ZN-AIBOX-STD, swagger.json from the box itself).
 *
 * Used for two things the HTTP action message cannot carry:
 *   - the JPEG at the moment of an event   GET /api/snapshot/jpeg/?ch=N&timestamp_us=…
 *   - live thumbnails, one frame a second  GET /api/snapshot/jpeg/?ch=N
 * and for reconciliation / backfill:       GET /api/log/action/
 *
 * Auth: POST /api/auth/login/ → Bearer token, valid 1 day. Credentials come from
 * .env (AIBOX_USER / AIBOX_PASS), never from code. Without them everything here
 * is simply off and the dashboard still works — just without photos.
 */

const URL_ = process.env.AIBOX_URL ?? 'https://10.0.0.20:8443'
const USER = process.env.AIBOX_USER, PASS = process.env.AIBOX_PASS
export const aiboxOk = !!(USER && PASS)

// The box serves HTTPS with a self-signed certificate. We only ever talk to it
// on the LAN, so accept it. (Node's fetch has no per-request switch for this.)
if (aiboxOk) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  // Node prints a scary warning about that. It is expected here, and it alarms whoever
  // is looking at the window, so drop that one and keep the console for real news.
  process.removeAllListeners('warning')
  process.on('warning', w => { if (!/NODE_TLS_REJECT_UNAUTHORIZED/.test(w.message)) console.warn(w.name + ': ' + w.message) })
}

/** Latest live frame per camera, keyed by file name (e.g. "box1_ch1.jpg"). Served from
 *  memory — Windows refuses to rename over a file the browser is reading (EPERM). */
export const frames = new Map<string, { jpg: Buffer; at: number }>()

let token: string | null = null, tokenAt = 0

/** When the box last answered anything at all (any HTTP status). `polling` is set while the
 *  live pictures ask it every second, which is what makes "not answering" meaningful. */
export const boxContact = { at: 0, polling: false }

async function login() {
  const r = await fetch(`${URL_}/api/auth/login/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  boxContact.at = Date.now()
  if (!r.ok) throw new Error(`AI Box login failed: HTTP ${r.status}`)
  token = (await r.json() as any).token; tokenAt = Date.now()
}

async function api(path: string): Promise<Response> {
  if (!token || Date.now() - tokenAt > 20 * 3600_000) await login()   // token lasts 1 day; renew early
  let r = await fetch(URL_ + path, { headers: { authorization: `Bearer ${token}` } })
  if (r.status === 401) { await login(); r = await fetch(URL_ + path, { headers: { authorization: `Bearer ${token}` } }) }
  boxContact.at = Date.now()
  return r
}

/** JPEG for a channel; closest frame to `tsMs` if given (box keeps ~1 minute). */
export async function snapshot(ch: number, tsMs?: number): Promise<Buffer | null> {
  const q = new URLSearchParams({ ch: String(ch) })
  if (tsMs) q.set('timestamp_us', String(Math.round(tsMs * 1000)))
  try {
    const r = await api(`/api/snapshot/jpeg/?${q}`)
    if (!r.ok) return null
    const b = Buffer.from(await r.arrayBuffer())
    return b.length > 500 ? b : null
  } catch { return null }
}

/** Pass an HLS playlist or segment request through to the box, authenticated. */
export async function hlsFetch(path: string) {
  try { return await api(`/api/live/${path}`) } catch { return null }
}

/** The box's own event log — for backfill and for checking we dropped nothing. */
export async function eventLog(page = 1, ipp = 500, sts?: number, ets?: number) {
  const q = new URLSearchParams({ page: String(page), ipp: String(ipp), sort_order: 'desc' })
  if (sts) q.set('sts', String(sts)); if (ets) q.set('ets', String(ets))
  const r = await api(`/api/log/action/?${q}`)
  if (!r.ok) throw new Error(`event log HTTP ${r.status}`)
  return r.json() as Promise<{ list: any[]; page: { count: number; current: number; total: number } }>
}
