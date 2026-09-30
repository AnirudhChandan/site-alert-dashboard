/**
 * Tells you, in one screen, exactly what is running and what is wrong.
 * Run:  npm run doctor      Send the maintainer a photo of the output when anything misbehaves.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// import() needs a file URL: a Windows path like C:\\... is refused ("Received protocol 'c:'").
const load = rel => import(pathToFileURL(join(root, rel)).href)

const ok = m => console.log('  OK    ' + m)
const bad = m => console.log('  BAD   ' + m)
const info = m => console.log('        ' + m)
const root = process.cwd()

console.log('\n=========  Site alert dashboard — check-up  =========\n')

// --- the code itself -------------------------------------------------------
let pkg = {}
try { pkg = JSON.parse(readFileSync('package.json', 'utf8')) } catch {}
console.log(`FOLDER   ${root}`)
console.log(`VERSION  ${pkg.version ?? 'unknown'}`)
console.log(`NODE     ${process.version}\n`)

console.log('FILES')
const ui = existsSync('public/index.html') ? readFileSync('public/index.html', 'utf8') : ''
ui.includes('camstrip')
  ? ok('the dashboard page is the new one')
  : bad('the dashboard page is OLD — run  npm run update  (this is usually the problem)')
existsSync('tools/launch.mjs') ? ok('launcher present') : bad('tools/launch.mjs missing — run  npm run update')
existsSync('node_modules/hls.js') ? ok('video library installed') : bad('hls.js missing — run  npm install')

// --- configuration ---------------------------------------------------------
console.log('\nSETTINGS')
let port = process.env.PORT ?? '9000', envTxt = ''
try { envTxt = readFileSync('.env', 'utf8'); ok('.env found') } catch { bad('.env missing — copy .env.example to .env') }
port = envTxt.match(/^\s*PORT\s*=\s*(\d+)/m)?.[1] ?? port
info(`port ${port}`)
const hasPass = /^\s*AIBOX_PASS\s*=\s*\S/m.test(envTxt)
hasPass ? ok('AI Box password is set')
        : bad('AIBOX_PASS is empty in .env — no photos and no live video without it')

// --- is it actually running? -----------------------------------------------
console.log('\nRUNNING')
const url = `http://localhost:${port}/`
let meta = null
try {
  const r = await fetch(url + 'api/meta', { signal: AbortSignal.timeout(3000) })
  if (r.status === 401) {
    const v = await (await fetch(url + 'api/version')).json().catch(() => ({}))
    ok(`dashboard is answering on ${url}`)
    v.version === pkg.version
      ? ok(`the running copy is v${v.version} — matches these files`)
      : bad(`the RUNNING copy is v${v.version} but these files are v${pkg.version} — npm run stop, then double-click the icon`)
    info('this PC signs in with a login (KIOSK_LOCAL=0), so camera and AI Box details are not checked here')
    throw 0
  }
  meta = await r.json()
  ok(`dashboard is answering on ${url}`)
  meta.version === pkg.version
    ? ok(`the running copy is v${meta.version} — matches these files`)
    : bad(`the RUNNING copy is v${meta.version} but these files are v${pkg.version} — stop it and start it again`)
  ok(`${meta.cameras?.filter(c => /ch\d+$/.test(c.id)).length ?? 0} cameras, ${meta.checkpoints?.length ?? 0} checkpoints`)
  meta.live ? ok('live pictures available') : bad('live pictures OFF — check AIBOX_PASS')
  const h = meta.health
  if (h) h.state === 'ok' ? ok(`AI Box signals arriving (warns after ${h.silentMin} min of silence)`)
    : h.state === 'silent' ? bad(`AI Box SILENT since ${new Date(h.since).toLocaleTimeString()} — no alerts or patrol signals. Is it on and sending?`)
    : bad('AI Box NOT ANSWERING — check its power and network cable')
} catch (e) {
  if (e !== 0) bad(`nothing is answering on ${url}`)
  if (e !== 0) info('start it with  npm start  , or double-click the desktop icon')
}

// --- who can see it --------------------------------------------------------
console.log('\nACCOUNTS')
try {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const { listUsers, eventSources } = await load('server/auth.ts')
  const users = listUsers(), on = users.filter(u => !u.disabled)
  info(`${on.filter(u => u.role === 'viewer').length} view-only, ${on.filter(u => u.role === 'guard').length} guard account(s)` +
       (users.length > on.length ? `, ${users.length - on.length} switched off` : '') + '   (list them:  npm run users)')
  process.env.KIOSK_LOCAL === '0' ? info('this PC must sign in too (KIOSK_LOCAL=0)') : ok('this PC opens the dashboard without signing in')
  info(`alerts accepted only from: ${[...eventSources()].join(', ')}`)
} catch (e) { bad(`could not read accounts — ${e.message}`) }

console.log('\nDOWNLOADS')
try {
  const { PDF_BROWSER } = await load('server/export.ts')
  PDF_BROWSER ? ok(`PDF files are made with ${PDF_BROWSER}`)
              : bad('no Chrome or Edge found — Download → PDF will not work (Print still does). Set CHROME_PATH in .env')
} catch (e) { bad(`could not check downloads — ${e.message}`) }

// --- the AI Box ------------------------------------------------------------
console.log('\nAI BOX')
const boxUrl = envTxt.match(/^\s*AIBOX_URL\s*=\s*(\S+)/m)?.[1] ?? 'https://10.0.0.20:8443'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
process.removeAllListeners('warning')
try {
  const user = envTxt.match(/^\s*AIBOX_USER\s*=\s*(\S+)/m)?.[1] ?? 'admin'
  const pass = envTxt.match(/^\s*AIBOX_PASS\s*=\s*(.+)$/m)?.[1]?.trim() ?? ''
  const r = await fetch(`${boxUrl}/api/auth/login/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }), signal: AbortSignal.timeout(5000) })
  r.ok ? ok(`logged in to the AI Box at ${boxUrl}`) : bad(`AI Box refused the login (HTTP ${r.status}) — check AIBOX_USER / AIBOX_PASS`)
} catch (e) { bad(`cannot reach the AI Box at ${boxUrl} — ${e.message}`) }

// --- shortcuts -------------------------------------------------------------
if (process.platform === 'win32') {
  console.log('\nSHORTCUTS')
  const desktop = join(homedir(), 'Desktop')
  const startup = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  for (const [where, dir] of [['Desktop', desktop], ['Startup', startup]]) {
    const f = join(dir, 'Security Dashboard.lnk')
    if (!existsSync(f)) { bad(`${where}: no shortcut — run  npm run install-shortcuts`); continue }
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${f}');` +
               `"$($s.TargetPath)|$($s.Arguments)|$($s.WorkingDirectory)"`
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout?.trim() ?? ''
    const [target, args, cwd] = out.split('|')
    if (/launch\.mjs/.test(args ?? '')) ok(`${where}: points at the launcher`)
    else bad(`${where}: OLD shortcut (runs "${args}") — run  npm run install-shortcuts`)
    info(`${target} ${args}`)
    if (cwd && cwd.toLowerCase() !== root.toLowerCase())
      bad(`${where}: "Start in" is ${cwd || '(empty)'} — should be ${root}`)
  }
  const stale = join(startup, 'Security Dashboard Server.lnk')
  if (existsSync(stale)) bad(`Startup: leftover "Security Dashboard Server" — run  npm run install-shortcuts to clean it up`)
}

console.log('\n======================================================\n')
