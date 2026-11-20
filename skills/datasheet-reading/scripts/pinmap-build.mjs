#!/usr/bin/env node
// pinmap-build.mjs — 从 TI 数据手册纯文本提取「引脚属性表」→ 生成 pin↔GPIO 映射 CSV
// 用法: node pinmap-build.mjs <datasheet.txt> [--package 48PT] [--out map.csv]
// 表结构（TI F28001x）：信号名 + 多路复用位置，下一行为 5 个封装的引脚号：
//   64 VPM | 64 PM | 48 RGZ | 48 PT | 32 RHB
// 输出: --out 指定时写 CSV（gpio,pin_48pt,...）；--package 48PT 时额外打印 pin,gpio 形式供 crosscheck 使用
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: node pinmap-build.mjs <datasheet.txt> [--package 48PT] [--out map.csv]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const pkg = arg('package') ?? '48PT'

const raw = fs.readFileSync(file)
let text
try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { text = new TextDecoder('gbk').decode(raw) }

// GPIO 行：GPIO0 0，4，8，12 \n 52 52 41 42 28
// 封装列数不定（2~5 个），按顺序对应 64VPM / 64PM / 48RGZ / 48PT / 32RHB；缺省表示该封装未引出该脚
const gpioRe = /GPIO(\d+)\s+[0-9，,、 ]+\r?\n\s*((?:\d+[ \t]*){2,5})/g
const rows = []
let m
while ((m = gpioRe.exec(text)) !== null) {
  const nums = m[2].trim().split(/\s+/).map(Number)
  rows.push({
    gpio: Number(m[1]),
    vpm64: nums[0] ?? null, pm64: nums[1] ?? null, rgz48: nums[2] ?? null, pt48: nums[3] ?? null, rhb32: nums[4] ?? null,
  })
}
rows.sort((a, b) => a.gpio - b.gpio)

const COLS = { '64VPM': 'vpm64', '64PM': 'pm64', '48RGZ': 'rgz48', '48PT': 'pt48', '32RHB': 'rhb32' }
const col = COLS[pkg.toUpperCase()] ?? 'pt48'

console.log(`=== 数据手册引脚表提取：${file.replace(/^.*[\\/]/, '')} ===`)
console.log(`识别到 GPIO 行：${rows.length} 条；目标封装 ${pkg}（列 ${col}）`)
if (!rows.length) {
  console.log('⚠ 未识别：该文本可能是用户手册或表格已被打散，改用 --loose 或人工整理')
  process.exit(1)
}
console.log('\nGPIO   ' + Object.keys(COLS).map((k) => k.padStart(7)).join('') )
for (const r of rows) {
  console.log(String(r.gpio).padStart(4) + '  ' + Object.values(COLS).map((c) => String(r[c]).padStart(7)).join(''))
}

// 交叉校验提示：找到 PWM/串口等复用信号行，便于人工确认
const signals = {}
for (const r of rows) signals[r.gpio] = []
const reSig = /(EPWM\d_[AB]|SCIA_[RT]X|I2CA_(SDA|SCL)|SPIA_\w+|ADCIN\d+|CMPSS\w*|EPWM\d_SYNC\w*)\s+\d+/g
console.log('\n（提示：多路复用信号没有逐行提取；如需某 GPIO 的复用表，用 grep 在手册文本里查 "GPIOxx"）')

const out = arg('out')
if (out) {
  const csv = ['gpio,vpm64,pm64,rgz48,pt48,rhb32']
  for (const r of rows) csv.push([r.gpio, r.vpm64, r.pm64, r.rgz48, r.pt48, r.rhb32].join(','))
  fs.writeFileSync(out, csv.join('\n'), 'utf8')
  console.log(`\n已写：${out}`)
  const mapOut = out.replace(/\.csv$/i, `-pinmap-${pkg}.csv`)
  const pinCsv = ['pin,gpio']
  for (const r of rows) pinCsv.push(`${r[col] ?? ''},${r.gpio}`)
  fs.writeFileSync(mapOut, pinCsv.join('\n'), 'utf8')
  console.log(`已写：${mapOut}（可直接给 crosscheck.mjs --pinmap 用）`)
}
