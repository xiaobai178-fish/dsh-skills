#!/usr/bin/env node
// eda-scan.mjs — 项目资料文件夹扫描：原理图/PCB/网表/数据手册 清单与可用性评级
// 用法: node eda-scan.mjs <项目目录>
// 目的: 用户每个项目一个文件夹，先判断"有哪些料、能分析到什么程度、缺什么必须补"
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node eda-scan.mjs <projectDir>'); process.exit(2) }

const EXT = /\.(SchDoc|PcbDoc|NET|sch|pcb|pdf|rep|htm|csv|txt)$/i
const found = { schdoc: [], pcbdoc: [], net: [], oldSch: [], pdf: [], rep: [], other: [] }
let odb = false

const walk = (d, depth = 0) => {
  if (depth > 4) return
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (/^odb/i.test(e.name)) odb = true
      if (!/^(\.git|node_modules|_ai_plain_tmp)$/i.test(e.name)) walk(p, depth + 1)
      continue
    }
    const ext = path.extname(e.name).toLowerCase()
    const rel = path.relative(root, p)
    if (ext === '.schdoc') found.schdoc.push({ p, rel, size: e.isDirectory() ? 0 : fs.statSync(p).size })
    else if (ext === '.pcbdoc') found.pcbdoc.push({ p, rel, size: fs.statSync(p).size })
    else if (ext === '.net') found.net.push({ p, rel, size: fs.statSync(p).size })
    else if (ext === '.sch') found.oldSch.push({ p, rel, size: fs.statSync(p).size })
    else if (ext === '.pdf') found.pdf.push({ p, rel, size: fs.statSync(p).size })
    else if (ext === '.rep') found.rep.push({ p, rel, size: fs.statSync(p).size })
  }
}
walk(root)

const fmt = (arr, label) => {
  console.log(`\n== ${label}：${arr.length} 个 ==`)
  for (const f of arr.slice(0, 8)) console.log(`   ${String(f.size).padStart(8)}B  ${f.rel}`)
  if (arr.length > 8) console.log(`   …另有 ${arr.length - 8} 个`)
}

console.log(`=== 项目资料扫描：${root} ===`)
fmt(found.net, '文本网表 .NET（最可靠，可直接解析）')
if (odb) console.log('\n== ODB++ 目录：已存在（最佳，可提取完整连接表） ==')
fmt(found.schdoc, 'Altium 原理图 .SchDoc（可提取器件/标签，但反推网表不可靠）')
fmt(found.pcbdoc, 'Altium PCB .PcbDoc（可核对实际装料型号）')
fmt(found.oldSch, '旧版原理图 .sch（Protel99 等，通常为二进制，支持有限）')
fmt(found.rep, '工程报告 .rep（可能有 BOM/网络统计）')
fmt(found.pdf, 'PDF（原理图/数据手册，用于查引脚与参数）')

// 可用性评级
const has = (k) => found[k].length > 0
console.log('\n=== 可用性评级 ===')
const grade = (ok, text) => console.log(`   ${ok ? '✅' : '❌'} ${text}`)
grade(has('net') || odb, '完整连接表（.NET 或 ODB++）→ 可精确出引脚表与网络表')
grade(has('schdoc'), '.SchDoc → 只能取器件型号/网络标签，不足以反推网表')
grade(has('pcbdoc'), '.PcbDoc → 可核对板上实际型号（与固件目标型号对账）')
grade(has('pdf'), 'PDF → 可查引脚定义/参数（适合与网表交叉验证）')

console.log('\n=== 建议动作 ===')
if (!has('net') && !odb) {
  console.log('   ⚠ 缺 .NET/ODB++：请在 Altium 里 File → Export → Netlist → Protel，导出到本文件夹')
  console.log('      （或 File → Fabrication Outputs → ODB++）')
}
if (has('pdf')) console.log('   数据手册：查 MCU 引脚复用表（GPIO↔ADCIN 映射必须以此为准）')
console.log('   下一步：node netlist-parse.mjs <工程.NET> --mcu <U编号>  → 引脚表')
console.log('            node crosscheck.mjs <.NET> <固件目录>            → 硬件↔固件对账')
