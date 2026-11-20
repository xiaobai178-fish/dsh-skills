#!/usr/bin/env node
// pdf-parse.mjs — 支持中文（ToUnicode CMap）的 PDF 文本抽取 + 坐标输出
// 用法: node pdf-parse.mjs <in.pdf> [--out items.csv] [--find 关键词] [--rows N] [--page N]
// 与 pdf-table.mjs 的区别: 解析每个字体的 /ToUnicode CMap，按页资源跟踪 Tf 当前字体，
//   因此 CID 编码的中文也能正确还原；并输出 (x,y,text) 供表格重建使用。
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
if (!file) { console.error('usage: node pdf-parse.mjs <in.pdf> [--out csv] [--find kw] [--page N]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const buf = fs.readFileSync(file)
const s = buf.toString('latin1')

/* ---------------- 1. 对象索引 ---------------- */
const objs = new Map()
{
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  const marks = []
  let m
  while ((m = re.exec(s)) !== null) marks.push({ num: Number(m[1]), at: re.lastIndex })
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at
    const end = i + 1 < marks.length ? marks[i + 1].at : s.length
    objs.set(marks[i].num, { num: marks[i].num, start, body: s.slice(start, Math.min(end, start + 200000)) })
  }
}
function inflateAll(raw) {
  if (!raw || raw.length < 8) return null
  for (const c of [raw, raw.subarray(2), raw.subarray(1)]) {
    try { return zlib.inflateSync(c) } catch { }
    try { return zlib.inflateRawSync(c) } catch { }
  }
  return null
}
function objStream(num) {
  const o = objs.get(num)
  if (!o) return null
  const i = o.body.indexOf('stream')
  if (i < 0) return null
  let st = o.start + i + 6
  if (s[st] === '\r') st++
  if (s[st] === '\n') st++
  const en = s.indexOf('endstream', st)
  if (en < 0) return null
  return inflateAll(buf.subarray(st, en))
}

/* ---------------- 2. 字体 CMap ---------------- */
const fontCMap = new Map()   // fontObjNum -> { map: Map<code,string>, twoByte: bool }
function buildCMap(fontObjNum) {
  if (fontCMap.has(fontObjNum)) return fontCMap.get(fontObjNum)
  const o = objs.get(fontObjNum)
  if (!o) return null
  const isType0 = /\/Subtype\s*\/Type0/.test(o.body)
  const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(o.body)
  const map = new Map()
  if (tu) {
    const st = objStream(Number(tu[1]))
    if (st) {
      const t = st.toString('latin1')
      for (const mm of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const line of mm[1].split(/\r?\n/)) {
          const p = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/)
          if (!p) continue
          const code = parseInt(p[1], 16)
          const uni = p[2].match(/.{1,4}/g).map((h) => parseInt(h, 16))
          map.set(code, String.fromCharCode(...uni))
        }
      }
      for (const mm of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const line of mm[1].split(/\r?\n/)) {
          const p = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/)
          if (!p) continue
          const a = parseInt(p[1], 16), b = parseInt(p[2], 16), c = parseInt(p[3], 16)
          for (let k = a; k <= b && k - a < 4000; k++) map.set(k, String.fromCharCode(c + (k - a)))
        }
      }
    }
  }
  const rec = { map, twoByte: isType0 }
  fontCMap.set(fontObjNum, rec)
  return rec
}

/* ---------------- 3. 页对象 → 资源字体表 ---------------- */
const pages = []
for (const [num, o] of objs) {
  if (!/\/Type\s*\/Page[^s]/.test(o.body)) continue
  const resInline = /\/Font\s*<<([\s\S]*?)>>/.exec(o.body)
  const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(o.body)
  let fontDict = resInline ? resInline[1] : ''
  if (!fontDict && resRef) {
    const ro = objs.get(Number(resRef[1]))
    if (ro) {
      const m2 = /\/Font\s*<<([\s\S]*?)>>/.exec(ro.body)
      if (m2) fontDict = m2[1]
    }
  }
  const fontByRes = new Map()
  for (const mm of fontDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) fontByRes.set(mm[1], Number(mm[2]))
  const contents = []
  const cRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(o.body)
  if (cRef) contents.push(Number(cRef[1]))
  else {
    const cArr = /\/Contents\s*\[([\s\S]*?)\]/.exec(o.body)
    if (cArr) for (const mm of cArr[1].matchAll(/(\d+)\s+0\s+R/g)) contents.push(Number(mm[1]))
  }
  pages.push({ num, fontByRes, contents })
}
// 有些 PDF 的 /Contents 指向数组或压缩流，取不到就退回"全部含 Tj 的流"模式
pages.sort((a, b) => a.num - b.num)

