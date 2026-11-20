#!/usr/bin/env node
// schdoc-extract.mjs — 从 Altium .SchDoc 提取器件/引脚/网络标签/电源端口，并尽力反推网表
// 用法: node schdoc-extract.mjs <x.SchDoc> [--mcu U12] [--net <子串>] [--out 前缀]
// 输出: 器件表(位号/型号)、指定器件的引脚表、网络标签清单、反推网表（标注置信度）
// 说明: 反推网表靠"网络标签/电源端口坐标"与"引脚坐标"匹配；无标签的导线连接只能给部分结果。
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node schdoc-extract.mjs <SchDoc> [--mcu U12] [--net kw] [--out prefix]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const buf = fs.readFileSync(file)
const s = buf.toString('latin1')

// ---- 记录切分：RECORD=N|key=value|...
const recs = []
const re = /RECORD=(\d+)\|/g
let m
const starts = []
while ((m = re.exec(s)) !== null) starts.push({ type: Number(m[1]), at: m.index, bodyAt: re.lastIndex })
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(s.length, starts[i].bodyAt + 4000)
  const body = s.slice(starts[i].bodyAt, end)
  const props = {}
  for (const kv of body.split('|')) {
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const k = kv.slice(0, eq).trim()
    if (!/^[A-Z][A-Z0-9_.]*$/.test(k)) continue
    props[k] = kv.slice(eq + 1).trim()
  }
  recs.push({ type: starts[i].type, idx: i, props })
}

const num = (v) => (v === undefined ? null : Number(v))
const byType = (t) => recs.filter((r) => r.type === t)

// OWNERINDEX 是多级链：位号/引脚 → 参数或引脚记录 → … → 器件(RECORD=1)
function ownerComp(rec) {
  let cur = rec
  for (let hop = 0; hop < 12 && cur; hop++) {
    const oi = num(cur.props.OWNERINDEX)
    if (oi == null) return null
    const next = recs[oi]
    if (!next) return null
    if (next.type === 1) return next
    cur = next
  }
  return null
}

// ---- 器件（RECORD=1，带 LIBREFERENCE）
const comps = byType(1).filter((r) => r.props.LIBREFERENCE)

// ---- 位号（RECORD=34，TEXT 像位号）；OWNERINDEX 指向流内记录序号
const designators = byType(34).filter((r) => r.props.TEXT && /^[A-Z]{1,3}\d+$/.test(r.props.TEXT))
for (const d of designators) {
  const comp = ownerComp(d)
  if (comp) comp.props.__DES = d.props.TEXT
}

// ---- 网络标签（RECORD=25）与电源端口（RECORD=17）
const labels = [...byType(25).map((r) => ({ text: r.props.TEXT, x: num(r.props['LOCATION.X']), y: num(r.props['LOCATION.Y']), kind: 'netlabel' })),
                ...byType(17).map((r) => ({ text: r.props.TEXT, x: num(r.props['LOCATION.X']), y: num(r.props['LOCATION.Y']), kind: 'power' }))]
  .filter((l) => l.text && l.x != null && l.y != null)

// ---- 引脚（RECORD=2）：DESIGNATOR=脚号, NAME=脚名, OWNERINDEX=所属器件
const pins = byType(2).filter((r) => r.props.DESIGNATOR)
for (const p of pins) {
  const comp = ownerComp(p)
  p.comp = comp?.props.__DES ?? '?'
}

// ---- 汇总输出
console.log(`=== ${file.replace(/^.*[\\/]/, '')} ===`)
console.log(`记录 ${recs.length} 条 | 器件 ${comps.length} 个 | 位号 ${designators.length} 个 | 网络标签 ${labels.length} 个 | 引脚 ${pins.length} 个`)

const mcuRef = arg('mcu')
const icList = comps.filter((c) => /\d/.test(c.props.__DES ?? ''))
console.log(`\n=== 器件（前 15） ===`)
for (const c of icList.slice(0, 15)) {
  console.log(`   ${(c.props.__DES ?? '?').padEnd(6)} ${(c.props.LIBREFERENCE ?? '').padEnd(22)} ${c.props.COMPONENTDESCRIPTION ?? ''}`)
}

// ---- 指定主控的引脚表 + 按标签匹配网络
if (mcuRef) {
  const mp = pins.filter((p) => p.comp === mcuRef)
  console.log(`\n=== ${mcuRef} 引脚（${mp.length} 个） ===`)
  const rows = []
  for (const p of mp.sort((a, b) => Number(a.props.DESIGNATOR) - Number(b.props.DESIGNATOR))) {
    const px = num(p.props['LOCATION.X'])
    const py = num(p.props['LOCATION.Y'])
    const near = labels
      .map((l) => ({ l, d: Math.hypot((l.x ?? 0) - (px ?? 0), (l.y ?? 0) - (py ?? 0)) }))
      .filter((o) => o.d <= 60)
      .sort((a, b) => a.d - b.d)[0]?.l
    rows.push({ pin: p.props.DESIGNATOR, name: p.props.NAME ?? '', net: near?.text ?? '', kind: near?.kind ?? '', d: near ? Math.round(Math.hypot((near.x ?? 0) - (px ?? 0), (near.y ?? 0) - (py ?? 0))) : null })
  }
  for (const r of rows) console.log(`   pin ${String(r.pin).padEnd(4)} ${(r.name ?? '').padEnd(14)} → ${r.net || '(未匹配到标签)'}${r.kind ? ` [${r.kind}]` : ''}${r.d != null ? ` d=${r.d}` : ''}`)
  const matched = rows.filter((r) => r.net).length
  console.log(`   标签匹配率：${matched}/${rows.length}`)
}

const netKw = arg('net')
if (netKw) {
  const re2 = new RegExp(netKw, 'i')
  console.log(`\n=== 含 "${netKw}" 的网络标签 ===`)
  for (const l of labels.filter((x) => re2.test(x.text)).slice(0, 40)) console.log(`   ${l.text}  (${l.kind}) @(${l.x},${l.y})`)
}

const out = arg('out')
if (out) {
  const csv = ['designator,libref,description']
  for (const c of comps) csv.push(`${c.props.__DES ?? ''},${c.props.LIBREFERENCE ?? ''},"${c.props.COMPONENTDESCRIPTION ?? ''}"`)
  fs.writeFileSync(`${out}-comps.csv`, csv.join('\n'), 'utf8')
  const nl = ['text,kind,x,y']
  for (const l of labels) nl.push(`"${l.text}",${l.kind},${l.x},${l.y}`)
  fs.writeFileSync(`${out}-labels.csv`, nl.join('\n'), 'utf8')
  console.log(`\n已导出：${out}-comps.csv / ${out}-labels.csv`)
}

console.log(`\n=== 能力与限制 ===`)
console.log('   能从 .SchDoc 提取：位号、型号、引脚号/脚名、网络标签、电源端口、坐标')
console.log('   ⚠ 反推网表依赖"标签坐标贴近引脚"，无标签的纯导线连接会漏；多页原理图需逐页合并')
console.log('   ✅ 最可靠仍是 Altium 导出的 .NET 或 ODB++；本工具用于没有导出件时的兜底与交叉验证')
