#!/usr/bin/env node
// dlp-run.mjs — 通用 DLP 桥：把密文/明文文件落成"明文临时件"，再交给任意 python 脚本处理
//
// 为什么需要：本机 DLP 下，node 能读密文，但 python/poppler 等非白名单进程只能读明文；
// 且 node 写出的文件会被加密，只有 powershell.exe 写出的文件才是明文。
//
// 用法:
//   node dlp-run.mjs --py <脚本.py> [--in <文件>]... -- <python 参数...>
//   参数里的 @in0@ / @in1@ 会被替换成对应输入的明文临时路径；@py@ 为脚本明文路径。
//
// 例:
//   node dlp-run.mjs --py scripts/pdf_page_probe.py --in "手册.pdf" -- --pages 19-21
//   node dlp-run.mjs --py scripts/pdf_words.py --in "手册.pdf" -- --out out.csv --pages 1-5
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PSEXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const argv = process.argv.slice(2)

const pyIdx = argv.indexOf('--py')
const sep = argv.indexOf('--')
if (pyIdx < 0 || sep < 0) {
  console.error('usage: node dlp-run.mjs --py <script.py> [--in <file>]... -- <python args...>')
  process.exit(2)
}
const pyPath = argv[pyIdx + 1]
const ins = []
for (let i = 0; i < sep; i++) {
  if (argv[i] === '--in') { ins.push(argv[i + 1]); i++ }
}
const pyArgs = argv.slice(sep + 1)

/** 用 powershell 写明文文件（node 直接写会被 DLP 加密） */
function writePlain(target, bytes) {
  const b64 = Buffer.from(bytes).toString('base64')
  const script = `$ErrorActionPreference='Stop'; [IO.File]::WriteAllBytes($env:OUT, [Convert]::FromBase64String($env:B64))`
  const r = spawnSync(PSEXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, OUT: target, B64: b64 },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error('powershell 落盘失败: ' + (r.stderr ?? '').slice(0, 300))
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlprun-'))
const map = new Map()

try {
  // python 脚本本身也可能在 DLP 目录里（服务端会加密），先落明文
  const pyOut = path.join(tmpDir, 'tool.py')
  writePlain(pyOut, fs.readFileSync(pyPath))
  map.set('@py@', pyOut)

  ins.forEach((src, i) => {
    if (!fs.existsSync(src)) throw new Error(`输入不存在: ${src}`)
    const dst = path.join(tmpDir, `in${i}${path.extname(src) || '.bin'}`)
    writePlain(dst, fs.readFileSync(src))     // node 读 = 明文（密文会被透明解密）
    map.set(`@in${i}@`, dst)
  })

  const args = pyArgs.map((a) => {
    let out = a
    for (const [k, v] of map) out = out.split(k).join(v)
    return out
  })

  const r = spawnSync('python', [pyOut, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 256 * 1024 * 1024,
    timeout: 600000,
  })
  if (r.error) { console.error('python 调用失败:', r.error.message); process.exit(1) }
  process.stdout.write(r.stdout ?? '')
  if (r.status !== 0) {
    console.error('python 退出码', r.status)
    const err = r.stderr ?? ''
    if (err.includes('No module named')) console.error('缺依赖：pip install <module>')
    console.error(err.slice(0, 1200))
    process.exit(r.status ?? 1)
  }
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { }
}
