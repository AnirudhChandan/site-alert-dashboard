/**
 * Downloads: the same tables as Excel (.xlsx), CSV, or a print-ready page for Save as PDF.
 *
 * Each export is a "book" of plain tables, built once, then written in any of the three
 * formats — so an Excel file and a PDF of the same thing can never disagree.
 * The .xlsx is written by hand (a zip of a few XML files, using Node's own zlib) so the
 * guard PC needs nothing extra installed.
 */
import { deflateRawSync, crc32 } from 'node:zlib'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db, listAlerts } from './db.ts'
import { LABEL, REASON } from './rules.ts'
import { patrolReport, analytics } from './report.ts'

type Cell = string | number | null | undefined
export type Sheet = { name: string; head: string[]; rows: Cell[][] }
export type Book = { title: string; about: string; file: string; sheets: Sheet[] }

const pad = (n: number) => String(n).padStart(2, '0')
const date = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const time = (ts: number) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const when = (ts?: number | null) => ts ? `${date(ts)} ${time(ts)}` : ''
const mins = (ms: number) => Math.round(ms / 6_000) / 10
const status = (a: any) => a.outcome === 'action_taken' ? 'Real problem' : a.outcome === 'false_alarm' ? 'False alarm' : a.ack_at ? 'Checked' : 'Not checked'

