/**
 * Who may use the dashboard, and what they may do.
 *
 * Two kinds of account:
 *   guard   — sees everything, can mark alerts as checked and add notes
 *   viewer  — sees everything, changes nothing (head office, a wall TV)
 *
 * The guard-room PC itself needs no account: requests from this computer
 * (127.0.0.1) are treated as the guard-room screen, so it still comes up by itself
 * after a power cut. Everyone else signs in.
 *
 * Accounts are created on the guard PC with  npm run users  — see tools/users.mjs.
 * Only standard-library crypto: scrypt for passwords, random 256-bit session tokens
 * of which only a SHA-256 is stored, and a lockout after repeated wrong passwords.
 */
import { randomBytes, randomInt, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { db } from './db.ts'

export type Role = 'guard' | 'viewer'
export const ROLES: Role[] = ['guard', 'viewer']
export type User = { username: string; name: string; role: Role; kiosk?: boolean }

const DAY = 86_400_000
export const SESSION_DAYS = 30
export const COOKIE = 'mes_session'

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username   TEXT PRIMARY KEY,                  -- lower-case, what people type to sign in
  name       TEXT NOT NULL,                     -- shown on screen and recorded on checked alerts
  role       TEXT NOT NULL CHECK (role IN ('guard', 'viewer')),
  pass       TEXT NOT NULL,                     -- scrypt$N$r$p$salt$hash
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                  -- SHA-256 of the cookie token; the token is never stored
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (username);
`)

// ---- passwords ---------------------------------------------------------------
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, o: object) => Promise<Buffer>
const KDF = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

export async function hashPassword(pw: string) {
  const salt = randomBytes(16)
  const h = await scryptAsync(pw, salt, KEYLEN, KDF)
  return `scrypt$${KDF.N}$${KDF.r}$${KDF.p}$${salt.toString('base64')}$${h.toString('base64')}`
}

const DUMMY_SALT = randomBytes(16)
export async function checkPassword(pw: string, stored?: string) {
  if (!stored) {                                   // unknown username: take as long as a wrong password
    await scryptAsync(pw, DUMMY_SALT, KEYLEN, KDF)
    return false
  }
  const [alg, N, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64')
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p })
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Readable, easy to type, about 59 bits: no 0/o, 1/l/i to misread. e.g. "kx7m-3fpa-qw9r". */
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789'
export function newPassword() {
  const c = Array.from({ length: 12 }, () => ALPHA[randomInt(ALPHA.length)]).join('')
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`
}

// ---- accounts ----------------------------------------------------------------
const getUser = db.prepare(`SELECT * FROM users WHERE username = ?`)
const killSessions = db.prepare(`DELETE FROM sessions WHERE username = ?`)