/* ---------------- 4. 内容流解析（带字体状态） ---------------- */
function parseContent(content, fontByRes) {
  const items = []
  let i = 0
  const n = content.length
  let x = 0, y = 0, leading = 0
  let cur = null   // 当前字体 {map, twoByte}
  const stack = []
  const MAX = 8_000_000
  const readString = () => {
    let j = i + 1, depth = 1, str = ''
    while (j < n && depth > 0) {
      const ch = content[j]
      if (ch === '\\') {
        const nx = content[j + 1]
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
        if (map[nx] !== undefined) { str += map[nx]; j += 2; continue }
        if (/[0-7]/.test(nx)) { const o = content.substr(j + 1, 3).match(/^[0-7]{1,3}/)[0]; str += String.fromCharCode(parseInt(o, 8)); j += 1 + o.length; continue }
        j += 2; continue
      }
      if (ch === '(') depth++
      if (ch === ')') { depth--; if (!depth) { j++; break } }
      str += ch; j++
    }
    i = j
    return str
  }
  const decodeStr = (raw) => {
    if (!cur) return raw
    if (cur.twoByte) {
      let out = ''
      for (let k = 0; k + 1 < raw.length; k += 2) {
        const code = (raw.charCodeAt(k) << 8) | raw.charCodeAt(k + 1)
        out += cur.map.get(code) ?? ''
      }
      return out
    }
    let out = ''
    for (let k = 0; k < raw.length; k++) {
      const code = raw.charCodeAt(k)
      out += cur.map.get(code) ?? String.fromCharCode(code)
    }
    return out
  }
  while (i < n && i < MAX) {
    const c = content[i]
    if (c === '%') { while (i < n && content[i] !== '\n') i++; continue }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue }
    if (c === '(') { stack.push({ str: readString() }); continue }
    if (c === '[') {
      const arr = []
      i++
      while (i < n && content[i] !== ']') {
        if (content[i] === '(') { arr.push({ str: readString() }); continue }
        const num = /^-?\d+(?:\.\d+)?/.exec(content.slice(i, i + 24))
        if (num) { arr.push({ num: Number(num[0]) }); i += num[0].length; continue }
        i++
      }
      i++
      stack.push({ arr })
      continue
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(content.slice(i, i + 24))
    if (num) { stack.push({ num: Number(num[0]) }); i += num[0].length; continue }
    if (c === '/') { let j = i + 1; while (j < n && !/[\s/\[\]()<>]/.test(content[j])) j++; stack.push({ name: content.slice(i + 1, j) }); i = j; continue }
    const op = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 4))
    if (op) {
      const o = op[0]
      if (o === 'Tf') {                                   // /F1 12 Tf
        const nm = [...stack].reverse().find((v) => v.name)
        if (nm) cur = fontByRes.has(nm.name) ? buildCMap(fontByRes.get(nm.name)) : null
      } else if (o === 'Td' || o === 'TD') {
        const t = stack.filter((v) => v.num !== undefined).slice(-2)
        if (t.length === 2) { x += t[0].num; y += t[1].num; if (o === 'TD') leading = -t[1].num }
      } else if (o === 'Tm') {
        const t = stack.filter((v) => v.num !== undefined).slice(-6)
        if (t.length === 6) { x = t[4].num; y = t[5].num }
      } else if (o === 'T*') y -= leading || 12
      else if (o === 'TL') { const t = stack.filter((v) => v.num !== undefined).slice(-1); if (t.length) leading = t[0].num }
      else if (o === 'Tj' || o === "'" || o === '"') {
        const t = [...stack].reverse().find((v) => v.str !== undefined)
        if (t) { const txt = decodeStr(t.str); if (txt.trim()) items.push({ x, y, text: txt }) }
        if (o !== 'Tj') y -= leading || 12
      } else if (o === 'TJ') {
        const a = [...stack].reverse().find((v) => v.arr)
        if (a) {
          let txt = ''
          for (const it of a.arr) {
            if (it.str !== undefined) txt += decodeStr(it.str)
            else if (it.num !== undefined && Math.abs(it.num) > 120) txt += ' '
          }
          if (txt.trim()) items.push({ x, y, text: txt })
        }
      }
      stack.length = 0
      i += o.length
      continue
    }
    i++
  }
  return items
}

/* ---------------- 5. 主流程 ---------------- */
const all = []
for (const p of pages) {
  const fontByRes = p.fontByRes
  for (const cn of p.contents) {
    const st = objStream(cn)
    if (!st) continue
    const items = parseContent(st.toString('latin1'), fontByRes)
    if (items.length) all.push({ page: p.num, items })
  }
}
if (all.length === 0) {   // 兜底：全流扫描（无资源信息时中文可能不准）
  for (const [num] of objs) {
    const st = objStream(num)
    if (!st) continue
    const t = st.toString('latin1')
    if (t.indexOf('Tj') < 0 && t.indexOf('TJ') < 0) continue
    const items = parseContent(t, new Map())
    if (items.length) all.push({ page: num, items })
  }
}
const total = all.reduce((a, b) => a + b.items.length, 0)
console.error(`[信息] 页/流 ${all.length} 个，文本项 ${total} 条`)

const find = arg('find')
if (find) {
  const re = new RegExp(find)
  let hit = 0
  for (const blk of all) {
    const rows = groupRows(blk.items)
    for (let i = 0; i < rows.length; i++) {
      const txt = rows[i].items.map((t) => t.text).join('')
      if (!re.test(txt)) continue
      for (let k = Math.max(0, i - 1); k <= Math.min(rows.length - 1, i + Number(arg('rows') ?? 3)); k++) {
        console.log(`p${blk.page}: ` + rows[k].items.map((t) => t.text).join(' ').slice(0, 200))
      }
      hit++
      if (hit >= 2) break
    }
    if (hit >= 2) break
  }
  if (!hit) console.log(`(未找到 ${find})`)
}

const out = arg('out')
if (out) {
  const lines = ['page,x,y,text']
  for (const blk of all) for (const it of blk.items) lines.push(`${blk.page},${it.x.toFixed(2)},${it.y.toFixed(2)},"${it.text.replace(/"/g, '""')}"`)
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(`已写 ${out}（${lines.length - 1} 条）`)
}

function groupRows(items, tol = 3) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of sorted) {
    const r = rows.find((z) => Math.abs(z.y - it.y) <= tol)
    if (r) r.items.push(it)
    else rows.push({ y: it.y, items: [it] })
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x)
  return rows.sort((a, b) => b.y - a.y)
}
