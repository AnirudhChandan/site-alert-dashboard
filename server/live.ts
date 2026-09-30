/**
 * Near-live thumbnails: data/live/<id>.jpg refreshed about once a second.
 *
 * Preferred source — the AI Box's own snapshot API (it already decodes all 8
 * streams): no ffmpeg, no camera passwords. Needs AIBOX_USER / AIBOX_PASS in .env.
 *
 * Fallback — one ffmpeg per camera pulling RTSP directly (needs ffmpeg on PATH and
 * RTSP_USER / RTSP_PASS). LIVE_TEST=1 uses ffmpeg's test pattern for demos.
 *
 * With neither, the feature is simply off; nothing else changes.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { CAMERAS, cameraId } from './seed.ts'
import { aiboxOk, snapshot, frames, boxContact } from './aibox.ts'

export const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0
export const liveOk = aiboxOk || ffmpegOk
export const liveName = (id: string) => `${id.replace('/', '_')}.jpg`
export const liveFile = (id: string) => `data/live/${liveName(id)}`

export function startLive() {
  mkdirSync('data/live', { recursive: true })
  if (aiboxOk && !process.env.LIVE_TEST) return startFromBox()
  if (!ffmpegOk) { console.log('live thumbs  off (no AI Box login, no ffmpeg)'); return }
  const U = process.env.RTSP_USER, P = process.env.RTSP_PASS ?? ''
  const withCreds = (url: string) => U ? url.replace('rtsp://', `rtsp://${encodeURIComponent(U)}:${encodeURIComponent(P)}@`) : url
  for (const c of CAMERAS) runFfmpeg(cameraId(c.ch), withCreds(c.rtsp))
  console.log(`live thumbs  ffmpeg, ${CAMERAS.length} cameras${process.env.LIVE_TEST ? '  (TEST PATTERN)' : ''}`)
}

// One camera per ~125 ms, round-robin: ~8 requests/s to the box, each camera ~1 fps.
function startFromBox() {
  boxContact.polling = true
  let i = 0
  const tick = async () => {
    const c = CAMERAS[i++ % CAMERAS.length]
    const jpg = await snapshot(c.ch)
    if (jpg) frames.set(liveName(cameraId(c.ch)), { jpg, at: Date.now() })
  }
  setInterval(tick, 1000 / CAMERAS.length).unref()
  console.log(`live thumbs  from AI Box snapshot API, ${CAMERAS.length} cameras`)
}

function runFfmpeg(id: string, url: string, backoff = 2000) {
  const input = process.env.LIVE_TEST
    ? ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=1']
    : ['-rtsp_transport', 'tcp', '-i', url, '-vf', 'scale=480:-2']
  const p = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', ...input,
    '-r', '1', '-f', 'image2', '-atomic_writing', '1', '-update', '1', '-y', liveFile(id)])
  p.stderr.on('data', d => process.env.LIVE_DEBUG && console.error(`[${id}]`, String(d).trim()))
  p.on('exit', () => setTimeout(() => runFfmpeg(id, url, Math.min(backoff * 2, 60_000)), backoff))
}

/** True if this camera's thumbnail was refreshed in the last 10 s. */
export const liveFresh = (id: string) => {
  const f = frames.get(liveName(id)); if (f) return Date.now() - f.at < 10_000
  try { return Date.now() - statSync(liveFile(id)).mtimeMs < 10_000 } catch { return false }
}
