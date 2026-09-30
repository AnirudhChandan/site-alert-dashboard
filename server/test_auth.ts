/**
 * Sign-in is a security boundary, so it gets its own assertions.
 * Run: npm test   (uses data-test-auth/, never the live data/)
 */
// console.assert only PRINTS a failure; make a failed assertion fail the run too.
console.assert = (cond?: unknown, ...msg: unknown[]) => { if (!cond) { process.exitCode = 1; console.error('FAIL:', ...msg) } }

import { rmSync } from 'node:fs'
process.env.DATA_DIR = 'data-test-auth'
rmSync('data-test-auth', { recursive: true, force: true })
process.env.AIBOX_URL = 'https://10.0.0.20:8443'
process.env.EVENTS_ALLOW = '10.1.2.3'

const A = await import('./auth.ts')
const ok = (cond: unknown, msg: string) => console.assert(cond, msg)
const DAY = 86_400_000

// passwords
const h = await A.hashPassword('correct horse')
ok(await A.checkPassword('correct horse', h), 'right password must verify')
ok(!(await A.checkPassword('wrong horse', h)), 'wrong password must fail')
ok(!(await A.checkPassword('anything', undefined)), 'unknown user must fail, not throw')
ok(!h.includes('correct horse'), 'hash must not contain the password')
const p1 = A.newPassword(), p2 = A.newPassword()
ok(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(p1) && p1 !== p2, 'generated passwords are readable and different')
ok(!/[01oil]/.test(p1 + p2), 'generated passwords avoid characters that are easy to misread')

// accounts
const pwGuard = await A.addUser('Ramesh', 'guard', 'Ramesh Kumar')
const pwView = await A.addUser('head.office', 'viewer', 'Head Office')
let threw = false; try { await A.addUser('ramesh', 'guard') } catch { threw = true }
ok(threw, 'duplicate usernames are refused (case-insensitive)')
threw = false; try { await A.addUser('x', 'guard') } catch { threw = true }
ok(threw, 'too-short usernames are refused')
threw = false; try { await A.addUser('bob', 'admin') } catch { threw = true }
ok(threw, 'unknown roles are refused')

// signing in
const T0 = Date.now()
const g = await A.login('RAMESH', pwGuard, '10.0.0.50', T0)
ok(g.ok && g.user.role === 'guard' && g.user.name === 'Ramesh Kumar', 'guard signs in, username is case-insensitive')
const v = await A.login('head.office', pwView, '172.16.1.9', T0)
ok(v.ok && v.user.role === 'viewer', 'viewer signs in with viewer role')
ok(!(await A.login('ramesh', 'not-it', '10.0.0.50', T0)).ok, 'wrong password is refused')
ok(!(await A.login('nobody', 'x', '10.0.0.50', T0)).ok, 'unknown user is refused')

// sessions
ok(g.ok && A.sessionUser(g.token, T0)?.username === 'ramesh', 'a session token identifies the user')
ok(A.sessionUser('made-up-token', T0) === null, 'a made-up token is not a session')
ok(g.ok && A.sessionUser(g.token, T0 + A.SESSION_DAYS * DAY + 1) === null, 'sessions expire')
if (v.ok) { A.endSession(v.token); ok(A.sessionUser(v.token, T0) === null, 'signing out ends the session') }

// disabling, resetting and removing take effect immediately, everywhere
const g2 = await A.login('ramesh', pwGuard, '10.0.0.51', T0)
A.setDisabled('ramesh', true)
ok(g2.ok && A.sessionUser(g2.token, T0) === null, 'disabling an account signs it out')
ok(!(await A.login('ramesh', pwGuard, '10.0.0.52', T0)).ok, 'a disabled account cannot sign in')
A.setDisabled('ramesh', false)
// ...and even if an account were switched off some other way that left its sessions in place:
const g2b = await A.login('ramesh', pwGuard, '10.0.0.55', T0)
const { db } = await import('./db.ts')
db.prepare(`UPDATE users SET disabled = 1 WHERE username = 'ramesh'`).run()
ok(g2b.ok && A.sessionUser(g2b.token, T0) === null, 'a disabled account is refused on every request, not only at sign-in')
db.prepare(`UPDATE users SET disabled = 0 WHERE username = 'ramesh'`).run()
const g3 = await A.login('ramesh', pwGuard, '10.0.0.53', T0)
const newPw = await A.resetPassword('ramesh')
ok(g3.ok && A.sessionUser(g3.token, T0) === null, 'resetting a password signs out old sessions')
ok(!(await A.login('ramesh', pwGuard, '10.0.0.54', T0)).ok, 'the old password stops working')
ok((await A.login('ramesh', newPw, '10.0.0.54', T0)).ok, 'the new password works')
A.setRole('head.office', 'guard'); A.setRole('head.office', 'viewer')
A.removeUser('head.office')
ok(!(await A.login('head.office', pwView, '172.16.1.9', T0)).ok, 'a removed account cannot sign in')

