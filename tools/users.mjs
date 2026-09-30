/**
 * Accounts for people who open the dashboard from another computer (head office, a manager's laptop).
 * The guard-room PC itself never needs one.
 *
 *   npm run users                               list accounts
 *   npm run users add hq viewer Head Office  new view-only account (prints its password once)
 *   npm run users add ramesh guard Ramesh        new guard account (can mark alerts)
 *   npm run users reset hq                      new password; signs it out everywhere
 *   npm run users disable hq                    switch off at once   (enable to switch back on)
 *   npm run users remove hq                     delete
 *   npm run users role hq guard                 change what it may do
 *   npm run users set admin guard <password> Admin     create or update with a password agreed in advance
 */
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.chdir(root)
if (existsSync('.env')) process.loadEnvFile('.env')
// A file URL, not a plain path: on Windows import('C:\\...') fails ("Received protocol 'c:'").
const A = await import(pathToFileURL(join(root, 'server/auth.ts')).href)

const [cmd = 'list', user, ...rest] = process.argv.slice(2)
const when = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'
const addresses = () => Object.values(networkInterfaces()).flat()
  .filter(n => n.family === 'IPv4' && !n.internal).map(n => `http://${n.address}:${process.env.PORT ?? 9000}`)

function showPassword(u, pw) {
  console.log(`\n  Username:  ${u}\n  Password:  ${pw}\n`)
  console.log('  Write this down now — it is not shown again (use  reset  if it is lost).')
  console.log(`  They open the dashboard at one of:  ${addresses().join('   ') || '(this PC has no network address)'}\n`)
}

try {
  switch (cmd) {
    case 'list': {
      const rows = A.listUsers()
      if (!rows.length) console.log('\nNo accounts yet. The guard-room PC works without one.\nCreate one with:  npm run users add hq viewer Head Office\n')
      else {
        console.log('\nUSERNAME              ACCESS        NAME                  STATUS  LAST USED')
        for (const r of rows)
          console.log(`${r.username.padEnd(22)}${(r.role === 'guard' ? 'full access' : 'view only').padEnd(14)}${r.name.slice(0, 20).padEnd(22)}${(r.disabled ? 'OFF' : 'on').padEnd(8)}${when(r.last_seen)}`)
        console.log('\nfull access (guard) = can mark alerts, add reasons and comments.   view only (viewer) = can only look.\n')
      }
      break
    }
    case 'add': {
      const role = rest.shift() ?? 'viewer'
      showPassword(A.cleanUsername(user), await A.addUser(user, role, rest.join(' ')))
      break
    }
    case 'set': {
      const [role, password, ...name] = rest
      const u = A.cleanUsername(user), result = await A.setUser(user, role, password, name.join(' '))
      const row = A.listUsers().find(r => r.username === u)
      console.log(`\n  "${u}" ${result}:  ${row.role === 'guard' ? 'full access' : 'view only'},  shown as "${row.name}".`)
      console.log('  It signs in with the password you just typed. Close this window afterwards so it is not left on screen.')
      console.log(`  Address:  ${addresses().join('   ') || '(this PC has no network address)'}\n`)
      break
    }
    case 'reset': showPassword(A.cleanUsername(user), await A.resetPassword(user)); break
    case 'disable': A.setDisabled(user, true); console.log(`"${user}" is switched off and signed out everywhere.`); break
    case 'enable': A.setDisabled(user, false); console.log(`"${user}" is switched on again.`); break
    case 'remove': A.removeUser(user); console.log(`"${user}" is deleted.`); break
    case 'role': A.setRole(user, rest[0]); console.log(`"${user}" is now: ${rest[0]}.`); break
    default: console.log('Unknown command. Try:  npm run users   or   npm run users add hq viewer Head Office')
  }
} catch (e) {
  console.error(`\nCould not do that: ${e.message}\n`)
  process.exitCode = 1
}
