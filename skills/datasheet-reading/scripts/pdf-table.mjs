#!/usr/bin/env node
// pdf-table.mjs — 带坐标的 PDF 文本抽取 + 表格重建（0 token，离线）
// 用法:
//   node pdf-table.mjs <in.pdf> --find "GPIO0"                 # 定位含该词的行（打印坐标）
//   node pdf-table.mjs <in.pdf> --find "ADCIN" --rows 40        # 打印该行附近 40 行
//   node pdf-table.mjs <in.pdf> --bbox x0,y0,x1,y1 --csv out.csv  # 导出区域表格
//   node pdf-table.mjs <in.pdf> --page 16 --csv out.csv         # 指定第 N 个内容块
// 原理: 解析 PDF 内容流里的 Tm/Td/TD/T* 与 Tj/TJ，得到每个字符串的 (x,y)，
//       再按 y 聚成行、按 x 排成列 —— 表格结构由此恢复，不依赖视觉模型。
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
if (!file) { console.error('usage: see header'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const has = (n) => process.argv.includes(`--${n}`)

const buf = fs.readFileSync(file)
const latin = buf.toString('latin1')

// ---------- 1. 提取并解压内容流（用 indexOf 扫，避免正则病态回溯）
function streams() {
  const out = []
  let at = 0
  while (true) {
    const s = latin.indexOf('stream', at)
    if (s < 0) break
    let start = s + 6
    if (latin[start] === '\r') start++
    if (latin[start] === '\n') start++
    const e = latin.indexOf('endstream', start)
    if (e < 0) break
    out.push(buf.subarray(start, e))
    at = e + 9
  }
  return out
}
function inflate(b) {
  if (b.length > 8 * 1024 * 1024) return null
  for (const c of [b, b.subarray(2), b.subarray(1)]) {
    try { return zlib.inflateSync(c) } catch { }
    try { return zlib.inflateRawSync(c) } catch { }
  }
  return null
}

// ---------- 2. 内容流 tokenizer：产出 {x, y, text}
function parseContent(s) {
  const items = []
  let i = 0
  const n = s.length
  let x = 0, y = 0, leading = 0
  let stack = []
  const MAX = 4_000_000   // 安全阀
  let ops = 0
  while (i < n && i < MAX) {
    const c = s[i]
    if (c === '%') { while (i < n && s[i] !== '\n') i++; continue }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue }
    if (c === '(') {                       // 字符串
      let j = i + 1, depth = 1, str = ''
      while (j < n && depth > 0) {
        const ch = s[j]
        if (ch === '\\') {
          const nx = s[j + 1]
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
          if (map[nx] !== undefined) { str += map[nx]; j += 2; continue }
          if (/[0-7]/.test(nx)) { const oct = s.substr(j + 1, 3).match(/^[0-7]{1,3}/)[0]; str += String.fromCharCode(parseInt(oct, 8)); j += 1 + oct.length; continue }
          j += 2; continue
        }
        if (ch === '(') depth++
        if (ch === ')') { depth--; if (depth === 0) { j++; break } }
        str += ch; j++
      }
      stack.push({ str })
      i = j
      continue
    }
    if (c === '[') {                       // 数组
      const arr = []
      i++
      while (i < n && s[i] !== ']') {
        if (s[i] === '(') {
          let j = i + 1, depth = 1, str = ''
          while (j < n && depth > 0) {
            if (s[j] === '\\') { str += s[j] + s[j + 1]; j += 2; continue }
            if (s[j] === '(') depth++
            if (s[j] === ')') { depth--; if (!depth) { j++; break } }
            str += s[j]; j++
          }
          arr.push({ str: str.replace(/\\([nrtbf()\\])/g, (_, k) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[k])) })
          i = j
          continue
        }
        const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i, i + 24))
        if (num) { arr.push({ num: Number(num[0]) }); i += num[0].length; continue }
        i++
      }
      i++
      stack.push({ arr })
      continue
    }
    // 数字 / 名字 / 操作符
    const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i, i + 24))
    if (num) { stack.push({ num: Number(num[0]) }); i += num[0].length; continue }
    if (c === '/') { let j = i + 1; while (j < n && !/[\s/\[\]()<>]/.test(s[j])) j++; stack.push({ name: s.slice(i + 1, j) }); i = j; continue }
    const op = /^[A-Za-z'"*]+/.exec(s.slice(i, i + 4))
    if (op) {
      const o = op[0]
      ops++
      if (o === 'Td' || o === 'TD') {
        const t = stack.filter((v) => v.num !== undefined).slice(-2)
        if (t.length === 2) { x += t[0].num; y += t[1].num; if (o === 'TD') leading = -t[1].num }
      } else if (o === 'Tm') {
        const t = stack.filter((v) => v.num !== undefined).slice(-6)
        if (t.length === 6) { x = t[4].num; y = t[5].num }
      } else if (o === 'T*') { y -= leading || 12 }
      else if (o === 'TL') { const t = stack.filter((v) => v.num !== undefined).slice(-1); if (t.length) leading = t[0].num }
      else if (o === 'Tj' || o === "'" || o === '"') {
        const t = stack.filter((v) => v.str !== undefined).slice(-1)
        if (t.length && t[0].str.trim()) items.push({ x, y, text: t[0].str })
        if (o !== 'Tj') { y -= leading || 12 }
      } else if (o === 'TJ') {
        const a = [...stack].reverse().find((v) => v.arr)
        if (a) {
          let text = ''
          for (const it of a.arr) {
            if (it.str !== undefined) text += it.str
            else if (it.num !== undefined && Math.abs(it.num) > 120) text += ' '
          }
          if (text.trim()) items.push({ x, y, text })
        }
      }
      stack = []
      i += o.length
      continue
    }
    i++
  }
  return items
}

