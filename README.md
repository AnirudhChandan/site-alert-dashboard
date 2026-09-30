# Site Alert Dashboard — AI CCTV alerts for a guard room

One screen that consolidates all 7 AI CCTV alert types for a residential site's guard office,
with acknowledgement, history, and the patrol timers the AI Box itself cannot do.

> This is a sanitised public copy of a dashboard that runs in production on a guard-room PC.
> The client's name, addresses, network layout and camera inventory have been replaced with
> demo values; the code is otherwise what runs on site.

```bash
npm install
npm start          # dashboard on http://localhost:8090, events in on POST /events
npm run fake       # simulated AI Box events, for building/demoing without site access
npm test           # patrol timers + report, sign-in (sessions, lockout, disable), downloads (xlsx/csv safety)
npm run update     # pull the newest ZIP from Downloads over this install (keeps .env and data)
npm run install-shortcuts   # Windows: desktop icon + start-on-boot, so a guard never types a command
npm run launch     # what that icon runs: start the server if needed, then open it full screen
npm run doctor     # one-screen check-up: versions, config, AI Box login, shortcuts
npm run stop       # stop the background server (the launcher starts it with no window)
npm run users      # accounts for other computers: add NAME viewer|guard [Full Name], reset, disable, enable, remove, role
```

## How it fits together

```
Ganz AI Box(es) ──HTTP POST /events──▶ Fastify ──▶ SQLite ──SSE──▶ browser
```

The AI Box's native "Event → Action → Network → HTTP" callback does the integration. No SDK,
no Ganz partner NDA, no CORTROL API.

| File | Does |
|---|---|
| `server/index.ts` | HTTP routes, SSE fan-out, the 60s timer tick |
| `server/normalize.ts` | Maps the AI Box payload onto our alert shape. **Always keeps `raw`.** |
| `server/rules.ts` | The 7 rules, severities, and keyword→rule matching |
| `server/patrol.ts` | Patrol / absent-from-post timers — the only real business logic |
| `server/seed.ts` | Site config: cameras, guard names, checkpoints and their thresholds. |
| `server/live.ts` | Live frames: AI Box snapshot API (preferred) or ffmpeg/RTSP fallback. |
| `server/aibox.ts` | AI Box HTTP API: login, event snapshots, HLS proxy, event log. |
| `server/auth.ts` | Accounts, sessions, lockout, and who may send alerts. |
| `server/report.ts` | Patrol compliance report: visits, gaps, day/night/total % per checkpoint. |
| `public/index.html` | The whole dashboard UI. No build step, no bundler. |

## Wall-TV mode and sound

Open `/?mode=tv` on the guard-room screen: no controls, a big **ALL CLEAR** / **N ALERTS NEED
ATTENTION** banner, the map, and the last six alerts in large type. Every critical/high alert is
chimed (distinct tones per severity) and spoken in English then Hindi via the browser's built-in
`speechSynthesis` — no library, no internet. Anything unacknowledged for a minute is repeated every
minute and its card grows until someone acts.

Browsers block audio until the page is clicked once. On the TV a full-screen "tap to start" handles
it; for a true hands-off kiosk launch Chrome as:

```
chrome --kiosk --autoplay-policy=no-user-gesture-required http://localhost:8090/?mode=tv
```

Install a Hindi voice on the PC (Windows: Settings → Time & Language → Speech → add Hindi) or the
Hindi line falls back to the default voice.

## Built for guards, not for engineers

- **Language** — a header button switches the entire UI between English and Hindi, remembered per
  screen. Spoken alerts are always in both.
- **Who is on duty** — guards tap their name once a shift (`GUARDS` in `server/seed.ts`), then
  acknowledging is a single button. No typing at 3am.
- **Plain buttons** — "Checked — all fine" / "Checked — real problem", not "false_alarm".
- **Undo** — six seconds to take back a mis-tap, which on a touch screen happens constantly.
- **One icon** — `npm run install-shortcuts` puts a full-screen desktop launcher and start-on-boot
  in place; the guard never sees a terminal.

## Live view

**One big picture plus a strip of small ones.** Only the big one plays video — eight simultaneous
streams would load the AI Box, and nobody can watch eight anyway. Click a small one to promote it,
double-click (or the ⛶ button) for true fullscreen, **Show all** for a large grid.

