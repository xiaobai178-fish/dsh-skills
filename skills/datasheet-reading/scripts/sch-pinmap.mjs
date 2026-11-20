#!/usr/bin/env node
// sch-pinmap.mjs — 从 Altium .SchDoc 的器件符号提取"引脚号 ↔ 端口 ↔ 复用功能"表
// 用法: node sch-pinmap.mjs <x.SchDoc> [--mcu LKS057] [--out pins.csv]
// 原理: 器件符号的引脚 NAME 字段通常写成 "ADC_CH6/CMP0_IP1/P0.11" 这种复用串，
//       它就是"引脚号↔端口↔通道"的独立来源（与数据手册互证）。
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node sch-pinmap.mjs <SchDoc> [--mcu LKS057] [--out pins.csv]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const s = fs.readFileSync(file).toString('latin1')
const re = /RECORD=(\d+)\|/g
const marks = []
let m
while ((m = re.exec(s)) !== null) marks.push({ type: Number(m[1]), at: m.index, bodyAt: re.lastIndex })
const recs = []
for (let i = 0; i < marks.length; i++) {
  const end = i + 1 < marks.length ? marks[i + 1].at : Math.min(s.length, marks[i].bodyAt + 4000)
  const body = s.slice(marks[i].bodyAt, end)
  const props = {}
  for (const kv of body.split('|')) {
    const e = kv.indexOf('=')
    if (e <= 0) continue
    const k = kv.slice(0, e).trim()
    if (/^[A-Z][A-Z0-9_.]*$/.test(k)) props[k] = kv.slice(e + 1).trim()
  }
  recs.push({ type: marks[i].type, idx: i, props })
}

const comps = recs.filter((r) => r.type === 1 && r.props.LIBREFERENCE)
const pins = recs.filter((r) => r.type === 2 && r.props.DESIGNATOR)

// 选定主控：--mcu 精确匹配 LIBREFERENCE；否则取引脚最多者
const mcuName = arg('mcu')
let mcu
if (mcuName) mcu = comps.find((c) => c.props.LIBREFERENCE === mcuName)
if (!mcu) {
  const count = new Map()
  for (const p of pins) { const o = p.props.OWNERINDEX; if (o != null) count.set(o, (count.get(o) ?? 0) + 1) }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!best) { console.error('未找到引脚'); process.exit(1) }
  mcu = comps.find((c) => c.idx === Number(best[0])) ?? { idx: Number(best[0]), props: {} }
}

const mcuPins = pins.filter((p) => Number(p.props.OWNERINDEX) === mcu.idx)
console.log(`=== 主控符号：${mcu.props.LIBREFERENCE ?? '(未知)'}（${mcuPins.length} 引脚）===`)

const rows = []
for (const p of mcuPins) {
  const name = p.props.NAME ?? ''
  const port = /(P\d\.\d+)/.exec(name)?.[1] ?? ''
  const chans = [...name.matchAll(/ADC_CH(\d+)/gi)].map((x) => `ADC_CH${x[1]}`)
  rows.push({ pin: p.props.DESIGNATOR, name, port, chans })
}
rows.sort((a, b) => Number(a.pin) - Number(b.pin))
for (const r of rows.slice(0, 14)) console.log(`   pin ${String(r.pin).padEnd(3)} ${r.port.padEnd(6)} ${r.chans.join(',')}   ${r.name.slice(0, 46)}`)

if (arg('out')) {
  const csv = ['pin,port,adc_channels,name']
  for (const r of rows) csv.push(`${r.pin},${r.port},"${r.chans.join('/')}","${r.name.replace(/"/g, '""')}"`)
  fs.writeFileSync(arg('out'), csv.join('\n'), 'utf8')
  console.log(`\n已写 ${arg('out')}（${rows.length} 行）`)
}
