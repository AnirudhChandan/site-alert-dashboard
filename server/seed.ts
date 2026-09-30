/**
 * Site config — read off the AI Box web UI.
 *
 * One Ganz AI Box (10.0.0.20), 8 channels. The cameras are ordinary RTSP cameras from
 * mixed vendors; every bit of AI lives in the box. Addresses and locations here are demo values.
 *
 * The camera names on the box itself stay "Camera 1..8" (not ours to change), so the
 * real locations live here instead. Fill in the `location` values as they are confirmed
 * and the dashboard, the voice announcements and the reports all pick them up.
 */
type Cam = { ch: number; ip: string; model: string; location?: string }

export const CAMERAS: Cam[] = [
  { ch: 1, ip: '10.0.0.101', model: 'RTSP camera', location: 'Generator Room' },
  { ch: 2, ip: '10.0.0.102', model: 'RTSP camera' },
  { ch: 3, ip: '10.0.0.103', model: 'RTSP camera' },
  { ch: 4, ip: '10.0.0.104', model: 'RTSP camera' },
  { ch: 5, ip: '10.0.0.105', model: 'RTSP camera' },
  { ch: 6, ip: '10.0.0.106', model: 'RTSP camera' },
  { ch: 7, ip: '10.0.0.107', model: 'RTSP camera' },
  { ch: 8, ip: '10.0.0.108', model: 'RTSP camera', location: 'Security Room' },
]

/**
 * Timer rules — the part no camera can do, because they are about something NOT happening.
 *
 * PATROLLING 1–4 are the box's four **Alarm In** contacts (rules #6012/#5408/#2116/#2427,
 * "System & I/O"). The guard triggers one when he reaches a checkpoint, so each arriving
 * event is a check-in that resets that checkpoint's clock. If 60 minutes pass with no
 * check-in, this dashboard raises "Patrol Not Done" — the box never will.
 *
 * Security Room (ch8) is the guard post: 15 min is a placeholder until the client
 * gives a number. The box also has its own "Security Person absent"
 * rule on that camera; both feed the same picture.
 */
const CHECKPOINTS: { id: string; name: string; rule: 'patrol_missed' | 'post_unmanned'; threshold_min: number }[] = [
  { id: 'patrol/1',  name: 'Patrol point 1',  rule: 'patrol_missed', threshold_min: 60 },
  { id: 'patrol/2',  name: 'Patrol point 2',  rule: 'patrol_missed', threshold_min: 60 },
  { id: 'patrol/3',  name: 'Patrol point 3',  rule: 'patrol_missed', threshold_min: 60 },
  { id: 'patrol/4',  name: 'Patrol point 4',  rule: 'patrol_missed', threshold_min: 60 },
  { id: 'box1/ch8',  name: 'Security Room',   rule: 'post_unmanned', threshold_min: 15 },
]

/**
 * The people who acknowledge alerts. They tap a name instead of typing it — a guard
 * on a night shift should not have to spell his own name into a dialog box.
 * Edit this list as staff change; nothing else needs to change.
 */
export const GUARDS = ['Ramesh', 'Suresh', 'Vikram', 'Supervisor']

export const cameraId = (ch: number) => `box1/ch${ch}`

export function seedSite({ upsertCamera, addCheckpoint, db }: any) {
  const now = Date.now()
  for (const c of CAMERAS)
    upsertCamera.run(cameraId(c.ch), c.location ?? `Camera ${c.ch}`,
                     c.location ? `${c.ip} · ${c.model}` : `${c.ip} · ${c.model} — location TBC`)
  // The four alarm-input checkpoints are not cameras, but they need a name in the UI.
  for (const c of CHECKPOINTS.filter(c => c.id.startsWith('patrol/')))
    upsertCamera.run(c.id, c.name, 'Guard checkpoint (alarm input on the AI Box)')

  for (const c of CHECKPOINTS)
    addCheckpoint.run({ camera_id: c.id, rule: c.rule, threshold_min: c.threshold_min, last_seen_at: now })

  // Drop checkpoints no longer in config, else a stale row keeps a phantom timer alive.
  const keep = CHECKPOINTS.map(c => c.id)
  db.prepare(`DELETE FROM checkpoints WHERE camera_id NOT IN (${keep.map(() => '?').join(',')})`).run(...keep)
}
