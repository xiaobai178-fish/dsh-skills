# DSH 技能包（Skills for DeepSeek Harness）

包含 3 个技能，复制到 `~/.dsh/skills/` 即可被 DSH 自动加载（新会话生效）：

| 技能 | 作用 |
|---|---|
| `prd-first-protocol` | 项目启动协议：文档先行、存疑清单、开工许可、留痕、质疑澄清 |
| `motor-control` | 电机电控：拓扑判定、环路参数、采样保护、变量溯源、封库分析 |
| `datasheet-reading` | 数据手册/原理图/PCB/网表 → 引脚与通道事实表，并与固件交叉验证 |

## 安装

```bash
# Linux / macOS
cp -r skills/* ~/.dsh/skills/

# Windows (PowerShell)
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.dsh\skills\"
```

重启 DSH 会话后，技能目录会出现在可用技能列表里。

## 依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| Node.js ≥ 18 | 绝大部分脚本 | 官方安装包 |
| Python 3 + PyMuPDF | `datasheet-reading/scripts/pdf-run.mjs`（PDF 中文抽取） | `pip install pymupdf` |
| PowerShell（Windows） | DLP 明文桥（`dlp-run.mjs` / `pdf-run.mjs` 的落盘环节） | 系统自带 |

> `dlp-encrypted-source` 技能未包含在本仓库：它依赖本机 DLP 透明加密与特定白名单进程（node/rg/armcc），在其他机器上不适用。

## 平台说明

- **跨平台**：`motor-control` 全部脚本、`datasheet-reading` 中的 `netlist-parse.mjs`、`schdoc-extract.mjs`、`sch-pinmap.mjs`、`pin-table-from-words.mjs`、`dv-crossvalidate.mjs`、`odb-*.mjs`、`eda-scan.mjs`。
- **仅 Windows**：`pdf-run.mjs`、`dlp-run.mjs`（用 `powershell.exe` 做明文落盘桥）；在其他系统上需改为直接读文件后调用 Python。
- 数据手册/原理图多为 GBK 或加密文件时，脚本已内置 GBK 解码；加密文件需先解密为普通 PDF/文本。

## 快速上手

```bash
# 1) 盘点一个硬件工程
node skills/datasheet-reading/scripts/eda-scan.mjs <工程目录>

# 2) 中文数据手册抽引脚表
node skills/datasheet-reading/scripts/pdf-run.mjs 手册.pdf --find "引脚功能选择"
node skills/datasheet-reading/scripts/pdf-run.mjs 手册.pdf --pages 92-94 --words p.csv
node skills/datasheet-reading/scripts/pin-table-from-words.mjs p.csv --match ADC_CH --out ds.csv

# 3) 四方交叉验证（手册 × 原理图符号 × 网表 × 固件）
node skills/datasheet-reading/scripts/sch-pinmap.mjs board.SchDoc --out sch.csv
node skills/datasheet-reading/scripts/netlist-parse.mjs board.NET --ref U1
node skills/datasheet-reading/scripts/dv-crossvalidate.mjs --ds ds.csv --sch sch.csv --netlist board.NET --mcu U1 --fw <固件目录>

# 4) 电机工程扫描
node skills/motor-control/scripts/motor-scan.mjs <工程目录>
node skills/motor-control/scripts/var-trace.mjs <工程目录> <变量名> --map x.map
```

## 已知限制

- `motor-scan` 会把字库（如 u8g2 字体数组）里的 `HFI` 等字样误判为算法符号，扫描大工程需人工剔除。
- 数据手册的“引脚分布表”若为左右双栏/合并单元格，按行聚合会漏行，需按 x 区间拆分。
- 交叉验证的可信度评分只反映“独立来源数量”，不代表实测正确性。