**When an alert fires, that camera becomes the big one automatically** for 30 seconds, with a red
border and an ALERT HERE badge, then it goes back to whatever was selected. That is the feature a
guard actually benefits from: look up, already seeing the right place.

Video comes from the AI Box's own HLS stream through a proxy at `/hls/*` that adds the bearer token
(its HLS endpoint accepts no other auth); hls.js is served from `node_modules/hls.js/dist` at
`/vendor/`. If a stream will not play, that panel falls back to a still refreshed once a second
(`/api/snapshot/jpeg/`, the box's own cap) and the header says so. The strip refreshes round-robin,
one camera every 250 ms; an offline camera is retried far less often.

Frames are held in memory, never written to disk — Windows refuses to rename over a file the
browser is reading (`EPERM`), which used to kill the process.

`ffmpeg` + `RTSP_USER`/`RTSP_PASS` remain as a fallback path when there is no AI Box login;
`LIVE_TEST=1` uses ffmpeg's test pattern for demos with no cameras around.

## Patrol report

The **Patrol** chip shows, per checkpoint and per day: every visit as a green tick, every gap
(time past the threshold with nobody seen) as a red block, and Day / Night / Total compliance
(day = 06:00–18:00). ‹ › steps through days; **Print / PDF** gives the property manager a
one-page report. Gaps come from the timer alerts this dashboard raised, so the report is exact,
not estimated. Rows appear once checkpoints have real channels (today only ch8, Security Room).

## The four pages

One tab bar; exactly one page on screen. The page is in the address (`#live`, `#alerts`, `#patrol`,
`#analytics`), so Back works and a refresh keeps you where you were. Every page opens with its name
and one sentence saying what it is for, with that page's buttons on the right.

| Page | For | What is on it |
|---|---|---|
| **Live** | guards | One big camera + a strip of the rest, and **Needs checking** — every alert nobody has marked yet. A critical alert brings you here from any page and puts its camera on the big screen. |
| **Alerts** | supervisors | Every alert. Search, camera, date range (Today / 7 / 30 days / All time), status (Not checked / Real problem / False alarm), type chips with counts, Download. Replaces the old History section. |
| **Patrol** | manager | Per checkpoint, per day: visits, gaps, day/night/total compliance. Download. |
| **Analytics** | manager | Today / 7 / 30 days. *In plain words* — the same numbers written as sentences, in English and Hindi. Six headline numbers, each with a one-line explanation and the change against the previous period in words. One card per alert type (count, share, daily chart, real / not checked / false alarm, busiest camera and hour). When, where, how quickly, who checked, and the camera × hour heatmap. Tap any card, bar or square to open those alerts. Download. |

`/api/analytics?period=hour|today|yesterday|week|7d|month|30d|90d|custom[&from=&to=][&group=hour|day|week|month]`
(old `?days=1|7|30` still works) computes every number and the summary sentences in one place, so the charts
and the words cannot disagree. `resolvePeriod` in `report.ts` turns the choice into exact times: weeks start
Monday, a custom range includes its last day, back-to-front or nonsense dates fall back to 7 days. Each period
is compared with the one before it cut to the same length ("this week until Wed 3 pm" against "last week until
Wed 3 pm"), and there is no comparison at all before the first alert ever recorded. `group` splits the *Alerts
over time* chart; left out it follows the length (≤2 days hourly, ≤62 daily, ≤200 weekly, else monthly), and more
than 400 bars moves to the next coarser step. Tapping a bar opens Alerts for exactly that span (`from`/`to`).

## For the guards (v0.8)

**Simple mode.** The guard-room PC (the loopback kiosk) opens with only Live and *Needs checking*, larger
targets, no tabs, no incident-report links. `?mode=simple|full` sets it per screen (localStorage);
*Manager view* opens everything for this window only (sessionStorage), so a restart always comes back simple.

**One-tap reasons.** After *Real problem* / *All fine* the card offers reasons that fit the alert type
(`REASONS` in `rules.ts`: code, outcome, en/hi label, optional `only: [rules]`). `POST /api/alerts/:id/reason`
(guard only, must be checked, must fit rule + outcome, `null` clears); undo clears it. Stored in `alerts.reason`
(added to existing databases on start). Analytics: `reasons.false_alarm|action_taken` with given/total, an
insight sentence once 3+ reasons exist, bars that open Alerts filtered by `reason`. Exports gain a Reason column
and a Reasons sheet; the incident report states it. Card changes (checked, undone, reason, note, photo) now push
to every open screen as `_update` rows.

**AI Box silent.** `health.ts`: *unreachable* when the box has not answered the live-picture requests for 3 min
(only with an AI Box login), *silent* when no `/events` at all for `SILENT_MINUTES` (default 180). Both count from
server start. Pushed as an SSE `health` event on change and on connect, logged, shown in `npm run doctor`. The page
shows an amber / red banner on every screen and speaks it (guards, sound on) at once and every 10 min; *Quiet for
1 hour* mutes the voice only.

**Sound menu (v0.8.1).** Per screen: *Sound and voice*, *Chime only*, *Off for 30 min / 1 hour* (comes back on by
itself; checked on every chime and every 15 s), or *Off*. The header pill says which, and turns amber when a guard
screen is silent. Guard screens default to on, view-only screens to off; old `sound=1/0` settings carry over.

`npm test` covers the thresholds, restart grace, reason fitting, and the database upgrade.

## Print and Download (v0.7)

Two buttons on Alerts, Patrol and Analytics. **Print** (secondary) is paper: Patrol and Analytics print
the page with its charts; Alerts opens `format=print`, a table page that starts the print dialog.
**Download** (primary) is files: **Excel**, **CSV**, **PDF**.
`GET /export/alerts|patrol|analytics?format=xlsx|csv|pdf|print` plus the page's own filters
(`q, camera, status, rule, from, to` / `day` / `period, from, to, group`). Viewers may download.

- Alerts: every row matching the on-screen filters, not only the cards loaded. "All time" with no filters is the whole history.
- Patrol: checkpoints, every visit, every gap for that day. Analytics: summary, by type / camera / hour / guard,
  time to check, and every alert in the period, one sheet each (CSV: one section each).
- `server/export.ts` builds each download once as plain tables and writes xlsx, csv or a print page from that,
  so formats cannot disagree. The .xlsx is hand-written OOXML in a zip from `node:zlib` (no dependency);
  numbers are numeric cells, header bold and frozen, plus an *About this file* sheet saying who downloaded what.
- CSV cells starting with `= + - @` get a leading `'` (formula injection); XML-illegal characters are stripped.
- PDF is a real file: the print page rendered by the Chrome or Edge already on the PC (`--headless --print-to-pdf`,
  temp profile, one at a time, ~2 s). Headless Chrome does not reliably exit after writing, so the server waits for a
  complete file (`%%EOF`, size stable) and closes it. No browser → 503 and the page says to use Print.
  `CHROME_PATH` overrides; `npm run doctor` shows which browser is used. Tables capped at 3,000 rows (says so).
- Files are in English.

## Sign-in (v0.5)

Built for head office watching over the private WAN. The server stays on the guard-room PC.

| Who | How they get in | Can |
|---|---|---|
| The guard-room PC itself | Requests from `127.0.0.1` need no account (`KIOSK_LOCAL=0` turns that off) | everything; picks the guard's name from the list |
| `guard` account | username + password | everything; alerts are recorded under the account's name |
| `viewer` account (head office, TVs) | username + password | look at everything; no ack, undo or notes (server-enforced, 403) |

- Passwords: scrypt, generated for the user (`xxxx-xxxx-xxxx`, no 0/o/1/l/i), shown once by `npm run users`.
- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie, only its SHA-256 stored,
  30-day sliding expiry. Disable / reset / remove signs out everywhere at once, including open live streams.
- Lockout: 5 wrong for one account from one IP, or 20 from one IP, locks for 15 minutes.
- Every non-GET request needs the `x-mes: 1` header, which another website's page cannot add, and
  `/login?next=` only returns to a path on this site.
- `POST /events` is accepted only from the AI Box (host of `AIBOX_URL`), this PC, and `EVENTS_ALLOW`;
  refusals are logged with the exact `.env` line to add.
- Plain HTTP, so no `Secure` cookie flag. Fine on the private network; put HTTPS in front before
  anything faces the internet.

`npm test` covers the auth rules in `server/test_auth.ts`; assertions set a failing exit code.
