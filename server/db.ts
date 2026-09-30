import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'

// DATA_DIR lets the test suite use a scratch directory instead of the live database.
const DIR = process.env.DATA_DIR ?? 'data'
mkdirSync(`${DIR}/snapshots`, { recursive: true })

export const db = new Database(`${DIR}/alerts.db`)
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS cameras (
  id        TEXT PRIMARY KEY,   -- our stable key, e.g. "box1/ch3"
  name      TEXT NOT NULL,      -- as it appears in the Ganz software, e.g. "Gate 2"
  location  TEXT NOT NULL       -- plain English, e.g. "Boundary grill corner"
);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id     TEXT NOT NULL,
  rule          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  ts            INTEGER NOT NULL,          -- epoch ms
  snapshot      TEXT,                      -- path under data/snapshots, nullable
  raw           TEXT NOT NULL,             -- original payload, always kept
  ack_by        TEXT,
  ack_at        INTEGER,
  outcome       TEXT,                      -- 'action_taken' | 'false_alarm'
  note          TEXT,
  resolved_at   INTEGER,                   -- only used by the timer rules
  reason        TEXT                       -- one-tap reason code, see REASONS in rules.ts
);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts DESC);

-- Drives the patrol / absent-from-post timers. One row per checkpoint.
-- Lives in SQLite (not memory) so the timers survive a server restart.
CREATE TABLE IF NOT EXISTS checkpoints (
  camera_id      TEXT PRIMARY KEY,
  rule           TEXT NOT NULL,     -- 'patrol_missed' | 'post_unmanned'
  threshold_min  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  muted_until    INTEGER
);
`)

// Columns added after the first install: an existing database on site gets them too.
const alertCols = new Set((db.prepare(`PRAGMA table_info(alerts)`).all() as any[]).map(c => c.name))
if (!alertCols.has('reason')) db.exec(`ALTER TABLE alerts ADD COLUMN reason TEXT`)

export const insertAlert = db.prepare(`
  INSERT INTO alerts (camera_id, rule, severity, ts, snapshot, raw)
  VALUES (@camera_id, @rule, @severity, @ts, @snapshot, @raw)
`)

export const listAlerts = db.prepare(`
  SELECT a.*, c.name AS camera_name, c.location
  FROM alerts a LEFT JOIN cameras c ON c.id = a.camera_id
  WHERE (@rule IS NULL OR a.rule = @rule)
    AND (@camera IS NULL OR a.camera_id = @camera)
    AND (@unacked = 0 OR a.ack_at IS NULL)
    AND (@from IS NULL OR a.ts >= @from)
    AND (@to IS NULL OR a.ts < @to)
  ORDER BY a.ts DESC LIMIT @limit
`)

export const getAlert = db.prepare(`
  SELECT a.*, c.name AS camera_name, c.location
  FROM alerts a LEFT JOIN cameras c ON c.id = a.camera_id WHERE a.id = ?
`)

export const ackAlert = db.prepare(`
  UPDATE alerts SET ack_by = @ack_by, ack_at = @ack_at, outcome = @outcome, note = COALESCE(@note, note), reason = @reason
  WHERE id = @id AND ack_at IS NULL
`)

export const upsertCamera = db.prepare(`
  INSERT INTO cameras (id, name, location) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, location = excluded.location
`)

export const setNote = db.prepare(`UPDATE alerts SET note = @note WHERE id = @id`)

// Guards mis-tap. Undo puts an alert straight back into the "needs attention" pile.
export const unackAlert = db.prepare(
  `UPDATE alerts SET ack_by = NULL, ack_at = NULL, outcome = NULL, reason = NULL WHERE id = ?`)
export const setReason = db.prepare(`UPDATE alerts SET reason = @reason WHERE id = @id AND ack_at IS NOT NULL`)

/** Other alerts on the same camera within ±30 min — context for an incident report. */
export const nearby = db.prepare(`
  SELECT a.id, a.rule, a.severity, a.ts, a.ack_by, a.outcome FROM alerts a
  WHERE a.camera_id = @camera_id AND a.id != @id AND a.ts BETWEEN @ts - 1800000 AND @ts + 1800000
  ORDER BY a.ts
`)
