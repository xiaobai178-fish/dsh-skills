#!/usr/bin/env node
// motor-scan.mjs — 电机工程符号扫描：自动判平台/拓扑/观测器/采样/保护/参数
// 用法: node motor-scan.mjs <工程目录> [--verbose] [--max-samples=N]
// 特点: 自解码（UTF-8/BOM/GBK）+ 剥注释 + 排除厂商库与构建产物，只给代码事实。
import fs from 'node:fs'
import path from 'node:path'

const SRC_EXT = /\.(c|h|cc|cpp|cxx|hpp|s|asm|inc)$/i
const SKIP_DIR = /^(\.git|node_modules|Objects|Listings|DebugConfig|build|Release|\.settings|_ai_plain_tmp|_backup|_mkflash_tmp.*|_tmp.*|_mig_tmp|_push_stage|__Previews|images|assets)$/i
const VENDOR = /(^|[\\/])(LIB|libs|STARTUP|CMSIS|Drivers|driverlib|StdPeriph|arm_math|core_cm|F2800\d+_examples|device_support)([\\/]|$)/i

function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { return new TextDecoder('gbk').decode(buf) }
}

function strip(text) {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i], d = text[i + 1]
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++ }
      i += 2
      continue
    }
    if (c === '"' || c === "'") {
      const q = c; out += c; i++
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue }
        out += text[i]
        if (text[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c; i++
  }
  return out
}

const root = process.argv[2]
if (!root) {
  console.error('usage: node motor-scan.mjs <projectDir> [--verbose]')
  process.exit(2)
}
const verbose = process.argv.includes('--verbose')
const sampleN = Number((process.argv.find((a) => a.startsWith('--max-samples=')) ?? '').split('=')[1] ?? (verbose ? 8 : 3))

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p) }
    else if (SRC_EXT.test(e.name)) files.push(p)
  }
}
walk(root)

const app = files.filter((f) => !VENDOR.test(f))
const includeVendor = process.argv.includes('--include-vendor')
const use = includeVendor ? files : (app.length ? app : files)

// ---------- 平台判定
const PLATFORMS = [
  ['TI C2000 (driverlib)', /EPWM_|ADC_setupSOC|Interrupt_register|CMPSS_|EPWM_setTripZoneAction/],
  ['STM32 (StdPeriph/HAL)', /stm32f\d|HAL_TIM_PWM|TIM_BDTRConfig|GPIO_PinAFConfig|TIM_CtrlPWMOutputs/],
  ['LKS (凌鸥)', /LKS32|SVPWM_Init|MCPWM_/],
  ['PY32 (普冉)', /PY32F\d|py32f/],
]
const platScore = PLATFORMS.map(([n, re]) => [n, 0])

// ---------- 分类
const CATS = [
  ['变换/调制', /FOC_Clarke|Clarke|FOC_Park|Park\(|InvPark|SVPWM|SVM_|sin_table|SIN_TABLE|sine_table/],
  ['观测器/角度', /\bSMO\b|smo_|Sliding|sliding|flux_obs|flux_est|Observer|observer|pll_kp|pll_ki|pll_theta|pll_angle|theta_est|HFI|Inject|Luemberger|Kalman/],
  ['换相/六步', /HALL_NUM|Hall_Calc|HALL_Get|Phase_Step|COMM_TABLE|ZeroCross|zero_cross|BEMF|bemf|ZERO_CROSS/],
  ['PWM/驱动', /EPWM_|TIM_OC\dInit|TIM_BDTR|DeadTime|deadband|DEADBAND|DB_COUNTS|TIM_CtrlPWMOutputs/],
  ['电流采样', /ADC_setupSOC|ADC_ChannelConfig|CHSELR\s*=|SOC_NUMBER|ACQPS|OPAMP|CMPSS|offset_cal|zero_cal/],
  ['环路', /\bKp\b|\bKi\b|\bKd\b|Kp_s|Ki_s|Kp_i|Ki_i|pi_err|PI_S_CALC|PID_I_CALC|current_loop|speed_loop|LADRC/],
  ['保护', /TripZone|TZ_ACTION|TIM_Break|BRK|OCP|OVP|UVP|Fault|FAULT|stall|Stall|Protect_|DESAT/],
  ['参数/辨识', /\bRs\b|\bLd\b|\bLq\b|lambda|flux\b|pole_pairs|POLE_PAIRS|selftune|auto_?tune|Ident|MTPA|field_weak|FW_|weak/],
  ['母线电压采样', /Adc_Vbus|Adc_Vdc|Adc_VBUS|\bVbus\b|\bVBUS\b|\bVdc\b|BusVolt|Get_Vbus/],
  ['无电解电容线索', /ripple|Ripple|feedforward|FeedForward|\bPFC\b|comp_v|beat_freq|notch/],
  ['通信', /Modbus|MODBUS|CAN_|CANBus|Uart|UART_|Comm_send|Comm_recv/],
]
const hits = new Map(CATS.map(([k]) => [k, []]))
const factLines = []

for (const f of use) {
  let code
  try { code = strip(decode(fs.readFileSync(f))) } catch { continue }
  const rel = path.relative(root, f)
  for (let i = 0; i < platScore.length; i++) {
    if (PLATFORMS[i][1].test(code)) platScore[i][1]++
  }
  code.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*#include/.test(line)) return
    for (const [label, re] of CATS) {
      if (re.test(line)) hits.get(label).push(`${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`)
    }
    const t = line.trim()
    if (/SystemCoreClock\s*=\s*|SYSCLK_HZ|CFG_SYSCLK|CPU_FREQ|_SYSCLK\b/.test(t) ||
        /setTimeBasePeriod|TIM_Period\s*=|->ARR\s*=|PERIOD\s*=/.test(t) ||
        /DEADBAND|DeadTime\s*=|DB_COUNTS/.test(t) ||
        /setTimeBasePrescaler|TIM_Prescaler\s*=/.test(t)) {
      factLines.push(`${rel}:${idx + 1}: ${t.slice(0, 110)}`)
    }
  })
}