// lockout: 5 wrong for one account from one computer
const pwL = await A.addUser('locktest', 'viewer')
for (let i = 0; i < 5; i++) await A.login('locktest', 'wrong', '10.0.0.77', T0 + i)
const locked = await A.login('locktest', pwL, '10.0.0.77', T0 + 10)
ok(!locked.ok && 'locked' in locked && locked.locked! > 0, 'after 5 wrong tries even the right password is refused for a while')
ok((await A.login('locktest', pwL, '10.0.0.78', T0 + 10)).ok, 'another computer is not locked out by that')
ok((await A.login('locktest', pwL, '10.0.0.77', T0 + 16 * 60_000)).ok, 'the lock lifts after 15 minutes')

// permanent logins: set with an agreed password, idempotent
ok(await A.setUser('Security.Supervisor', 'guard', 'agreed-pass-1', 'Security Supervisor') === 'created', 'set creates a missing account')
const s1 = await A.login('security.supervisor', 'agreed-pass-1', '10.0.0.90', T0)
ok(s1.ok && s1.user.role === 'guard' && s1.user.name === 'Security Supervisor', 'it signs in with the agreed password')
ok(await A.setUser('security.supervisor', 'guard', 'agreed-pass-1', 'Security Supervisor') === 'updated' && s1.ok && A.sessionUser(s1.token, T0) !== null,
   'running the same set again keeps people signed in')
await A.setUser('security.supervisor', 'guard', 'agreed-pass-2', 'Security Supervisor')
ok(s1.ok && A.sessionUser(s1.token, T0) === null, 'a changed password signs the account out everywhere')
ok(!(await A.login('security.supervisor', 'agreed-pass-1', '10.0.0.91', T0)).ok && (await A.login('security.supervisor', 'agreed-pass-2', '10.0.0.91', T0)).ok,
   'only the new password works')
A.setDisabled('security.supervisor', true); await A.setUser('security.supervisor', 'viewer', 'agreed-pass-2')
const s2 = await A.login('security.supervisor', 'agreed-pass-2', '10.0.0.92', T0)
ok(s2.ok && s2.user.role === 'viewer' && s2.user.name === 'Security Supervisor', 'set switches it back on, changes the type, keeps the name when none given')
for (const bad of ['short-pw', 'has a space in it', ''])
  { threw = false; try { await A.setUser('x1', 'viewer', bad) } catch { threw = true }; ok(threw, `password "${bad}" is refused`) }

// helpers at the edge
ok(A.safeNext('/#analytics') === '/#analytics' && A.safeNext('/report/4') === '/report/4', 'a local path is kept')
for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/login?next=/', ''])
  ok(A.safeNext(bad) === '/', `next=${bad} must not redirect off the dashboard`)
ok(A.readCookie('a=1; mes_session=abc%3D; b=2') === 'abc=', 'reads the session cookie')
ok(A.readCookie('mes_session_other=1') === null, 'does not match a cookie with a longer name')
ok(A.isLoopback('::ffff:127.0.0.1') && A.isLoopback('::1') && !A.isLoopback('10.0.0.10'), 'loopback detection')
const src = A.eventSources()
ok(src.has('10.0.0.20') && src.has('10.1.2.3') && src.has('127.0.0.1') && !src.has('10.0.0.50'),
   'alerts accepted only from the AI Box, EVENTS_ALLOW and this PC')

console.log(process.exitCode ? 'FAIL (auth)' : 'auth assertions passed')
