#!/usr/bin/env node
// crosscheck.mjs — 硬件网表 ↔ 固件配置 对账
// 用法: node crosscheck.mjs <.NET> <固件目录> [--mcu U12] [--pinmap map.csv]
// pinmap.csv 格式: pin,gpio        （来自 MCU 数据手册的引脚复用表；没有它无法做严格对账）
// 原则: 网表给"物理引脚→网络"，固件给"信号→GPIO/ADC通道"，两者只能通过数据手册的 pin↔GPIO 表 join。
import fs from 'node:fs'
import path from 'node:path'

const [netFile, fwDir] = process.argv.slice(2)
if (!netFile || !fwDir) { console.error('usage: node crosscheck.mjs <.NET> <firmwareDir> [--mcu U12] [--pinmap map.csv]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

// ---------- 1. 解析网表
const raw = fs.readFileSync(netFile)
let text
try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { text = new TextDecoder('gbk').decode(raw) }
const nets = []
let blk = null
for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
  if (line === '(') { blk = []; continue }
  if (line === ')') {
    if (blk && blk.length) nets.push({ name: blk[0], pins: blk.slice(1).map((p) => { const m = p.match(/^(.+)-(\w+)$/); return m ? { ref: m[1], pin: m[2] } : { ref: p, pin: '?' } }) })
    blk = null; continue
  }
  if (blk) blk.push(line)
}

const mcuRef = arg('mcu')
const mcuPins = new Map() // pin -> net
for (const n of nets) for (const p of n.pins) if (p.ref === mcuRef) mcuPins.set(p.pin, n.name)

// ---------- 2. 解析固件配置
const SRC = /\.(c|h)$/i
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(\.git|node_modules|Release|build|Objects|Listings)$/i.test(e.name)) walk(p) } else if (SRC.test(e.name)) files.push(p) } }
walk(fwDir)

const fw = { pins: [], adc: [], pwm: [], other: [] }
for (const f of files) {
  let b = fs.readFileSync(f)
  let t
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { t = new TextDecoder('gbk').decode(b) }
  const rel = path.relative(fwDir, f)
  t.split(/\r?\n/).forEach((line, i) => {
    const L = line.trim()
    let m
    if ((m = L.match(/CFG_PIN_(\w+?)_GPIO\s+(\d+)/))) fw.pins.push({ sig: m[1], gpio: m[2], at: `${rel}:${i + 1}` })
    else if ((m = L.match(/CFG_PIN_(\w+?)_CFG\s+GPIO_(\d+)_(\w+)/))) fw.pwm.push({ sig: m[1], gpio: m[2], fn: m[3], at: `${rel}:${i + 1}` })
    else if ((m = L.match(/CFG_ADC_CH_(\w+)\s+ADC_CH_ADCIN(\d+)/))) fw.adc.push({ sig: m[1], ch: m[2], at: `${rel}:${i + 1}` })
    else if ((m = L.match(/GPIO_InitStructure\.GPIO_Pin\s*=\s*(GPIO_Pin_\d+)/))) fw.other.push({ sig: m[1], at: `${rel}:${i + 1}` })
  })
}

console.log(`=== 网表：${path.basename(netFile)} | 网络 ${nets.length} ===`)
if (mcuRef) {
  console.log(`\n=== ${mcuRef} 物理引脚 → 网络（${mcuPins.size} 个） ===`)
  const rows = [...mcuPins.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
  for (const [pin, net] of rows) console.log(`   pin ${String(pin).padEnd(4)} → ${net}`)
} else {
  console.log('   （加 --mcu <位号> 可只列主控引脚）')
}

console.log(`\n=== 固件信号定义（${files.length} 个源文件） ===`)
console.log(`   PWM/GPIO 功能: ${fw.pwm.length}`)
for (const x of fw.pwm.slice(0, 12)) console.log(`      ${x.sig.padEnd(6)} GPIO${x.gpio}  ${x.fn}   ${x.at}`)
console.log(`   普通 GPIO: ${fw.pins.length}`)
for (const x of fw.pins.slice(0, 8)) console.log(`      ${x.sig.padEnd(6)} GPIO${x.gpio}   ${x.at}`)
console.log(`   ADC 通道: ${fw.adc.length}`)
for (const x of fw.adc.slice(0, 12)) console.log(`      ${x.sig.padEnd(8)} ADCIN${x.ch}   ${x.at}`)

// ---------- 3. 对账（需要 pin↔gpio 映射表）
const pinmapFile = arg('pinmap')
if (!pinmapFile) {
  console.log('\n=== 对账状态：需要引脚映射表 ===')
  console.log('   网表给"物理引脚号"，固件给"GPIO 编号/ADC 通道"，两者必须用 MCU 数据手册的引脚复用表 join。')
  console.log('   做法：从数据手册整理 pin,gpio 两列 CSV 后重跑：')
  console.log(`   node crosscheck.mjs "${path.basename(netFile)}" <固件目录> --mcu ${mcuRef ?? 'Uxx'} --pinmap map.csv`)
  process.exit(0)
}

const map = new Map()
for (const line of fs.readFileSync(pinmapFile, 'utf8').split(/\r?\n/).slice(1)) {
  const parts = line.split(',')
  if (parts.length < 2) continue
  const pin = parts[0].trim(), gpio = parts[1].trim()
  if (gpio) map.set(gpio, pin)   // pin 为空表示该封装未引出
}
console.log(`\n=== 对账结果（pinmap ${map.size} 条） ===`)
let ok = 0, gap = 0, noMap = 0, notBonded = 0
const pinRow = new Map() // gpio -> 该 GPIO 在各封装的引脚（来自 pinmap 全列 CSV，可选）
for (const p of fw.pwm) {
  const pin = map.get(p.gpio)
  if (pin == null) { noMap++; console.log(`   ⚠ ${p.sig.padEnd(6)} GPIO${p.gpio} → 映射表缺该 GPIO（补 pinmap 后再判）`); continue }
  if (pin === '' || pin === '0') { notBonded++; console.log(`   ⚠ ${p.sig.padEnd(6)} GPIO${p.gpio} → 该封装未引出（未 bonding），固件不应使用此脚`); continue }
  const net = mcuPins.get(pin)
  if (net) { ok++; console.log(`   ✅ ${p.sig.padEnd(6)} GPIO${p.gpio} → pin${pin} → ${net}`) }
  else { gap++; console.log(`   ❌ ${p.sig.padEnd(6)} GPIO${p.gpio} → pin${pin} → 该引脚在网表中无网络（真缺口）`) }
}
console.log(`   合计：匹配 ${ok}，真缺口 ${gap}，映射缺失 ${noMap}，本封装未引出 ${notBonded}`)
