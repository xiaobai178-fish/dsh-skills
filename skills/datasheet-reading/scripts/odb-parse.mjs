#!/usr/bin/env node
// odb-parse.mjs — ODB++ 解析：网络名表 + 器件表（位号/型号/值）+ 各层焊盘统计
// 用法: node odb-parse.mjs <odb 目录> [--net kw] [--csv 前缀]
// 说明: ODB++ 的「引脚↔网络」在 comp_+_top 特征层里（常为压缩/加密块），
//       本工具稳定给出网络名与器件表；引脚级连接请用 .NET（netlist-parse.mjs）。
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node odb-parse.mjs <odbDir> [--net kw] [--csv prefix]'); process.exit(2) }
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const decode = (b) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch { return new TextDecoder('gbk').decode(b) } }

const stepsDir = path.join(root, 'steps')
if (!fs.existsSync(stepsDir)) { console.error('不是 ODB++ 目录：缺少 steps/'); process.exit(1) }
const steps = fs.readdirSync(stepsDir).filter((d) => fs.statSync(path.join(stepsDir, d)).isDirectory())

console.log(`=== ODB++：${root.replace(/^.*[\\/]/, '')} ===`)
console.log(`steps: ${steps.join(', ')}`)

for (const step of steps) {
  const base = path.join(stepsDir, step)

  // ---- 网络名
  const netFile = path.join(base, 'netlists', 'cadnet', 'netlist')
  const nets = []
  if (fs.existsSync(netFile)) {
    for (const line of decode(fs.readFileSync(netFile)).split(/\r?\n/)) {
      const m = line.match(/^\$(\d+)\s+(.+?)\s*$/)
      if (m && m[2] !== '$NONE$') nets.push({ num: Number(m[1]), name: m[2] })
    }
  }

  // ---- 器件（CMP 位号 + 型号/值）
  const comps = []
  const compDir = path.join(base, 'layers', 'comp_+_top')
  const compFile = path.join(compDir, 'components')
  let compAttr = []
  if (fs.existsSync(compFile)) {
    for (const line of decode(fs.readFileSync(compFile)).split(/\r?\n/)) {
      if (line.startsWith('@')) { compAttr.push(line.split(/\s+/)[1]); continue }
      if (!line.startsWith('CMP ')) continue
      const parts = line.split(/\s+/)
      // CMP <sym> <x> <y> <rot> <mir> <DES> <PART> [;attrs]
      const des = parts[6], part = parts[7] ?? ''
      const attrStr = (line.split(';')[1] ?? '').trim()
      const attrs = {}
      for (const kv of attrStr.split(',')) { const [k, v] = kv.split('='); if (k != null && v != null) attrs[k] = v }
      comps.push({ des, part, x: parts[2], y: parts[3], rot: parts[4], attrs })
    }
  }

  // ---- 各层焊盘统计（P 行）
  const layersDir = path.join(base, 'layers')
  const layerStats = []
  if (fs.existsSync(layersDir)) {
    for (const L of fs.readdirSync(layersDir)) {
      const f = path.join(layersDir, L, 'features')
      if (!fs.existsSync(f)) continue
      const buf = fs.readFileSync(f)
      if (buf.length > 4 * 1024 * 1024) { layerStats.push({ layer: L, pads: null, note: '过大/二进制，跳过' }); continue }
      let text
      try { text = decode(buf) } catch { continue }
      const pads = text.split(/\r?\n/).filter((l) => l.startsWith('P ')).length
      if (pads) layerStats.push({ layer: L, pads })
    }
  }

  console.log(`\n--- step: ${step} ---`)
  console.log(`网络 ${nets.length} 个${nets.length ? '，样例: ' + nets.slice(0, 8).map((n) => n.name).join(', ') : ''}`)
  console.log(`器件 ${comps.length} 个${comps.length ? '' : '（components 文件缺失或为空）'}`)
  for (const c of comps.slice(0, 10)) console.log(`   ${(c.des ?? '').padEnd(6)} ${(c.part ?? '').padEnd(22)} @${c.x},${c.y}`)
  const padLayers = layerStats.filter((l) => l.pads)
  if (padLayers.length) console.log(`焊盘层：${padLayers.map((l) => `${l.layer}(${l.pads})`).slice(0, 6).join(' ')}`)

  const kw = arg('net')
  if (kw) {
    const re = new RegExp(kw, 'i')
    console.log(`\n=== 网络名匹配 ${kw} ===`)
    for (const n of nets.filter((x) => re.test(x.name)).slice(0, 30)) console.log(`   $${n.num} ${n.name}`)
  }

  const csv = arg('csv')
  if (csv) {
    fs.writeFileSync(`${csv}-${step}-nets.csv`, 'netnum,name\n' + nets.map((n) => `${n.num},"${n.name}"`).join('\n'), 'utf8')
    fs.writeFileSync(`${csv}-${step}-comps.csv`, 'designator,part,x,y,rot\n' + comps.map((c) => `${c.des},"${c.part}",${c.x},${c.y},${c.rot}`).join('\n'), 'utf8')
    console.log(`\n已导出 ${csv}-${step}-nets.csv / -comps.csv`)
  }
}

console.log(`\n=== 说明 ===`)
console.log('   ODB++ 稳定给出：网络名表、器件表（位号/型号/值/坐标）、各层焊盘数')
console.log('   引脚↔网络：ODB++ 存放在 comp_+_top 特征层（常被压缩/加密）→ 用 .NET 的 netlist-parse.mjs 更可靠')
console.log('   交叉用途：ODB++ 的器件表可核对"板上实际装料"是否与固件目标型号一致')