export function cleanUsername(u: unknown) {
  const s = String(u ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{2,32}$/.test(s)) throw new Error('username must be 2–32 letters, numbers, dots, dashes or underscores')
  return s
}
const cleanName = (n: unknown, fallback: string) => {
  const s = String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
  return s || fallback
}
const cleanRole = (r: unknown): Role => {
  if (!ROLES.includes(r as Role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`)
  return r as Role
}

/** Creates the account and returns its password — the only time it is ever shown. */
export async function addUser(username: unknown, role: unknown, name?: unknown) {
  const u = cleanUsername(username), rl = cleanRole(role)
  if (getUser.get(u)) throw new Error(`"${u}" already exists`)
  const pw = newPassword()
  db.prepare(`INSERT INTO users (username, name, role, pass, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(u, cleanName(name, u), rl, await hashPassword(pw), Date.now())
  return pw
}
/**
 * Create the account, or make an existing one exactly this — type, name and password. For logins whose
 * password is agreed in advance ("permanent" logins); running it again changes nothing that matches.
 * A changed password signs that account out everywhere. It also switches the account back on.
 */
export async function setUser(username: unknown, role: unknown, password: unknown, name?: unknown) {
  const u = cleanUsername(username), rl = cleanRole(role), pw = String(password ?? '')
  if (pw.length < 10 || pw.length > 64 || /\s/.test(pw)) throw new Error('password must be 10–64 characters, with no spaces')
  const row: any = getUser.get(u)
  if (!row) {
    db.prepare(`INSERT INTO users (username, name, role, pass, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(u, cleanName(name, u), rl, await hashPassword(pw), Date.now())
    return 'created'
  }
  const samePassword = await checkPassword(pw, row.pass)
  db.prepare(`UPDATE users SET role = ?, name = ?, pass = ?, disabled = 0 WHERE username = ?`)
    .run(rl, cleanName(name, row.name), samePassword ? row.pass : await hashPassword(pw), u)
  if (!samePassword) killSessions.run(u)
  return 'updated'
}
const mustExist = (username: unknown) => {
  const u = cleanUsername(username)
  if (!getUser.get(u)) throw new Error(`no account called "${u}"`)
  return u
}
/** New password, and every place that account was signed in is signed out. */
export async function resetPassword(username: unknown) {
  const u = mustExist(username), pw = newPassword()
  db.prepare(`UPDATE users SET pass = ? WHERE username = ?`).run(await hashPassword(pw), u)
  killSessions.run(u)
  return pw
}
export function setDisabled(username: unknown, off: boolean) {
  const u = mustExist(username)
  db.prepare(`UPDATE users SET disabled = ? WHERE username = ?`).run(off ? 1 : 0, u)
  if (off) killSessions.run(u)
}
export function setRole(username: unknown, role: unknown) {
  const u = mustExist(username)
  db.prepare(`UPDATE users SET role = ? WHERE username = ?`).run(cleanRole(role), u)
}
export function removeUser(username: unknown) {
  const u = mustExist(username)
  killSessions.run(u)
  db.prepare(`DELETE FROM users WHERE username = ?`).run(u)
}
export const listUsers = () => db.prepare(`
  SELECT u.username, u.name, u.role, u.disabled, u.created_at,
         (SELECT MAX(seen_at) FROM sessions s WHERE s.username = u.username) AS last_seen
  FROM users u ORDER BY u.role, u.username`).all() as any[]

// ---- sessions ----------------------------------------------------------------
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const findSession = db.prepare(`
  SELECT s.id, s.expires_at, s.seen_at, u.username, u.name, u.role, u.disabled
  FROM sessions s JOIN users u ON u.username = s.username WHERE s.id = ?`)
const touchSession = db.prepare(`UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?`)

export function createSession(username: string, ip: string, now = Date.now()) {
  const token = randomBytes(32).toString('base64url')
  db.prepare(`INSERT INTO sessions (id, username, created_at, expires_at, seen_at, ip) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sha(token), username, now, now + SESSION_DAYS * DAY, now, ip)
  return token
}

/** The person behind a cookie, or null. Checked on every request, so disabling an account works at once. */
export function sessionUser(token: string | null | undefined, now = Date.now()): User | null {
  if (!token) return null
  const s: any = findSession.get(sha(token))
  if (!s || s.disabled || s.expires_at <= now) return null
  // Sliding expiry, written at most once an hour — live pictures ask several times a second.
  if (now - s.seen_at > 3_600_000) touchSession.run(now, now + SESSION_DAYS * DAY, s.id)
  return { username: s.username, name: s.name, role: s.role }
}
export const endSession = (token: string) => db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sha(token))
export const pruneSessions = (now = Date.now()) => db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now)

// ---- signing in, with a lockout -------------------------------------------------
// 5 wrong passwords for the same account from the same computer, or 20 from one computer
// for any accounts, locks that out for 15 minutes.
const fails = new Map<string, { n: number; first: number; until: number }>()
const WINDOW = 15 * 60_000, LOCK = 15 * 60_000
const lockedFor = (key: string, now: number) => {
  const f = fails.get(key)
  return f && f.until > now ? Math.ceil((f.until - now) / 60_000) : 0
}
const noteFailure = (key: string, max: number, now: number) => {
  let f = fails.get(key)
  if (!f || now - f.first > WINDOW) f = { n: 0, first: now, until: 0 }
  if (++f.n >= max) f.until = now + LOCK
  fails.set(key, f)
}

export async function login(username: unknown, password: unknown, ip: string, now = Date.now()) {
  const u = String(username ?? '').trim().toLowerCase().slice(0, 64)
  const pair = `${ip}|${u}`
  const wait = Math.max(lockedFor(pair, now), lockedFor(ip, now))
  if (wait) return { ok: false as const, locked: wait }
  const row: any = u ? getUser.get(u) : undefined
  const good = await checkPassword(String(password ?? ''), row?.pass)
  if (!good || !row || row.disabled) {
    noteFailure(pair, 5, now); noteFailure(ip, 20, now)
    return { ok: false as const }
  }
  fails.delete(pair)
  const user: User = { username: row.username, name: row.name, role: row.role }
  return { ok: true as const, token: createSession(row.username, ip, now), user }
}

// ---- small helpers used by the server -----------------------------------------
export const cleanIp = (ip = '') => ip.replace(/^::ffff:/, '')
export const isLoopback = (ip = '') => ['127.0.0.1', '::1'].includes(cleanIp(ip))
export const KIOSK: User = { username: 'guard-room', name: 'Guard room', role: 'guard', kiosk: true }

export function readCookie(header: string | undefined, name = COOKIE) {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return null }
    }
  }
  return null
}
// Not `Secure`: the dashboard is served over plain HTTP on the private network.
export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`
export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

/** Where to go after signing in. Only a path on this site — never another website. */
export function safeNext(next: unknown) {
  const s = String(next ?? '')
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && !s.startsWith('/login') ? s : '/'
}

/** Only the AI Box (and this PC, for testing) may send alerts. Extra addresses via EVENTS_ALLOW. */
export function eventSources() {
  let box = '10.0.0.20'
  try { box = new URL(process.env.AIBOX_URL ?? 'https://10.0.0.20:8443').hostname } catch {}
  const extra = (process.env.EVENTS_ALLOW ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return new Set([box, '127.0.0.1', '::1', ...extra])
}
