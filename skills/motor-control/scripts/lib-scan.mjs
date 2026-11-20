#!/usr/bin/env node
// lib-scan.mjs — 预编译封库（.lib/.a/.o）与厂商库分析
// 用法: node lib-scan.mjs <工程目录> [--dwarf <输出文件>] [--max=20]
// 能力:
//   1) 列出工程内所有静态库/目标文件/链接 map
//   2) 用 Keil armar 列成员、fromelf 取符号表（名字/绑定/类型/大小）
//   3) 判定是否被 strip：含 .debug_* 段 => 未脱密，可恢复函数名、变量名、结构、行号
//   4) --dwarf 导出 DWARF 表，供 grep 变量名/类型
//   5) 解析 Keil .map：谁引用了库里的哪个符号（API 实际用法）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const BIN_CANDIDATES = [
  process.env.KEIL_BIN,
  'D:\\Keil_v5\\ARM\\ARMCC\\Bin',
  'C:\\Keil_v5\\ARM\\ARMCC\\Bin',
  'D:\\Keil_v6\\ARM\\ARMCLANG\\Bin',
].filter(Boolean)

function findTool(name) {
  for (const dir of BIN_CANDIDATES) {
    const p = path.join(dir, `${name}.exe`)
    if (fs.existsSync(p)) return p
  }
  const r = spawnSync('where', [name], { encoding: 'utf8' })
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim()
  return null
}

const ARMAR = findTool('armar')
const FROMELF = findTool('fromelf')

// ---------- 收集文件
const root = process.argv[2]
if (!root) {
  console.error('usage: node lib-scan.mjs <projectDir> [--dwarf <out.txt>] [--max=20]')
  process.exit(2)
}
const maxSamples = Number((process.argv.find((a) => a.startsWith('--max=')) ?? '').split('=')[1] ?? 20)
const dwarfIdx = process.argv.indexOf('--dwarf')
const dwarfOut = dwarfIdx > 0 ? process.argv[dwarfIdx + 1] : null

const SKIP = /^(\.git|node_modules|\.settings|__Previews|_ai_plain_tmp)$/i
const libs = []
const maps = []
const objs = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p); continue }
    if (/\.(lib|a)$/i.test(e.name)) libs.push(p)
    else if (/\.map$/i.test(e.name)) maps.push(p)
    else if (/\.(o|obj)$/i.test(e.name)) objs.push(p)
  }
}
walk(root)

console.log('=== 工具链 ===')
console.log(`armar   : ${ARMAR ?? '(未找到)'}`)
console.log(`fromelf : ${FROMELF ?? '(未找到)'}`)
console.log(`\n=== 发现 ===`)
console.log(`静态库 ${libs.length} 个 | 目标文件 ${objs.length} 个 | 链接 map ${maps.length} 个`)

