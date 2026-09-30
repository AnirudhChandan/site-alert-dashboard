/**
 * Stops the dashboard. Needed because the launcher runs it with no window, so there
 * is nothing to press Ctrl+C in.   Run:  npm run stop
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let port = process.env.PORT ?? '9000'
try { port = readFileSync('.env', 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m)?.[1] ?? port } catch {}

if (process.platform !== 'win32') {
  spawnSync('pkill', ['-f', 'server/index.ts'])
  console.log('\nStopped.\n'); process.exit(0)
}

// Find whoever holds the port, then end that process.
const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
const pids = [...new Set(out.split('\n')
  .filter(l => l.includes(`:${port}`) && l.includes('LISTENING'))
  .map(l => l.trim().split(/\s+/).pop())
  .filter(p => p && p !== '0'))]

if (!pids.length) { console.log(`\nNothing is running on port ${port}.\n`); process.exit(0) }
for (const pid of pids) {
  const r = spawnSync('taskkill', ['/PID', pid, '/F'], { encoding: 'utf8' })
  console.log(r.status === 0 ? `  stopped process ${pid}` : `  could not stop ${pid}: ${(r.stderr || '').trim()}`)
}
console.log('\nStopped. Double-click the desktop icon to start it again.\n')
