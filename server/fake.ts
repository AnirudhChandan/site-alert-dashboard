/**
 * Replays plausible AI Box events so the whole dashboard can be built and demoed
 * before the real HTTP callback is switched on. The payload shape here is a GUESS
 * — the point is that swapping in the real one only touches normalize.ts.
 *
 * Posts `device_id` + `channel` (the same 8 channels as the site config), so
 * events resolve to the same `box1/chN` keys the live AI Box will produce.
 * Run: npm run fake       (PORT / EVERY env vars as for the server)
 */
const URL_ = process.env.URL ?? `http://localhost:${process.env.PORT ?? 8080}/events`

const EVENTS: [number, string][] = [
  [1, 'Animal Detection'],
  [2, 'Intrusion Detection'],
  [3, 'Helmet / Safety Vest - Not Wearing'],
  [4, 'Stopping Detection'],
  [5, 'Fallen Person Detection'],
  [6, 'Intrusion Detection'],
  [7, 'Animal Detection'],
  [8, 'Occupancy'],   // Security Room — a checkpoint: resets the absent-from-post clock
]

// 1x1 JPEG, stands in for the AI Box's pre/post snapshot.
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf' +
  '/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='

async function fire() {
  const [channel, event] = EVENTS[Math.floor(Math.random() * EVENTS.length)]
  const body = { device_id: 'box1', channel, event, timestamp: new Date().toISOString(), snapshot: JPEG }
  const r = await fetch(URL_, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  console.log(`ch${channel}`.padEnd(5), event.padEnd(36), (await r.json() as any).rule)
}

await fire()
setInterval(fire, Number(process.env.EVERY ?? 4000))
