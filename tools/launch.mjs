/**
 * The one thing a guard clicks.
 *
 * Starts the dashboard server if it is not already running, waits for it to answer,
 * then opens it full screen in Chrome. Safe to run twice — a second click just opens
 * another window rather than starting a second server.
 *
 * Run by the desktop icon and at login. Everything here goes through node.exe and
 * chrome.exe, which Windows Smart App Control allows.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))   // the project folder
process.chdir(root)

// Read PORT out of .env without needing the flag, so the icon and the server agree.
let port = process.env.PORT ?? '9000'
try {
  const env = (await import('node:fs')).readFileSync(join(root, '.env'), 'utf8')
  port = env.match(/^\s*PORT\s*=\s*(\d+)/m)?.[1] ?? port
} catch {}
const base = `http://localhost:${port}/`
// ?mode=simple: the guard screen, whether this PC opens without a password or is signed in as a login.
const url = `${base}?mode=simple`

const alive = async () => {
  try {
    const c = AbortSignal.timeout(1500)
    return (await fetch(base + 'api/version', { signal: c })).ok
  } catch { return false }
}

if (await alive()) {
  console.log('Dashboard already running.')
} else {
  console.log('Starting the dashboard...')
  // Started with no window, so keep a log — otherwise an unattended failure leaves
  // nothing to look at. `npm run doctor` and this file are the only diagnostics.
  mkdirSync(join(root, 'data'), { recursive: true })
  const log = openSync(join(root, 'data', 'server.log'), 'a')
  spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'],
        { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()

  let ok = false
  for (let i = 0; i < 40 && !(ok = await alive()); i++) await new Promise(r => setTimeout(r, 500))
  if (!ok) {
    console.log(`\nThe dashboard did not start.\n`)
    console.log(`Look at  ${join(root, 'data', 'server.log')}  for the reason,`)
    console.log(`or open a Command Prompt in ${root} and run  npm start\n`)
    process.exit(1)
  }
  console.log('Started.')
}

const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync)
const args = ['--kiosk', '--autoplay-policy=no-user-gesture-required', `--app=${url}`]

if (chrome) spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref()
else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
else spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()

console.log(`Opened ${url}`)
