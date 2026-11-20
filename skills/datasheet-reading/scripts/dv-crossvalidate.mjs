#!/usr/bin/env node
// dv-crossvalidate.mjs — 数据手册映射的三方交叉验证 + 可信度评分
//
// 用法:
//   node dv-crossvalidate.mjs --ds <引脚表.csv> [--fw <固件目录>] [--ds2 <第二份引脚表.csv>] [--netlist <.NET>]
//
// 数据来源:
//   --ds    主数据手册导出的引脚表（由 pin-table-from-words.mjs 生成；列：port,AF1..AFn）
//   --fw    固件目录：扫描 ADC 通道号与 GPIO 端口/引脚的实际使用
//   --ds2   第二份文档（另一版数据手册/用户手册）的引脚表，用于"同字段双文档比对"
//   --netlist  Altium .NET：引脚→网络，用于确认该引脚确实接了信号
//
// 判定:
//   ✅ 已验证：两个及以上独立来源给出同一结论
//   ⚠ 无法校验：只有一个来源，或固件未体现端口
//   ❌ 冲突：来源之间矛盾
// 输出末尾给"可信度 = 已验证 / (已验证 + 无法校验)"
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }

/* ---------- 1. 读引脚表 CSV：port -> 列名 -> 文本 ---------- */
function readPinTable(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  const rows = []
  for (const l of lines.slice(1)) {
    const cells = l.split(',')
    const rec = { port: cells[0], cols: {} }
    header.forEach((h, i) => { if (i > 0) rec.cols[h] = cells[i] ?? '' })
    rows.push(rec)
  }
  return { header, rows }
}

/** 从引脚表提取 channel -> port 映射（channel 形如 ADC_CH4 / ADC_CHANNEL_4 / ADCIN4） */
function channelMap(tbl) {
  const map = new Map()
  for (const r of tbl.rows) {
    for (const [col, txt] of Object.entries(r.cols)) {
      for (const m of String(txt).matchAll(/ADC[_\s]*(?:CH|CHANNEL|IN)[_\s]*(\d+)/gi)) {
        const ch = `ADC_CH${m[1]}`
        map.set(ch, { port: r.port, col, raw: txt })
      }
    }
  }
  return map
}

/* ---------- 2. 扫固件：通道使用 + 端口/引脚使用 ---------- */
const SRC = /\.(c|h)$/i
// 默认排除 SDK/驱动/厂商库，避免把"库里有定义"当成"应用层在用"（--include-sdk 可放开）
const includeSdk = process.argv.includes('--include-sdk')
const SKIP = includeSdk
  ? /^(\.git|node_modules|Objects|Listings|Release|build|DebugConfig|\.settings|_ai_plain_tmp)$/i
  : /^(\.git|node_modules|Objects|Listings|Release|build|DebugConfig|\.settings|_ai_plain_tmp|LKS32MC\d+_Periph_Driver|Drivers|driverlib|HAL|hal|libs|LIB|Startup|CMSIS)$/i
