#!/usr/bin/env node
// odb-netlist.mjs — 从 ODB++ 还原"引脚 → 网络"表
// 用法: node odb-netlist.mjs <odb目录> [--ref U1] [--out pins.csv]
//
// 数据来源（Altium 导出的 ODB++ 实测格式）:
//   steps/<step>/layers/comp_+_top/components
//     CMP <idx> <x> <y> <rot> <mirror> <refdes> <package> ;attr
//     TOP <pinIdx> <x> <y> <rot> <mirror> <netNum> <?> <REF-pin>
//   steps/<step>/netlists/cadnet/netlist
//     $<netNum> <netName>
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node odb-netlist.mjs <odb目录> [--ref U1] [--out pins.csv]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

const stepsDir = path.join(root, 'steps')
const step = fs.readdirSync(stepsDir).find((d) => fs.statSync(path.join(stepsDir, d)).isDirectory())
const stepDir = path.join(stepsDir, step)
console.log(`=== ODB++ step: ${step} ===`)

// ---- 1. 网络号 → 网络名
const netNames = new Map()
const netFile = path.join(stepDir, 'netlists', 'cadnet', 'netlist')
if (fs.existsSync(netFile)) {
  for (const line of fs.readFileSync(netFile, 'latin1').split(/\r?\n/)) {
    const m = line.match(/^\$(\d+)\s+(\S.*)$/)
    if (m) netNames.set(m[1], m[2].trim())
  }
}
console.log(`网络名 ${netNames.size} 个`)

// ---- 2. 组件 + 引脚
const compFile = path.join(stepDir, 'layers', 'comp_+_top', 'components')
const comps = new Map()          // idx -> {ref, pkg, npins}
const pinRows = []               // {ref, pin, netNum}
let curComp = null
for (const line of fs.readFileSync(compFile, 'latin1').split(/\r?\n/)) {
  const c = line.match(/^CMP\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)/)
  if (c) { curComp = { idx: Number(c[1]), ref: c[2], pkg: c[3] }; comps.set(Number(c[1]), curComp); continue }
  const t = line.match(/^TOP\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\S+)-(\S+)\s*$/)
  if (t && curComp) pinRows.push({ ref: t[3], pin: t[4], netNum: t[2] })
}
console.log(`组件 ${comps.size} 个，引脚记录 ${pinRows.length} 条`)

const netOf = (n) => netNames.get(String(n)) ?? `#${n}`

// ---- 3. 输出
const ref = arg('ref')
if (ref) {
  const rows = pinRows.filter((r) => r.ref === ref).sort((a, b) => Number(a.pin) - Number(b.pin))
  const c = [...comps.values()].find((x) => x.ref === ref)
  console.log(`\n=== ${ref} ${c ? '(' + c.pkg + ')' : ''} 引脚表：${rows.length} 个 ===`)
  for (const r of rows) console.log(`  引脚 ${String(r.pin).padEnd(3)} → ${netOf(r.netNum)}`)
}
const out = arg('out')
if (out) {
  const csv = ['ref,pin,net']
  for (const r of pinRows) csv.push(`${r.ref},${r.pin},${netOf(r.netNum)}`)
  fs.writeFileSync(out, csv.join('\n'), 'utf8')
  console.log(`\n已写 ${out}（${csv.length - 1} 行）`)
}