// ---------- 分析静态库
for (const lib of libs) {
  const rel = path.relative(root, lib)
  const size = fs.statSync(lib).size
  console.log(`\n=== 库：${rel}（${size} B）===`)
  let members = []
  if (ARMAR) {
    const r = spawnSync(ARMAR, ['-t', lib], { encoding: 'utf8' })
    members = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    console.log(`成员（${members.length}）: ${members.join(', ')}`)
  }
  if (!FROMELF) { console.log('（无 fromelf，跳过符号分析）'); continue }

  const sym = spawnSync(FROMELF, ['--text', '-s', lib], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = sym.stdout ?? ''
  const hasDebug = /\.debug_(info|line|pubnames|frame|abbrev)/.test(out)
  console.log(`是否保留调试信息: ${hasDebug ? '✅ 是（未 strip，可恢复函数/变量名）' : '❌ 否（已 strip）'}`)

  // 符号表行: <no>  <name>  <value>  <bind>  <sec>  <type>  <vis>  <size>
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+0x([0-9a-fA-F]+))?/)
    if (!m) continue
    const [, , name, , bind, sec, type, , sz] = m
    if (/^(__ARM_grp|BuildAttributes|\$t|\.\.|_ARM)/.test(name)) continue
    rows.push({ name, bind, sec, type, size: sz ? parseInt(sz, 16) : null })
  }
  const globals = rows.filter((r) => r.bind === 'Gb' || r.bind === 'Wk')
  // 可执行节符号 i.Func 即函数（可能是 local），数据/变量为 Data/Obj
  const funcs = rows.filter((r) => /^i\./.test(r.name) || r.type === 'Sect')
  const dataSym = rows.filter((r) => (r.type === 'Data' || r.type === 'Obj') && !/^__ARM_grp/.test(r.name))
  console.log(`全局符号 ${globals.length} 个；函数/节 ${funcs.length} 个；数据/变量 ${dataSym.length} 个`)
  for (const r of [...funcs, ...dataSym].slice(0, maxSamples)) {
    console.log(`   ${r.bind === 'Wk' ? 'weak' : r.bind === 'Lc' ? 'local' : 'glob'}  ${(r.type ?? '').padEnd(5)} ${r.name}${r.size ? `  (${r.size}B)` : ''}`)
  }

  if (dwarfOut) {
    const d = spawnSync(FROMELF, ['--text', '-g', lib, '-o', dwarfOut], { encoding: 'utf8' })
    console.log(`DWARF 表已导出: ${dwarfOut}（${fs.existsSync(dwarfOut) ? fs.statSync(dwarfOut).size : 0} B）`)
    if (fs.existsSync(dwarfOut)) {
      const txt = fs.readFileSync(dwarfOut, 'utf8')
      const names = [...txt.matchAll(/DW_AT_name\s+(.+)$/gm)].map((m) => m[1].trim())
      const uniq = [...new Set(names)].filter((n) => !n.endsWith('.c') && !n.endsWith('.h'))
      console.log(`可恢复名字 ${uniq.length} 个，样例: ${uniq.slice(0, 12).join(', ')}`)
      console.log(`用 grep 找具体变量: Select-String -Path "${dwarfOut}" -Pattern "DW_AT_name <变量名>" -Context 2,2`)
    }
  }
}

// ---------- 分析 map：库的 API 被谁调用
for (const map of maps.slice(0, 3)) {
  const rel = path.relative(root, map)
  console.log(`\n=== 链接 map：${rel} ===`)
  const txt = fs.readFileSync(map, 'utf8')
  const libNames = libs.map((l) => path.basename(l).replace(/\.lib$/i, '.o').toLowerCase())
  const used = new Map() // symbol -> callers
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\(([^)]+)\)\s+refers to\s+(\S+)\(([^)]+)\)\s+for\s+(\S+)/)
    if (!m) continue
    const [, callerObj, callerFn, targetObj, targetFn, sym] = m
    if (libNames.includes(targetObj.toLowerCase())) {
      if (!used.has(sym)) used.set(sym, [])
      used.get(sym).push(`${callerObj}(${callerFn})`)
    }
  }
  if (used.size === 0) console.log('（未发现对封库符号的引用，可能封库未被链接或 map 不含交叉引用）')
  for (const [sym, callers] of [...used].slice(0, maxSamples)) {
    console.log(`   ${sym}  ← ${callers.slice(0, 4).join(', ')}${callers.length > 4 ? ` …+${callers.length - 4}` : ''}`)
  }
}

console.log('\n=== 下一步 ===')
console.log('   封库未 strip → node lib-scan.mjs <目录> --dwarf <out.txt>，再 grep DW_AT_name 找变量/结构')
console.log('   反汇编函数体 → fromelf --text -c <lib> -o dis.txt（看常量、状态机、查表）')
console.log('   运行时观察变量 → 从 .map 取符号地址，用调试器 watch/读 RAM')
console.log('   接口语义 → 优先看同一套工程里的头文件（如 BLDC.H）与 .map 的引用关系')
if (!ARMAR || !FROMELF) console.log('   ⚠ 未找到 Keil 工具；请设置环境变量 KEIL_BIN 指向 ...\\ARM\\ARMCC\\Bin')
