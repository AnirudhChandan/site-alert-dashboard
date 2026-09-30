import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ruleFrom, SEVERITY, type Rule } from './rules.ts'

export type Normalized = {
  camera_id: string
  rule: Rule
  severity: string
  ts: number
  snapshot: string | null
  raw: string
}

const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => a?.[p], o)
    if (v !== undefined && v !== null && v !== '') return v
  }
}

/**
 * Map an AI Box HTTP event onto our alert shape.
 *
 * The payload shape was not known when this was written. So this
 * reads every field name the Ganz docs and comparable VMS webhooks plausibly use,
 * and the untouched body is always stored in `raw` so nothing is lost when the
 * first real event turns out to look different.
 */
export function normalize(body: any): Normalized {
  const box     = pick(body, 'device_id', 'deviceId', 'box_id', 'source') ?? 'box1'
  const channel = pick(body, 'channel', 'channel_id', 'channelId', 'ch', 'camera.channel')
  const name    = pick(body, 'camera_name', 'cameraName', 'channel_name', 'camera.name')

  // System & I/O rules (the four PATROLLING alarm inputs) carry no channel at all.
  // Give each its own id from the event name so the four checkpoints stay distinct.
  const evName = String(pick(body, 'event', 'eventName', 'event_name') ?? '')
  const patrol = evName.match(/patrol\w*\s*-?\s*(\d+)/i)

  // Prefer the box+channel key; fall back to the camera's display name so an
  // event is never dropped just because the channel field was missing.
  const camera_id = patrol ? `patrol/${patrol[1]}`
    : channel !== undefined && channel !== null && channel !== '' ? `${box}/ch${channel}`
    : String(name ?? 'unknown')

  const text = [
    pick(body, 'event', 'eventName', 'event_name', 'rule', 'rule_name'),
    pick(body, 'event_type', 'eventType', 'type', 'app', 'app_name'),
    pick(body, 'description', 'message'),
  ].filter(Boolean).join(' ')

  const rawTs = pick(body, 'timestamp', 'ts', 'time', 'event_time')
  const ts = typeof rawTs === 'number'
    ? (rawTs < 1e12 ? rawTs * 1000 : rawTs)          // seconds vs milliseconds
    : rawTs ? Date.parse(rawTs) || Date.now()
    : Date.now()

  return {
    camera_id,
    rule: ruleFrom(text),
    severity: SEVERITY[ruleFrom(text)],
    ts,
    snapshot: saveSnapshot(body),
    raw: JSON.stringify(body),
  }
}

/** The AI Box may send the snapshot inline (base64) or as a URL back to itself. */
function saveSnapshot(body: any): string | null {
  const b64 = pick(body, 'snapshot', 'image', 'image_base64', 'jpeg', 'picture')
  if (typeof b64 !== 'string' || b64.length < 100) return null
  if (/^https?:\/\//.test(b64)) return b64            // a URL — store as-is, fetch lazily
  const file = `${randomUUID()}.jpg`
  writeFileSync(`data/snapshots/${file}`, Buffer.from(b64.replace(/^data:.*?,/, ''), 'base64'))
  return file
}
