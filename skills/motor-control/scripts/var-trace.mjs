#!/usr/bin/env node
// var-trace.mjs — 变量链路溯源（C 工程，GBK/密文可读）
// 用法: node var-trace.mjs <项目目录> <变量名或表达式> [--map <map文件>] [--max=30] [--callers]
// 输出: 定义处 → 写入点 → 读取点 → 取地址/结构体/数组别名 → （可选）map 里的地址与归属
// 说明: 这是文本级溯源（regex + 上下文判定），能覆盖 90% 的普通变量；指针别名/宏展开会标"需人工确认"。
import fs from 'node:fs'
import path from 'node:path'

const SRC_EXT = /\.(c|h|cc|cpp|cxx|hpp)$/i
const SKIP = /^(\.git|node_modules|Objects|Listings|DebugConfig|build|Release|\.settings|_ai_plain_tmp|_backup|_mkflash_tmp.*|_tmp.*|_mig_tmp|_push_stage|__Previews|images|assets)$/i
const VENDOR = /(^|[\\/])(LIB|libs|STARTUP|CMSIS|Drivers|driverlib|StdPeriph|arm_math|core_cm|F2800\d+_examples|device_support)([\\/]|$)/i

function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { return new TextDecoder('gbk').decode(buf) }
}
function strip(text) {
  let out = '', i = 0
  const n = text.length
  while (i < n) {
    const c = text[i], d = text[i + 1]
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++ } i += 2; continue }
    if (c === '"' || c === "'") {
      const q = c; out += c; i++
      while (i < n) { if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue } out += text[i]; if (text[i] === q) { i++; break } i++ }
      continue
    }
    out += c; i++
  }
  return out
}

const root = process.argv[2]
const name = process.argv[3]
if (!root || !name) { console.error('usage: node var-trace.mjs <dir> <varName> [--map <mapfile>] [--max=30]'); process.exit(2) }
const max = Number((process.argv.find((a) => a.startsWith('--max=')) ?? '').split('=')[1] ?? 30)
const mapIdx = process.argv.indexOf('--map')
const mapFile = mapIdx > 0 ? process.argv[mapIdx + 1] : null

const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p) } else if (SRC_EXT.test(e.name)) files.push(p) } }
walk(root)
const appFiles = files.filter((f) => !VENDOR.test(f))

const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`)
const TYPE = '(u8|u16|u32|s8|s16|s32|int|unsigned|signed|char|short|long|float|double|bool|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|void|size_t|volatile|const|static|extern|struct|register)'
const defRe = new RegExp(`\\b${TYPE}\\b[^;=()]*\\b${esc}\\b|\\b${esc}\\s*\\[`)
const writeRe = new RegExp(`(^|[^=!<>+\\-*/%&|^])${esc}\\s*(=(?!=)|\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|<<=|>>=|\\+\\+|--)`)
const incRe = new RegExp(`(\\+\\+|--)\\s*${esc}\\b`)
const addrRe = new RegExp(`(?<!&)&(?![&=])\\s*${esc}\\b`)
const structRe = new RegExp(`\\.\\s*${esc}\\b`)

const defs = [], writes = [], reads = [], addrs = [], structs = [], macroArgs = []

for (const f of appFiles) {
  let text
  try { text = strip(decode(fs.readFileSync(f))) } catch { continue }
  const lines = text.split(/\r?\n/)
  const rel = path.relative(root, f)
  let fn = '?'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fnm = line.match(/^\s*(?:static\s+)?[A-Za-z_][\w \t\*]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*$/s)
    if (fnm && !/^\s*(if|for|while|switch|return)\b/.test(line)) fn = fnm[1]
    if (!wordRe.test(line)) continue
    const rec = { file: rel, line: i + 1, fn, code: line.trim().slice(0, 150) }
    if (defRe.test(line) && !/^\s*(return|if|for|while|switch)\b/.test(line)) defs.push(rec)
    else if (writeRe.test(line) || incRe.test(line)) writes.push(rec)
    else if (new RegExp(`\\b[A-Z_][A-Z0-9_]{2,}\\s*\\(\\s*${esc}\\s*[,)]`).test(line)) macroArgs.push(rec)
    else if (addrRe.test(line)) addrs.push(rec)
    else if (structRe.test(line)) structs.push(rec)
    else reads.push(rec)
  }
}

const show = (title, list, hint) => {
  console.log(`\n== ${title}：${list.length} 处${hint ? `（${hint}）` : ''} ==`)
  for (const r of list.slice(0, max)) console.log(`   ${r.file}:${r.line}  [${r.fn}]  ${r.code}`)
  if (list.length > max) console.log(`   …另有 ${list.length - max} 处`)
}

console.log(`=== 变量溯源：${name} ===`)
console.log(`扫描 ${appFiles.length} 个应用层文件（厂商库已排除；要含用 --include-vendor，未实现则换 motor-scan）`)
show('定义/声明', defs, '类型、全局、数组')
show('写入', writes, '赋值/复合赋值/自增自减')
show('宏实参（可能被宏写入）', macroArgs, '大写宏的第一个实参，宏体内可能赋值，需看宏定义')
show('取地址', addrs, '可能被指针或函数改写，需人工确认')
show('结构体成员访问', structs, '.字段（若 name 是结构体变量）')
show('读取', reads)

const total = defs.length + writes.length + reads.length + addrs.length + structs.length + macroArgs.length
console.log(`\n=== 链路摘要 ===`)
console.log(`   定义 ${defs.length} → 写 ${writes.length} + 宏写 ${macroArgs.length} → 取地址 ${addrs.length} → 读 ${reads.length}（共 ${total} 处）`)
if (macroArgs.length) console.log(`   ⚠ 有 ${macroArgs.length} 处把该变量当宏实参：宏体内可能赋值（如 GET_ADC_IBUS(X,A,B) 会写 X），必须打开宏定义确认`)
if (addrs.length) console.log(`   ⚠ 有 ${addrs.length} 处取地址：可能通过指针/函数参数改写，文本级溯源可能漏写点`)
if (!defs.length && !reads.length) console.log('   ⚠ 未找到该符号：检查拼写，或它在封库/厂商库里（用 lib-scan --dwarf 查）')

if (mapFile && fs.existsSync(mapFile)) {
  const txt = fs.readFileSync(mapFile, 'utf8')
  const hits = txt.split(/\r?\n/).filter((l) => new RegExp(`\\b${esc}\\b`).test(l)).slice(0, 15)
  console.log(`\n=== map 里的地址/归属（${path.basename(mapFile)}） ===`)
  for (const h of hits) console.log('   ' + h.trim().slice(0, 140))
  if (!hits.length) console.log('   （map 内未找到，可能变量被优化掉或名称不同）')
}

console.log(`\n=== 下一步 ===`)
console.log('   1) 逐个看「写入」行，确认写入速率（中断？主循环？）')
console.log('   2) 若某写入点来自指针/结构体拷贝，转人工读该函数')
console.log('   3) 需要地址 → 用 map（--map）或调试器 watch')