// ---- which alerts: shared with /api/alerts so the page and its download always match ----
export function findAlerts(q: any, max = 5000) {
  const rows: any[] = listAlerts.all({
    rule: q.rule || null,
    camera: q.camera || null,
    unacked: q.unacked === '1' || q.status === 'open' ? 1 : 0,
    from: q.from ? Number(q.from) : null,
    to: q.to ? Number(q.to) : null,
    limit: Math.min(Number(q.limit) || max, max),
  })
  const words = String(q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter(a =>
    (q.status !== 'real' || a.outcome === 'action_taken') &&
    (q.status !== 'false' || a.outcome === 'false_alarm') &&
    (!q.reason || a.reason === q.reason) &&
    // Free-text search over what a person would type: "fall", "gate", "ramesh", a note.
    // Done here rather than in SQL so the human-readable rule labels are searchable too.
    words.every(w => [LABEL[a.rule as keyof typeof LABEL], a.rule, a.camera_name, a.location, a.ack_by, a.note, a.severity,
                      REASON[a.reason]?.en, REASON[a.reason]?.hi]
      .filter(Boolean).join(' ').toLowerCase().includes(w)))
}

const ALERT_HEAD = ['ID', 'Date', 'Time', 'Alert type', 'Severity', 'Camera', 'Location', 'Status', 'Reason', 'Checked by', 'Checked at', 'Minutes to check', 'Note']
const alertRow = (a: any): Cell[] => [a.id, date(a.ts), time(a.ts), LABEL[a.rule as keyof typeof LABEL] ?? a.rule, a.severity,
  a.camera_name ?? a.camera_id, a.location, status(a), REASON[a.reason]?.en, a.ack_by, when(a.ack_at), a.ack_at ? mins(a.ack_at - a.ts) : null, a.note]

export function alertsBook(q: any): Book {
  // Patrol checkpoint sightings are not alerts; they are in the Patrol download.
  const rows = findAlerts(q, 200_000).filter(a => a.rule !== 'person_seen')
  const cam = q.camera ? (db.prepare('SELECT name FROM cameras WHERE id = ?').get(q.camera) as any)?.name ?? q.camera : ''
  const filters = [
    q.from ? `from ${date(Number(q.from))}${q.to ? ` to ${date(Number(q.to) - 1)}` : ''}` : 'all time',
    q.rule && (LABEL[q.rule as keyof typeof LABEL] ?? q.rule), cam && `camera ${cam}`,
    q.status && q.status !== 'all' && { open: 'not checked', real: 'real problems', false: 'false alarms' }[q.status as string],
    REASON[q.reason] && `reason "${REASON[q.reason].en}"`,
    q.q && `search "${q.q}"`,
  ].filter(Boolean).join(', ')
  return { title: 'Alerts', about: `${rows.length} alerts — ${filters}`, file: `site-alerts-${date(Date.now())}`,
           sheets: [{ name: 'Alerts', head: ALERT_HEAD, rows: rows.map(alertRow) }] }
}

export function patrolBook(day?: string): Book {
  const r = patrolReport(day)
  const cps = r.checkpoints
  return {
    title: 'Patrol report', about: `${r.day} — day is 06:00 to 18:00`, file: `site-patrol-${r.day}`,
    sheets: [
      { name: 'Checkpoints', head: ['Checkpoint', 'Location', 'Must be seen every (min)', 'Visits', 'Gaps', 'Minutes in gaps', 'Day %', 'Night %', 'Total %'],
        rows: cps.map(c => [c.name, c.location, c.threshold_min, c.visits.length, c.gaps.length,
          mins(c.gaps.reduce((s, [a, b]) => s + b - a, 0)), c.compliance.day, c.compliance.night, c.compliance.total]) },
      { name: 'Visits', head: ['Checkpoint', 'Date', 'Time'], rows: cps.flatMap(c => c.visits.map(ts => [c.name, date(ts), time(ts)])) },
      { name: 'Gaps', head: ['Checkpoint', 'From', 'To', 'Minutes'], rows: cps.flatMap(c => c.gaps.map(([a, b]) => [c.name, when(a), when(b), mins(b - a)])) },
    ],
  }
}

const bucketLabel = (g: string, ts: number) =>
  g === 'hour' ? `${date(ts)} ${time(ts)}` : g === 'week' ? `Week of ${date(ts)}` : g === 'month' ? date(ts).slice(0, 7) : date(ts)

export function analyticsBook(q: any): Book {
  const a = analytics(q)
  const t = a.totals, b = a.before
  const sums = (x: any): Cell[] => [x.alerts, x.real, x.falseAlarms, x.open, x.falseRate, x.avgResponseMin]
  const SUM_HEAD = ['Alerts', 'Real problems', 'False alarms', 'Not checked', 'False alarm %', 'Avg minutes to check']
  const cams = a.heat.map(h => h.name)
  return {
    title: `Analytics — ${a.period.label.en}`,
    about: `${when(a.start)} to ${when(a.end)}, shown by ${a.group}`,
    file: `site-analytics-${a.period.key === 'custom' ? `${date(a.start)}-to-${date(a.end - 1)}` : `${a.period.key}-${date(a.end)}`}`,
    sheets: [
      { name: 'Summary', head: ['', 'This period', 'Period before'], rows: [
        ['Alerts', t.alerts, b?.alerts], ['Real problems', t.real, b?.real], ['False alarms', t.falseAlarms, b?.falseAlarms],
        ['Checked', t.checked, b?.checked], ['Not checked', t.open, b?.open], ['False alarm %', t.falseRate, b?.falseRate],
        ['Avg minutes to check', t.avgResponseMin, b?.avgResponseMin], ['Patrol on schedule %', t.patrol, b?.patrol],
        [], ...a.insights.en.map(s => [s]),
      ] },
      { name: 'By alert type', head: ['Alert type', 'Severity', ...SUM_HEAD, 'Share %', 'Period before', 'Busiest camera', 'Busiest hour'],
        rows: a.byType.map(x => [x.label, x.severity, ...sums(x), x.share, x.prev, x.busiest?.name, x.peakHour == null ? null : `${pad(x.peakHour)}:00`]) },
      { name: 'Over time', head: [a.group[0].toUpperCase() + a.group.slice(1), 'All alerts', ...a.byType.map(x => x.label)],
        rows: a.buckets.map((b, i) => [bucketLabel(a.group, b), a.series[i], ...a.byType.map(x => x.series[i])]) },
      { name: 'By camera', head: ['Camera', ...SUM_HEAD], rows: a.byCamera.map(x => [x.name, ...sums(x)]) },
      { name: 'By hour of day', head: ['Hour', 'All cameras', ...cams],
        rows: a.byHour.map((n, h) => [`${pad(h)}:00`, n, ...a.heat.map(c => c.hours[h])]) },
      { name: 'By guard', head: ['Checked by', 'Checked', 'Real problems', 'False alarms', 'False alarm %', 'Avg minutes to check'],
        rows: a.byGuard.map(x => [x.name, x.checked, x.real, x.falseAlarms, x.falseRate, x.avgResponseMin]) },
      { name: 'Reasons', head: ['Outcome', 'Reason', 'Alerts', 'Out of'], rows: [
        ...a.reasons.false_alarm.items.map(x => ['False alarm', x.en, x.count, a.reasons.false_alarm.given]),
        ['False alarm', 'No reason picked', a.reasons.false_alarm.total - a.reasons.false_alarm.given, a.reasons.false_alarm.total],
        ...a.reasons.action_taken.items.map(x => ['Real problem', x.en, x.count, a.reasons.action_taken.given]),
        ['Real problem', 'No reason picked', a.reasons.action_taken.total - a.reasons.action_taken.given, a.reasons.action_taken.total]] },
      { name: 'Time to check', head: ['How quickly', 'Alerts'], rows: [
        ['Under 2 minutes', a.response.within2], ['2 to 5 minutes', a.response.within5], ['5 to 15 minutes', a.response.within15],
        ['Over 15 minutes', a.response.over15], ['Not checked', a.response.never]] },
      { name: 'Alerts', head: ALERT_HEAD, rows: findAlerts({ from: a.start, to: a.end }, 200_000).filter(r => r.severity !== 'info').map(alertRow) },
    ],
  }
}

// ---- CSV ------------------------------------------------------------------------
// A cell starting with = + - @ would run as a formula in Excel. Guards' notes and
// camera names from events are outside input, so those get a leading apostrophe.
const csvCell = (v: Cell) => {
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const BOM = String.fromCharCode(0xfeff)
export function toCsv(book: Book) {
  const table = (s: Sheet) => [s.head, ...s.rows].map(r => r.map(csvCell).join(','))
  // One table: a plain table, so Excel's sort and filter work. Several: one after another, each under its name.
  const lines = book.sheets.length === 1 ? table(book.sheets[0])
    : [book.title, book.about, ...book.sheets.flatMap(s => ['', s.name.toUpperCase(), ...table(s)])]
  return BOM + lines.join('\r\n') + '\r\n'   // BOM, so Excel reads Hindi names correctly
}

// ---- Excel (.xlsx) ----------------------------------------------------------------
// Characters XML forbids outright (control codes, U+FFFE/FFFF) would make Excel call the file corrupt.
const ch = (n: number) => String.fromCharCode(n)
const NOT_XML = new RegExp(`[${ch(0)}-${ch(8)}${ch(11)}${ch(12)}${ch(14)}-${ch(31)}${ch(0xfffe)}${ch(0xffff)}]`, 'g')
const xml = (v: unknown) => String(v)
  .replace(NOT_XML, '')   // not allowed in XML at all
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const col = (i: number): string => (i >= 26 ? col(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))
const sheetName = (s: string, i: number) => xml(s.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || `Sheet${i + 1}`)

function sheetXml(s: Sheet) {
  const cell = (v: Cell, ref: string, bold = false) =>
    v == null || v === '' ? '' : typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`
  const all = [s.head, ...s.rows]
  const widths = s.head.map((_, i) => Math.min(60, Math.max(8, ...all.map(r => String(r[i] ?? '').length + 2))))
  const rows = all.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(v, `${col(x)}${y + 1}`, y === 0)).join('')}</row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rows}</sheetData></worksheet>`
}

export function toXlsx(book: Book, madeBy = '') {
  const sheets = [...book.sheets, { name: 'About this file', head: ['Site security dashboard', ''], rows: [
    ['Report', book.title], ['Covers', book.about], ['Downloaded', when(Date.now())], ['By', madeBy]] }]
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((s, i) => `<sheet name="${sheetName(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      }<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ]
  return zip(files)
}

/** The smallest valid zip: deflated entries, a central directory, and the end record. */
function zip(files: [string, string][]) {
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const parts: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8'), data = deflateRawSync(raw), nm = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(8, 8)
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc32(raw), 14)
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nm.length, 26); head.writeUInt16LE(0, 28)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0, 8); dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(dosTime, 12); dir.writeUInt16LE(dosDate, 14); dir.writeUInt32LE(crc32(raw), 16)
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(nm.length, 28)
    dir.writeUInt32LE(offset, 42)
    parts.push(head, nm, data); central.push(dir, nm)
    offset += head.length + nm.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

// ---- PDF: a plain page that opens the browser's print dialog (Save as PDF) ---------------
export const PDF_MAX_ROWS = 3000
export function toPrintHtml(book: Book, madeBy = '', forPrinter = false) {
  const e = (v: Cell) => v == null ? '' : xml(v)
  const table = (s: Sheet) => {
    const cut = s.rows.length > PDF_MAX_ROWS
    return `${book.sheets.length > 1 ? `<h2>${e(s.name)}</h2>` : ''}
    ${cut ? `<p class="warn">Showing the newest ${PDF_MAX_ROWS} of ${s.rows.length} rows. Download Excel for all of them.</p>` : ''}
    <table><thead><tr>${s.head.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${
      s.rows.slice(0, PDF_MAX_ROWS).map(r => `<tr>${s.head.map((_, i) => `<td${typeof r[i] === 'number' ? ' class="n"' : String(r[i] ?? '').length <= 16 ? ' class="s"' : ''}>${e(r[i])}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`
  }
  return `<!doctype html><meta charset="utf-8"><title>${e(book.file)}</title>
<style>
  @page{size:A4 landscape;margin:12mm}
  body{font:11px/1.4 "Segoe UI",system-ui,sans-serif;color:#111;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px;break-after:avoid}
  .sub{color:#555;margin:0 0 12px} .warn{color:#a15c00;font-weight:600}
  table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}
  th{background:#eef1f5} tr{break-inside:avoid} td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap} td.s{white-space:nowrap}
  .bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;display:flex;gap:12px;align-items:center}
  .bar button{font:inherit;font-size:14px;padding:8px 16px;cursor:pointer}
  @media print{.bar{display:none}body{padding:0}}
</style>
${forPrinter ? '<div class="bar"><button onclick="print()">Print</button></div>' : ''}
<h1>Demo Estate — ${e(book.title)}</h1>
<p class="sub">${e(book.about)} · downloaded ${e(when(Date.now()))}${madeBy ? ` by ${e(madeBy)}` : ''}</p>
${book.sheets.map(table).join('')}
${forPrinter ? `<script>addEventListener('load', () => setTimeout(print, 300))</script>` : ''}`
}

// ---- PDF file: the same page, printed to a file by the Chrome or Edge already on the PC ---------
// Chrome lays out Hindi, long notes and page breaks properly, which a hand-written PDF could not.
export const PDF_BROWSER = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',   // on every Windows 11 PC
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => p && existsSync(p))

// One at a time: several people pressing PDF together must not start several browsers on the guard PC.
let pdfQueue: Promise<unknown> = Promise.resolve()
export function htmlToPdf(html: string): Promise<Buffer | null> {
  const run = async () => {
    if (!PDF_BROWSER) return null
    const dir = mkdtempSync(join(tmpdir(), 'mes-pdf-'))
    try {
      writeFileSync(join(dir, 'page.html'), html)
      const out = join(dir, 'out.pdf')
      await new Promise<void>((ok, fail) => {
        // Headless Chrome writes the PDF in a second or two but does not always quit afterwards
        // (seen on macOS; helpers also hold inherited pipes). So: no pipes, and once the file
        // has stopped growing, it is finished and the browser is closed.
        const child = spawn(PDF_BROWSER!, [
          '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-pdf-header-footer',
          '--disable-extensions', '--disable-component-update', '--disable-background-networking', '--use-mock-keychain',
          `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${out}`, pathToFileURL(join(dir, 'page.html')).href,
        ], { stdio: 'ignore', windowsHide: true })
        let last = -1, done = false
        const finish = (err?: Error) => {
          if (done) return; done = true
          clearInterval(poll); clearTimeout(timer)
          if (child.exitCode === null) child.kill()
          err ? fail(err) : ok()
        }
        const poll = setInterval(() => {
          const size = existsSync(out) ? statSync(out).size : 0
          if (size > 0 && size === last && readFileSync(out).subarray(-64).includes('%%EOF')) finish()
          last = size
        }, 400)
        const timer = setTimeout(() => finish(new Error('timed out after 90 s')), 90_000)
        child.on('error', e => finish(e))
        child.on('exit', code => setTimeout(() => existsSync(out) && readFileSync(out).subarray(-64).includes('%%EOF') ? finish() : finish(new Error(`browser exited with ${code}, no PDF written`)), 100))
      })
      return readFileSync(out)
    } catch (e: any) {
      console.error(`!! PDF failed (${PDF_BROWSER}): ${e.message}`)
      return null
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
    }
  }
  const job = pdfQueue.then(run, run)
  pdfQueue = job
  return job
}
