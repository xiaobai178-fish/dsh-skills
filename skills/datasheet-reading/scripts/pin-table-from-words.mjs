#!/usr/bin/env node
// pin-table-from-words.mjs — 把 PyMuPDF 导出的词表 CSV 还原成"引脚功能表"
// 用法: node pin-table-from-words.mjs <words.csv> [--port "^P\\d\\.\\d+$"] [--match "ADC_CH"] [--out out.csv]
// 原理: 按 y 聚行；用表头行（Port / AF1 / AF2 …）的 x 作为列锚点；每行左侧匹配端口名，
//       其余单元格按 x 就近归到列，输出 端口,AF1..AFn；并可筛出匹配 --match 的通道。
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node pin-table-from-words.mjs <words.csv> [--port regex] [--match txt] [--out csv]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const portRe = new RegExp(arg('port') ?? '^P\\d\\.\\d+$')
const matchTxt = arg('match')
const outFile = arg('out')

// ---- 读 CSV
const rows = []
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue
  const m = line.match(/^(\d+),([\d.]+),([\d.]+),([\d.]+),([\d.]+),(.*)$/)
  if (!m) continue
  let t = m[6]
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).replace(/""/g, '"')
  rows.push({ page: Number(m[1]), x: Number(m[2]), y: Number(m[3]), text: t.trim() })
}

// ---- 聚合 y 行（容差 3）
const ys = [...new Set(rows.map((r) => Math.round(r.y / 3)))].sort((a, b) => a - b)
const lines = ys.map((k) => ({ y: k * 3, cells: rows.filter((r) => Math.round(r.y / 3) === k).sort((a, b) => a.x - b.x) }))

// ---- 找表头行：含 Port 且含 AF1
const header = lines.find((l) => l.cells.some((c) => /^Port$/i.test(c.text)) && l.cells.some((c) => /^AF\d$/i.test(c.text)))
if (!header) { console.error('未找到表头（Port + AFn）'); process.exit(1) }
const anchors = header.cells.filter((c) => /^(Port|AF\d)$/i.test(c.text)).map((c) => ({ x: c.x, name: c.text }))
console.log(`表头 y=${header.y}，列：${anchors.map((a) => a.name + '@' + a.x.toFixed(0)).join(' ')}`)

// ---- 逐行解析
const out = ['port,' + anchors.filter((a) => i_(a)).map((a) => a.name).join(',')]
function i_(a) { return !/^Port$/i.test(a.name) }

const portRows = []
for (const l of lines) {
  if (Math.abs(l.y - header.y) < 6) continue
  const port = l.cells.find((c) => portRe.test(c.text))
  if (!port) continue
  const cells = l.cells.filter((c) => c !== port)
  const rec = { port: port.text, y: l.y, cols: {} }
  for (const c of cells) {
    // 归到最近的列锚点（右侧）
    let best = null
    for (const a of anchors) if (a.x <= c.x + 2 && (!best || a.x > best.x)) best = a
    if (!best) continue
    rec.cols[best.name] = (rec.cols[best.name] ? rec.cols[best.name] + ' ' : '') + c.text
  }
  portRows.push(rec)
}

const names = anchors.filter(i_).map((a) => a.name)
for (const r of portRows) out.push([r.port, ...names.map((n) => (r.cols[n] ?? '').replace(/,/g, '，'))].join(','))

console.log(`解析到端口行：${portRows.length}`)
for (const r of portRows.slice(0, 12)) {
  console.log(`   ${r.port.padEnd(6)} ` + names.map((n) => (r.cols[n] ?? '-')).join(' | ').slice(0, 160))
}

if (matchTxt) {
  const re = new RegExp(matchTxt)
  console.log(`\n=== 含 ${matchTxt} 的端口 ===`)
  for (const r of portRows) {
    const hits = names.filter((n) => re.test(r.cols[n] ?? ''))
    if (hits.length) console.log(`   ${r.port.padEnd(6)} → ` + hits.map((n) => `${n}:${r.cols[n]}`).join('  '))
  }
}

if (outFile) { fs.writeFileSync(outFile, out.join('\n'), 'utf8'); console.log(`\n已写 ${outFile}`) }
