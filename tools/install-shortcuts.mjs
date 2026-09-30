/**
 * Creates the things a guard actually needs, so nobody ever types a command:
 *
 *   Desktop → "Security Dashboard"      opens the dashboard full-screen in Chrome
 *   Startup → "Security Dashboard Server"  runs the server when the PC logs in
 *   Startup → "Security Dashboard"      opens the screen when the PC logs in
 *
 * Run:  npm run install-shortcuts       (Windows only; a no-op elsewhere)
 *
 * Shortcuts point at node.exe and chrome.exe — installed, signed programs — so
 * Windows Smart App Control does not block them the way it blocks a .bat file.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

if (process.platform !== 'win32') {
  console.log('\nThis only does something on Windows. Nothing to do here.\n')
  process.exit(0)
}

const here = process.cwd()
const url = `http://localhost:${process.env.PORT ?? '9000'}/`
const startup = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
const desktop = join(homedir(), 'Desktop')

const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
                .find(existsSync)
const node = process.execPath

/** Make one .lnk via the Windows scripting host, then read it back to prove it worked. */
function shortcut({ path, target, args = '', cwd = '', desc = '' }) {
  const q = (v) => String(v).replace(/'/g, "''")
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(path)}');` +
             `$s.TargetPath='${q(target)}';$s.Arguments='${q(args)}';` +
             `$s.WorkingDirectory='${q(cwd)}';$s.Description='${q(desc)}';$s.Save();` +
             `$c=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(path)}');` +
             `Write-Output "$($c.TargetPath)|$($c.Arguments)|$($c.WorkingDirectory)"`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0 || !existsSync(path)) {
    console.log(`  FAILED   ${path}`)
    console.log(`           ${(r.stderr || 'powershell did not report a reason').trim()}`)
    return false
  }
  console.log(`  created  ${path}`)
  console.log(`           runs: ${(r.stdout || '').trim().replace(/\|/g, '  ')}`)
  return true
}

/** An earlier version made a second startup item; two of them would double-start. */
function removeStale(path) {
  if (!existsSync(path)) return
  try { rmSync(path); console.log(`  removed  ${path}  (no longer used)`) } catch {}
}

console.log('\nSetting up the shortcuts...\n')

removeStale(join(startup, 'Security Dashboard Server.lnk'))

// One launcher does it all: start the server if needed, then open the screen.
// Both the desktop icon and the login item point at it, so there is nothing to
// get out of order and clicking the icon always works, even from a cold boot.
const launcher = { target: node, args: 'tools\\launch.mjs', cwd: here }

shortcut({ ...launcher, path: join(desktop, 'Security Dashboard.lnk'),
           desc: 'Opens the Site security dashboard' })
shortcut({ ...launcher, path: join(startup, 'Security Dashboard.lnk'),
           desc: 'Starts and opens the security dashboard when the PC logs in' })

if (!chrome) console.log(`  Chrome not found — the icon will use the default browser instead.`)

console.log(`
Done.

  • On the desktop there is an icon called "Security Dashboard" — that is the
    only thing a guard ever needs to touch. It starts everything and opens
    full screen, even if nothing was running before.
  • The same thing happens by itself when the PC logs in.
  • To leave full screen, press F11. To close it, Alt+F4.
  • For the wall TV, open ${url}?mode=tv

Restart the PC once to check it all comes back on its own.
`)
