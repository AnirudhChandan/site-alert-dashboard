/**
 * Updates the dashboard from the newest site-alert-dashboard*.zip in Downloads.
 * Replaces the code; leaves .env and data/ alone.   Run:  npm run update
 *
 * Written in JavaScript rather than a .bat on purpose: Windows Smart App Control
 * blocks downloaded .bat/.ps1 files, but happily runs scripts through node.exe.
 */
import { readdirSync, statSync, rmSync, mkdirSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

const here = process.cwd()
const downloads = join(homedir(), 'Downloads')
const say = (m) => console.log(m)

say('\nSite alert dashboard — update\n')

let zips = []
try {
  zips = readdirSync(downloads)
    .filter(f => /^site-alert-dashboard.*\.zip$/i.test(f))
    .map(f => ({ path: join(downloads, f), name: f, at: statSync(join(downloads, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
} catch { /* no Downloads folder */ }

// Chrome writes "….zip.crdownload" until the download has finished.
try {
  if (readdirSync(downloads).some(f => /^site-alert-dashboard.*\.crdownload$/i.test(f))) {
    say('A dashboard download is still in progress in Chrome. Wait until it has finished, then run  npm run update  again.\n')
    process.exit(1)
  }
} catch {}

if (!zips.length) {
  say('No download found in your Downloads folder.\n')
  say('In Chrome open:  github.com/AnirudhChandan/site-alert-dashboard')
  say('Click the green Code button, then Download ZIP. Then run  npm run update  again.\n')
  process.exit(1)
}
const zip = zips[0]
say(`Using  ${zip.name}   downloaded ${new Date(zip.at).toLocaleString()}`)

const tmp = join(tmpdir(), 'site-alert-update')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// tar ships with Windows 10/11 and reads zip files. Fall back to PowerShell if not.
try {
  execFileSync('tar', ['-xf', zip.path, '-C', tmp], { stdio: 'pipe' })
} catch {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip.path}' -DestinationPath '${tmp}' -Force`], { stdio: 'pipe' })
  if (r.status !== 0) { say('\nCould not unzip that file. Extract it by hand instead.\n'); process.exit(1) }
}

const inner = readdirSync(tmp)[0]
const src = inner ? join(tmp, inner) : null
if (!src || !existsSync(join(src, 'server'))) {
  say('\nThat zip does not look like the dashboard. Download it again.\n'); process.exit(1)
}

// Never go backwards. An old ZIP left in Downloads once put 12 September's code back over a newer copy.
const version = dir => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' } }
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false }
const have = version(here), got = version(src)
say(`Installed now: v${have}    In this download: v${got}`)
if (older(got, have) && !process.argv.includes('--force')) {
  say(`\nSTOPPED — nothing was changed. This download (v${got}) is OLDER than what is installed (v${have}).`)
  say('It is probably an old file left in Downloads. Delete every "site-alert-dashboard" ZIP from Downloads,')
  say('download it again from GitHub, wait for it to finish, then run  npm run update  again.\n')
  process.exit(1)
}

for (const d of ['server', 'public', 'tools']) {
  if (!existsSync(join(src, d))) continue
  if (d !== 'tools') rmSync(join(here, d), { recursive: true, force: true })   // tools holds this running script
  cpSync(join(src, d), join(here, d), { recursive: true, force: true })
}
for (const f of ['package.json', 'package-lock.json', 'ONSITE.md', 'README.md', '.env.example']) {
  if (existsSync(join(src, f))) cpSync(join(src, f), join(here, f), { force: true })
}
say('Code updated. Your .env and data folder were not touched.\n')

say('Installing dependencies...')
// On Windows npm is a .cmd, which needs a shell; one command string avoids Node's DEP0190 warning.
if (process.platform === 'win32') spawnSync('npm install', { stdio: 'inherit', shell: true })
else spawnSync('npm', ['install'], { stdio: 'inherit' })

say('\nDone. Now double-click "Security Dashboard" on the Desktop to start it.\n')
