#!/usr/bin/env node
// pdf-text.mjs — PDF 取文本（Flate 流 + Tj/TJ 算子），用于数据手册查引脚表/ADC 表
// 用法: node pdf-text.mjs <in.pdf> [--out out.txt] [--page N] [--grep 关键词]
// 限制: 仅支持 FlateDecode；图片型/加密 PDF 无效；表格列可能被打散（需人工按行核对）
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
if (!file) { console.error('usage: node pdf-text.mjs <in.pdf> [--out out.txt] [--page N] [--grep kw]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const buf = fs.readFileSync(file)
const latin = buf.toString('latin1')

// ---- 切出所有 stream ... endstream
const streams = []
const sRe = /stream\r?\n/g
let m
while ((m = sRe.exec(latin)) !== null) {
  const start = m.index + m[0].length
  const end = latin.indexOf('endstream', start)
  if (end < 0) break
  streams.push(buf.subarray(start, end))
}

function tryInflate(b) {
  const candidates = [b, b.subarray(2), b.subarray(1)]
  for (const c of candidates) {
    try { return zlib.inflateSync(c) } catch { }
    try { return zlib.inflateRawSync(c) } catch { }
  }
  return null
}

// ---- 从解压内容里抽文本
function extractText(s) {
  const out = []
  // TJ 数组: [(a) -10 (b)] TJ
  const tjArr = /\[((?:[^\[\]]|\([^)]*\))*)\]\s*TJ/g
  // 单个 Tj: (text) Tj
  const tj = /\(((?:\\.|[^\\()])*)\)\s*Tj/g
  // 先按出现顺序收集
  const events = []
  let mm
  while ((mm = tjArr.exec(s)) !== null) {
    const inner = mm[1]
    let text = ''
    const parts = /\(((?:\\.|[^\\()])*)\)|(-?\d+(?:\.\d+)?)/g
    let p
    while ((p = parts.exec(inner)) !== null) {
      if (p[1] !== undefined) text += unescapePdf(p[1])
      else if (p[2] !== undefined && Math.abs(Number(p[2])) > 120) text += ' '
    }
    if (text) events.push({ at: mm.index, text })
  }
  while ((mm = tj.exec(s)) !== null) if (mm[1]) events.push({ at: mm.index, text: unescapePdf(mm[1]) })
  events.sort((a, b) => a.at - b.at)
  for (const e of events) out.push(e.text)
  return out.join('\n')
}
function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c]))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

let pages = []
let decodedCount = 0
for (const s of streams) {
  const d = tryInflate(s)
  if (!d) continue
  decodedCount++
  const t = extractText(d.toString('latin1'))
  if (t.trim()) pages.push(t)
}
const text = pages.join('\n\n===== PAGE =====\n\n')

const out = arg('out')
if (out) { fs.writeFileSync(out, text, 'utf8'); console.log(`已写 ${out}（${text.length} 字符，${pages.length} 个文本块，解压 ${decodedCount}/${streams.length} 个流）`) }

const pageN = Number(arg('page') ?? 0)
const kw = arg('grep')
if (kw) {
  const re = new RegExp(kw, 'i')
  const lines = text.split(/\r?\n/)
  let hit = 0
  for (let i = 0; i < lines.length && hit < 40; i++) {
    if (!re.test(lines[i])) continue
    hit++
    console.log(`[${i + 1}] ${lines[i].slice(0, 160)}`)
  }
  if (!hit) console.log(`(未命中 ${kw}；共 ${lines.length} 行文本)`)
}
if (pageN) {
  const blocks = text.split(/===== PAGE =====/)
  console.log(`总块数 ${blocks.length}；第 ${pageN} 块前 60 行：`)
  console.log((blocks[pageN - 1] ?? '').split(/\r?\n/).slice(0, 60).join('\n'))
}
if (!kw && !pageN && !out) console.log(text.slice(0, 2000))