console.log(`=== 扫描范围 ===`)
console.log(`源文件 ${files.length} 个；实际扫描 ${use.length} 个${includeVendor ? '（--include-vendor：含厂商库）' : `（已排除厂商库 ${files.length - app.length} 个；要看得加 --include-vendor）`}；样本上限 ${sampleN}`)

const plat = platScore.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
console.log(`\n=== 平台判定 ===`)
for (const [n, c] of plat) console.log(`   ${n}：${c} 个文件命中`)
if (!plat.length) console.log('   （未识别到已知平台特征，可能是自研库/裸机寄存器操作）')

console.log(`\n=== 控制拓扑推测（按代码事实） ===`)
const has = (k) => (hits.get(k) ?? []).length
const topo = []
if (has('换相/六步') && !has('变换/调制')) topo.push('六步方波（无 FOC 变换符号）')
if (has('变换/调制')) topo.push('FOC（存在 Clarke/Park/SVPWM 类符号）')
if (/HALL_Get|HALL_NUM|Hall_Calc/.test((hits.get('换相/六步') ?? []).join('\n'))) topo.push('位置来源：霍尔')
if (/ZeroCross|BEMF|zero_cross/.test((hits.get('换相/六步') ?? []).join('\n'))) topo.push('位置来源：反电动势过零（无感）')
if (/SMO|Sliding|Observer|pll_kp/.test((hits.get('观测器/角度') ?? []).join('\n'))) topo.push('无感观测器：SMO/观测器+PLL')
if (/HFI|Inject/.test((hits.get('观测器/角度') ?? []).join('\n'))) topo.push('低速注入（HFI/脉冲）')
if (has('无电解电容线索')) topo.push(`⚠ 检出纹波/前馈/PFC 类符号（${has('无电解电容线索')} 处）→ 很可能是无电解电容方案，按 references/capacitorless.md 的 5 步顺序查`)
else if (has('母线电压采样')) topo.push(`有母线电压采样（${has('母线电压采样')} 处，普通工程常见，不能作为无电解证据）`)
console.log(topo.length ? topo.map((t) => '   • ' + t).join('\n') : '   （拓扑证据不足，需人工看 main/中断）')

console.log(`\n=== 分类命中 ===`)
for (const [label] of CATS) {
  const list = hits.get(label)
  console.log(`-- ${label}：${list.length} 处`)
  for (const s of list.slice(0, sampleN)) console.log(`   ${s}`)
}

console.log(`\n=== 硬事实（时钟/周期/死区/分频） ===`)
for (const f of factLines.slice(0, verbose ? 40 : 20)) console.log(`   ${f}`)
if (!factLines.length) console.log('   （未找到时基/死区赋值）')

console.log(`\n=== 下一步 ===`)
console.log('   1) 看变换/观测器命中文件 → 确认是 FOC 还是六步')
console.log('   2) node <dlp技能>/scripts/read.mjs <文件> 读主中断与环路函数')
console.log('   3) 用 references/schematic-crosscheck.md 的 12 项清单去读原理图并与固件常量对账')
console.log('   4) 无电解电容方案优先看 references/capacitorless.md 的 5 步顺序')