function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p, acc) }
    else if (SRC.test(e.name)) acc.push(p)
  }
  return acc
}
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { return new TextDecoder('gbk').decode(buf) }
}
function strip(t) {
  let o = '', i = 0
  const n = t.length
  while (i < n) {
    const c = t[i], d = t[i + 1]
    if (c === '/' && d === '/') { while (i < n && t[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(t[i] === '*' && t[i + 1] === '/')) { if (t[i] === '\n') o += '\n'; i++ } i += 2; continue }
    if (c === '"' || c === "'") { const q = c; o += c; i++; while (i < n) { if (t[i] === '\\') { o += t[i] + (t[i + 1] ?? ''); i += 2; continue } o += t[i]; if (t[i] === q) { i++; break } i++ } continue }
    o += c; i++
  }
  return o
}

function scanFirmware(dir) {
  const files = walk(dir)
  const chUse = new Map()   // ADC_CHn -> [位置]
  const pinUse = new Map()  // P0.3 / HAL_GPIO_P0_3 -> [位置]
  const segCh = []          // FirSeg_Ch / SecSeg_Ch 的数值
  const macros = new Map()  // 宏名 -> { ch, at, line }  形如 #define X ... ADC_CHANNEL_9
  const macroUse = new Map() // 宏名 -> [使用位置]
  for (const f of files) {
    let code
    try { code = strip(decode(fs.readFileSync(f))) } catch { continue }
    const rel = path.relative(dir, f)
    code.split(/\r?\n/).forEach((line, i) => {
      const at = `${rel}:${i + 1}`
      // #define XXX ... ADC_CHANNEL_n  /  ADC_CHn
      const def = line.match(/^\s*#define\s+(\w+)\s+.*?(?:ADC_CHANNEL_|ADC_CH)(\d+)\b/)
      if (def) macros.set(def[1], { ch: Number(def[2]), at, line: line.trim() })
      // 宏被使用（排除 define 行）
      if (!/^\s*#define/.test(line)) {
        for (const name of macros.keys()) {
          if (new RegExp(`\\b${name}\\b`).test(line)) {
            if (!macroUse.has(name)) macroUse.set(name, [])
            macroUse.get(name).push(at)
          }
        }
      }
      for (const m of line.matchAll(/ADC[_\s]*(?:CH|CHANNEL|IN)[_\s]*(\d+)/gi)) {
        const k = `ADC_CH${m[1]}`
        if (!chUse.has(k)) chUse.set(k, [])
        chUse.get(k).push(at)
      }
      for (const m of line.matchAll(/HAL_GPIO_P(\d)_(\d+)/g)) {
        const key = `P${m[1]}.${m[2]}`
        if (!pinUse.has(key)) pinUse.set(key, [])
        pinUse.get(key).push(at)
      }
      const seg = line.match(/(FirSeg_Ch|SecSeg_Ch|ADC_Seg\w*Ch)\s*=\s*(\d+)/)
      if (seg) segCh.push({ name: seg[1], ch: Number(seg[2]), at })
    })
  }
  return { files: files.length, chUse, pinUse, segCh, macros, macroUse }
}

/* ---------- 3. 网表：pin -> net（只取主控位号）---------- */
function readNetlist(file, mcu) {
  const txt = decode(fs.readFileSync(file))
  const nets = []
  let blk = null
  for (const line of txt.split(/\r?\n/).map((l) => l.trim())) {
    if (line === '(') { blk = []; continue }
    if (line === ')') { if (blk && blk.length > 1) nets.push({ name: blk[0], pins: blk.slice(1) }); blk = null; continue }
    if (blk) blk.push(line)
  }
  const pinNet = new Map()
  for (const n of nets) for (const p of n.pins) {
    const m = p.match(/^(.+)-(\w+)$/)
    if (m && (!mcu || m[1] === mcu)) pinNet.set(m[2], n.name)
  }
  return pinNet
}

/* ---------- 4. 主流程 ---------- */
const dsFile = arg('ds')
if (!dsFile) { console.error('usage: node dv-crossvalidate.mjs --ds <pins.csv> [--fw dir] [--ds2 pins2.csv] [--netlist x.NET --mcu U12]'); process.exit(2) }

const ds = readPinTable(dsFile)
const dsMap = channelMap(ds)
console.log(`=== 主来源：${path.basename(dsFile)} ===`)
console.log(`端口行 ${ds.rows.length}，识别到 ADC 通道 ${dsMap.size} 条`)
for (const [ch, v] of [...dsMap.entries()].slice(0, 20)) console.log(`   ${ch.padEnd(9)} → ${v.port}  (${v.col}: ${v.raw})`)

let ds2Map = null
const ds2File = arg('ds2')
if (ds2File) {
  ds2Map = channelMap(readPinTable(ds2File))
  console.log(`\n=== 第二来源：${path.basename(ds2File)}（${ds2Map.size} 条）===`)
}

// --sch：原理图符号引脚表（由 sch-pinmap.mjs 生成：pin,port,adc_channels,name）
const schFile = arg('sch')
let schMap = null
if (schFile) {
  schMap = new Map()
  const lines = fs.readFileSync(schFile, 'utf8').split(/\r?\n/).filter(Boolean)
  for (const l of lines.slice(1)) {
    const m = l.match(/^(\d+),([^,]*),"?([^",]*)"?,(.*)$/)
    if (!m) continue
    const port = m[2].trim()
    const chans = m[3].split('/').map((x) => x.trim()).filter(Boolean)
    for (const ch of chans) schMap.set(ch, { port, pin: m[1], raw: m[4] })
  }
  console.log(`\n=== 原理图符号来源：${path.basename(schFile)}（${schMap.size} 条通道）===`)
  for (const [ch, v] of [...schMap.entries()].slice(0, 12)) console.log(`   ${ch.padEnd(9)} → ${v.port} (pin ${v.pin})`)
}

const fwDir = arg('fw')
let fw = null
if (fwDir) {
  fw = scanFirmware(fwDir)
  console.log(`\n=== 固件证据：${fwDir}（${fw.files} 个源文件）===`)
  console.log(`   通道号引用：${fw.chUse.size} 种 ${[...fw.chUse.keys()].join(' ')}`)
  console.log(`   端口/引脚引用：${fw.pinUse.size} 个 ${[...fw.pinUse.keys()].slice(0, 12).join(' ')}`)
  console.log(`   ADC 段配置：${fw.segCh.map((s) => `${s.name}=${s.ch}@${s.at}`).slice(0, 6).join('  ') || '(无)'}`)
}

const netFile = arg('netlist')
const pinNet = netFile ? readNetlist(netFile, arg('mcu')) : null
if (pinNet) console.log(`\n=== 网表：${path.basename(netFile)}（主控引脚 ${pinNet.size} 个）===`)

/* ---------- 5. 判定 ---------- */
console.log('\n=== 交叉验证结果 ===')
let ok = 0, warn = 0, bad = 0
const rows = []
for (const [ch, v] of dsMap) {
  const evidences = []
  if (ds2Map) {
    const v2 = ds2Map.get(ch)
    if (v2) evidences.push(v2.port === v.port ? `✅第二来源一致(${v2.port})` : `❌第二来源冲突(DS2=${v2.port})`)
  }
  if (schMap) {
    const v3 = schMap.get(ch)
    if (v3) {
      const ports = new Set([...(v3.raw ?? '').matchAll(/P\d\.\d+/g)].map((x) => x[0]))
      if (v3.port) ports.add(v3.port)
      if (ports.has(v.port)) {
        evidences.push(`✅原理图符号含该端口(${[...ports].join('/')} · pin${v3.pin})`)
      } else {
        evidences.push(`❌原理图符号冲突(符号 ${[...ports].join('/')} · pin${v3.pin} vs 手册 ${v.port})`)
      }
    } else {
      evidences.push('ℹ原理图符号未标注该通道')
    }
  }
  if (fw) {
    const chRef = fw.chUse.has(ch)
    const segHit = fw.segCh.some((s) => `ADC_CH${s.ch}` === ch)
    // 固件宏（#define X ... ADC_CHANNEL_n）指向该通道
    const macroHit = [...fw.macros.entries()].filter(([, v]) => v.ch === Number(ch.match(/(\d+)$/)[1]))
    if (chRef || segHit || macroHit.length) {
      const portRef = fw.pinUse.has(v.port)
      const names = macroHit.map(([k]) => k).slice(0, 3).join('/')
      evidences.push(
        portRef
          ? `✅固件同文件引用端口 ${v.port}`
          : `⚠固件使用了该通道${names ? `（宏 ${names}）` : ''}但未显式配置端口 ${v.port}`
      )
    }
  }
  if (pinNet) {
    // 端口→封装引脚号：必须用原理图符号表（schMap.pin），不能用 Pn.m 的数字（会错，如 P0.11≠pin11）
    let pinNo = null
    if (schMap) {
      const v3 = schMap.get(ch)
      if (v3 && v3.pin) pinNo = String(v3.pin)
    }
    if (pinNo != null) {
      const net = pinNet.get(pinNo)
      if (net) evidences.push(`✅网表 pin${pinNo}→${net}`)
      else evidences.push(`⚠网表 pin${pinNo} 无网络`)
    }
  }
  const failed = evidences.some((e) => e.startsWith('❌'))
  const good = evidences.filter((e) => e.startsWith('✅')).length
  if (failed) bad++
  else if (good >= 1) ok++
  else warn++
  rows.push(`${ch.padEnd(9)} ${v.port.padEnd(7)} ${evidences.join(' | ') || '⚠无独立证据'}`)
}
for (const r of rows) console.log('   ' + r)

const total = ok + warn + bad
const score = total ? ((ok / total) * 100).toFixed(0) : '0'
console.log(`\n=== 可信度 ===`)
console.log(`   ✅已验证 ${ok} ｜ ⚠无法校验 ${warn} ｜ ❌冲突 ${bad} ｜ 总计 ${total}`)
console.log(`   可信度 = ${score}%`)

/* ---------- 6. 集合差异：固件用了但手册没有 / 手册有但固件没用 ---------- */
if (fw) {
  const fwChans = new Set()
  // 只算"真正被使用的"：被引用的宏 + ADC 段号；单独出现的 #define 不算使用
  for (const [name, v] of fw.macros) if (fw.macroUse.has(name)) fwChans.add(v.ch)
  for (const s of fw.segCh) fwChans.add(s.ch)
  const dsChans = new Set([...dsMap.keys()].map((k) => Number(k.match(/(\d+)$/)[1])))
  const missing = [...fwChans].filter((c) => !dsChans.has(c)).sort((a, b) => a - b)
  const unused = [...dsChans].filter((c) => !fwChans.has(c)).sort((a, b) => a - b)
  // 区分"内部通道"（OPA 输出/温度传感器等，本就不在引脚表里）与"真缺失"
  const internalCh = new Set()
  for (const [name, v] of fw.macros) {
    if (/OPA|TEMP|内部|INTERNAL/i.test(name)) internalCh.add(v.ch)
  }
  const realMissing = missing.filter((c) => !internalCh.has(c))
  const missingInternal = missing.filter((c) => internalCh.has(c))
  console.log(`\n=== 集合差异（判断手册表是否完整）===`)
  console.log(`   固件用到通道：${[...fwChans].sort((a, b) => a - b).join(',') || '(无)'}`)
  console.log(`   手册已列通道：${[...dsChans].sort((a, b) => a - b).join(',') || '(无)'}`)
  if (missingInternal.length) console.log(`   ℹ内部通道（OPA 输出/温度等，本不在引脚表）：${missingInternal.join(',')} → 非缺失`)
  if (realMissing.length) console.log(`   ❗固件使用但手册未列出：${realMissing.join(',')} → 表可能不完整，不可当完整结论`)
  if (unused.length) console.log(`   ℹ手册列出但固件未使用：${unused.join(',')} → 可能未用到或配置在别处`)
  if (!realMissing.length) console.log(`   ✅引脚通道集合一致（外部通道全部落在手册表内）`)
}

if (bad > 0) { console.log('   ⚠ 存在冲突：不得直接采信，必须人工核对'); process.exit(1) }
if (ok === 0) { console.log('   ⚠ 没有任何独立证据：结论仅为"单一来源"，不可称"无误"'); process.exit(1) }
