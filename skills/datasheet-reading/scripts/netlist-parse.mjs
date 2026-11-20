#!/usr/bin/env node
// netlist-parse.mjs — 解析 Altium/Protel 文本网表（.NET）：器件表 + 网络表 + 关键网络抽取
// 用法: node netlist-parse.mjs <.NET 文件> [--net 关键词] [--ref 位号] [--csv 输出前缀]
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node netlist-parse.mjs <netlist.NET> [--net kw] [--ref U1] [--csv prefix]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const raw = fs.readFileSync(file)
let text
try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { text = new TextDecoder('gbk').decode(raw) }
const lines = text.split(/\r?\n/).map((l) => l.trim())

const comps = []   // {des, footprint, comment}
const nets = []    // {name, pins:[{ref,pin}]}
let block = null

for (const line of lines) {
  if (line === '[') { block = { kind: 'comp', items: [] }; continue }
  if (line === '(') { block = { kind: 'net', items: [] }; continue }
  if (line === ']' || line === ')') {
    if (block?.kind === 'comp') {
      const [des, footprint, comment] = block.items
      if (des) comps.push({ des, footprint: footprint ?? '', comment: comment ?? '' })
    } else if (block?.kind === 'net') {
      const [name, ...pins] = block.items
      if (name) nets.push({ name, pins: pins.map((p) => { const m = p.match(/^(.+)-(\w+)$/); return m ? { ref: m[1], pin: m[2] } : { ref: p, pin: '?' } }) })
    }
    block = null
    continue
  }
  if (block) block.items.push(line)
}

// ---- 汇总
const mcu = comps.filter((c) => /^(U|IC|DSP|MCU)/i.test(c.des))
console.log(`=== 网表：${file.replace(/^.*[\\/]/, '')} ===`)
console.log(`器件 ${comps.length} 个 | 网络 ${nets.length} 个`)
console.log(`\n=== 主要 IC（U/IC/DSP 开头） ===`)
for (const c of mcu.slice(0, 12)) console.log(`   ${c.des.padEnd(6)} ${c.comment.padEnd(28)} ${c.footprint}`)

// ---- 关键网络（电机相关）
const KW = /(PWM|EPWM|ADC|CUR|CURR|ISEN|SHUNT|HALL|FAULT|TZ|VBUS|Vbus|VDC|BRAKE|DRV|GATE|PHASE|U_V|V_V|W_V|BUS|OPA|CMP)/i
const kwArg = arg('net')
const re = kwArg ? new RegExp(kwArg, 'i') : KW
const interesting = nets.filter((n) => re.test(n.name))
console.log(`\n=== 关键网络（${kwArg ? '匹配 ' + kwArg : 'PWM/ADC/CUR/HALL/FAULT/VBUS 等'}）：${interesting.length} 个 ===`)
for (const n of interesting.slice(0, 30)) {
  console.log(`   ${n.name.padEnd(22)} ${n.pins.map((p) => `${p.ref}-${p.pin}`).join(' ').slice(0, 110)}`)
}

// ---- 指定位号的引脚表
const refArg = arg('ref')
if (refArg) {
  const pins = []
  for (const n of nets) for (const p of n.pins) if (p.ref === refArg) pins.push({ pin: p.pin, net: n.name })
  pins.sort((a, b) => (Number(a.pin) || 0) - (Number(b.pin) || 0))
  console.log(`\n=== ${refArg} 引脚表（${pins.length} 个引脚） ===`)
  for (const p of pins) console.log(`   引脚 ${String(p.pin).padEnd(4)} → ${p.net}`)
}

// ---- CSV 导出
const csvPrefix = arg('csv')
if (csvPrefix) {
  fs.writeFileSync(`${csvPrefix}-components.csv`, 'designator,comment,footprint\n' + comps.map((c) => `${c.des},"${c.comment}","${c.footprint}"`).join('\n'), 'utf8')
  const netRows = ['net,ref,pin']
  for (const n of nets) for (const p of n.pins) netRows.push(`"${n.name}",${p.ref},${p.pin}`)
  fs.writeFileSync(`${csvPrefix}-nets.csv`, netRows.join('\n'), 'utf8')
  console.log(`\n已导出：${csvPrefix}-components.csv / ${csvPrefix}-nets.csv`)
}