// ---------- 3. 按 y 聚行
function toRows(items, tol = 3) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= tol)
    if (row) { row.items.push(it); row.y = (row.y + it.y) / 2 }
    else rows.push({ y: it.y, items: [it] })
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x)
  return rows.sort((a, b) => b.y - a.y)
}

// ---------- 4. 主流程
const blocks = []
for (const s of streams()) {
  const d = inflate(s)
  if (!d) continue
  const t = d.toString('latin1')
  if (t.indexOf('Tj') < 0 && t.indexOf('TJ') < 0) continue
  const items = parseContent(t)
  if (items.length) blocks.push(items)
}
console.error(`[信息] 内容块 ${blocks.length} 个（含文本）`)

const pageArg = Number(arg('page') ?? 0)
const find = arg('find')
const rowsArg = Number(arg('rows') ?? 25)
const csv = arg('csv')
const bbox = arg('bbox')?.split(',').map(Number)

let targets = pageArg ? [blocks[pageArg - 1]].filter(Boolean) : blocks

if (find) {
  const re = new RegExp(find, 'i')
  let printed = 0
  for (const b of targets) {
    const rows = toRows(b)
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i].items.map((t) => t.text).join(' ')
      if (!re.test(text)) continue
      // 打印上下文若干行
      for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + rowsArg); k++) {
        const r = rows[k]
        const cells = r.items.map((t) => `${t.x.toFixed(0)},${t.y.toFixed(0)}=${t.text}`).join(' | ')
        console.log(cells.slice(0, 240))
      }
      printed++
      if (printed >= 3) break
    }
    if (printed >= 3) break
  }
  if (!printed) console.log(`(未找到 ${find})`)
}

// ---------- 5. 引脚属性表模式（--pin-table）
if (has('pin-table')) {
  const target = pageArg ? blocks[pageArg - 1] : blocks.find((b) => {
    const rows = toRows(b)
    return rows.some((r) => {
      const t = r.items.map((i) => i.text).join('')
      return /VPM/.test(t) && /RHB/.test(t)
    })
  })
  if (!target) { console.log('(未找到含 64VPM/32RHB 表头的页)'); process.exit(1) }
  const rows = toRows(target)
  const hi = rows.findIndex((r) => {
    const t = r.items.map((i) => i.text).join('')
    return /VPM/.test(t) && /RHB/.test(t)
  })
  const header = rows[hi]
  const anchors = header.items.filter((i) => /^\d+$/.test(i.text)).map((i) => i.x)
  const names = ['vpm64', 'pm64', 'rgz48', 'pt48', 'rhb32']
  console.log(`表头 y=${header.y.toFixed(1)}，列锚点 x=${anchors.map((a) => a.toFixed(0)).join(',')}`)
  const out = ['signal,' + names.join(',') + ',description']
  let rowsOut = 0
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.items.length === 0) continue
    const left = r.items.filter((it) => it.x < anchors[0] - 15).map((it) => it.text).join(' ')
    if (!left.trim()) continue
    if (/^(说明|注|Note)/.test(left)) break
    const cells = names.map((_, k) => {
      const it = r.items.find((x) => Math.abs(x.x - anchors[k]) <= 12)
      return it ? it.text : ''
    })
    const desc = r.items.filter((it) => it.x > anchors[anchors.length - 1] + 15).map((it) => it.text).join(' ')
    out.push([left, ...cells, desc.replace(/,/g, '，')].join(','))
    rowsOut++
  }
  console.log(`解析出 ${rowsOut} 行`)
  const csvOut = arg('csv') ?? 'pin-table.csv'
  fs.writeFileSync(csvOut, out.join('\n'), 'utf8')
  console.log(`已写 ${csvOut}`)
  const adc = out.slice(1).filter((l) => /^A\d+/.test(l))
  if (adc.length) {
    console.log('\nADC 通道行（A<n> = ADCIN<n>）：')
    for (const l of adc.slice(0, 40)) console.log('   ' + l)
  }
  process.exit(0)
}

if (csv) {
  const out = ['x,y,text']
  for (const b of targets) for (const it of b) {
    if (bbox) {
      const [x0, y0, x1, y1] = bbox
      if (it.x < x0 || it.x > x1 || it.y < y0 || it.y > y1) continue
    }
    out.push(`${it.x.toFixed(2)},${it.y.toFixed(2)},"${it.text.replace(/"/g, '""')}"`)
  }
  fs.writeFileSync(csv, out.join('\n'), 'utf8')
  console.log(`已写 ${csv}（${out.length - 1} 条文本项）`)
}
