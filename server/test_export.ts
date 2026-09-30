/**
 * Downloads must open cleanly in Excel and must not let a typed note run as a formula.
 * Run: npm test   (uses data-test-export/, never the live data/)
 */
console.assert = (cond?: unknown, ...msg: unknown[]) => { if (!cond) { process.exitCode = 1; console.error('FAIL:', ...msg) } }

import { rmSync } from 'node:fs'
import { inflateRawSync, crc32 } from 'node:zlib'
process.env.DATA_DIR = 'data-test-export'
rmSync('data-test-export', { recursive: true, force: true })
const { toCsv, toXlsx, toPrintHtml } = await import('./export.ts')
const ok = (cond: unknown, msg: string) => console.assert(cond, msg)

const nasty = `=HYPERLINK("http://evil")`
const ctrl = 'bell' + String.fromCharCode(7) + 'here'
const book = { title: 'Alerts', about: '2 alerts', file: 'test', sheets: [
  { name: 'Alerts: all/today', head: ['ID', 'Note', 'Minutes'], rows: [[1, nasty, 2.5], [2, `a "quoted", <b>& line\nbreak`, null], [3, ctrl, -4]] },
  { name: 'Second', head: ['X'], rows: [['गार्ड']] },
] }

// CSV
const one = toCsv({ ...book, sheets: [book.sheets[0]] })
ok(one.charCodeAt(0) === 0xfeff, 'CSV starts with a BOM so Excel reads Hindi')
ok(one.slice(1).split('\r\n')[0] === 'ID,Note,Minutes', 'a single table starts with its header row, nothing above it')
ok(one.includes(`"'=HYPERLINK(""http://evil"")"`), 'a note starting with = cannot run as a formula')
ok(one.includes('"a ""quoted"", <b>& line\nbreak"'), 'quotes, commas and line breaks are escaped')
ok(one.includes(',-4\r\n'), 'negative numbers stay numbers')
ok(toCsv(book).includes('SECOND\r\nX\r\nगार्ड'), 'several tables follow one another under their names')

// Excel: read our own zip back and check every entry
const buf = toXlsx(book, 'Tester')
const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
const count = buf.readUInt16LE(end + 10), cdAt = buf.readUInt32LE(end + 16)
const files = new Map<string, string>()
for (let i = 0, p = cdAt; i < count; i++) {
  const size = buf.readUInt32LE(p + 20), crc = buf.readUInt32LE(p + 16), nameLen = buf.readUInt16LE(p + 28), at = buf.readUInt32LE(p + 42)
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
  const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const raw = inflateRawSync(buf.subarray(dataAt, dataAt + size))
  ok(crc32(raw) === crc, `${name}: checksum matches`)
  files.set(name, raw.toString('utf8'))
  p += 46 + nameLen
}
ok(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet3.xml'].every(f => files.has(f)), 'all parts of an .xlsx are present')
const s1 = files.get('xl/worksheets/sheet1.xml') ?? ''
ok(s1.includes('<t xml:space="preserve">a &quot;quoted&quot;, &lt;b&gt;&amp; line\nbreak</t>'), 'text is XML-escaped')
ok(s1.includes('bellhere') && !s1.includes(String.fromCharCode(7)), 'characters XML forbids are removed, not left to corrupt the file')
ok(s1.includes('<c r="C2"><v>2.5</v></c>') && s1.includes('<c r="C4"><v>-4</v></c>'), 'numbers are real numbers, so Excel can add them up')
ok(s1.includes('<c r="A1" t="inlineStr" s="1">'), 'header row is bold')
ok(!s1.includes('<c r="C3"'), 'empty cells are left out')
ok(files.get('xl/workbook.xml')!.includes('name="Alerts  all today"'), 'sheet names lose characters Excel refuses')
ok(files.get('xl/worksheets/sheet3.xml')!.includes('Tester'), 'the About sheet says who downloaded it')

// PDF page
const html = toPrintHtml({ ...book, sheets: [{ name: 'A', head: ['<x>'], rows: [['<script>alert(1)</script>']] }] })
ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;'), 'print page escapes everything it shows')

console.log(process.exitCode ? 'FAIL (export)' : 'export assertions passed')
