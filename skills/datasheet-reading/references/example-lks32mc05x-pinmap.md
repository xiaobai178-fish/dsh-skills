# 实例：LKS32MC05x 引脚功能表与 ADC 通道映射（实测还原）

> 来源：`D:\keilDpan\Keil_Packs\Linko\LKS05x\1.1.5\Docs\LKS32MC05x_Datasheet_v1.7.pdf`
> 表 3-2「LKS32MC05x 引脚功能选择」p19~p21

## 1. 页面性质判定（回答"是否图像化"）

| 页 | 词数 | 中文词 | 图片数 | 矢量绘制数 | 判定 |
|---|---|---|---|---|---|
| p19 | 78 | 6 | 0 | **649** | 文本 + 矢量表格线（**非图像**） |
| p20 | 68 | 6 | 0 | 649 | 同上 |
| p21 | 92 | 6 | 0 | 649 | 同上 |

→ 表格是**矢量线条 + 真实文本**，坐标可重建，**不需要视觉/OCR**。

## 2. 还原结果（p19，AF9 列为模拟通道复用列）

| 端口 | AF9（模拟） | 其它复用（示例） |
|---|---|---|
| P0.0 | **ADC_CH4**、DAC_OUT | — |
| P0.1 | — | — |
| P0.2 | — | SPI_DI(DO) |
| P0.3 | **ADC_CH7** | SCL / TIM2_CH0 |
| P0.4 | **ADC_CH13** | SDA / TIM2_CH1 |
| P0.5 | **ADC_CH12** | — |
| P0.6 | — | UART1_TX(RX) / TIM1_CH0 |
| P0.9 | — | OPA1_IP |
| P0.11 | **ADC_CH6** / CMP0_IP1 | HALL_IN0 / SCL / TIM3_CH0 |
| P0.12 | **ADC_CH2** / CMP0_IP2 | — |
| P0.13 | **ADC_CH3** / CMP0_IP3 | — |
| P0.14 | **ADC_CH10** / CMP0_IP4 | — |

（完整 16 行见生成物 `D:\Temp\lks-p19-table.csv`；p20/p21 同法可续）

## 3. 可复现的命令链

```powershell
# ① 判断页面是文本型还是图像型
node scripts/dlp-run.mjs --py scripts/pdf_page_probe.py --in <手册.pdf> -- @in0@ --pages 19-21

# ② 导出带坐标的词表（中文已由 PyMuPDF 还原）
node scripts/pdf-run.mjs <手册.pdf> --pages 19 --words p19.csv

# ③ 词表 → 引脚功能表 + 筛出 ADC 通道
node scripts/pin-table-from-words.mjs p19.csv --match "ADC_CH" --out lks-p19-table.csv
```

## 4. 与 TI 手册的差异（为何 TI 那次失败）

| | LKS32MC05x | TI F2800137 |
|---|---|---|
| 表格实现 | 矢量网格 + 文本，单元格文字独立成词 | 引脚号只印在"组首行"，ADC 行无号 |
| 中文 | PyMuPDF 可还原 | PyMuPDF 可还原（3780 中文词） |
| ADC 映射可提取性 | ✅ 已验证（AF9 列直接写 ADC_CHn） | ⚠ 需"组首行继承"规则或视觉 |

→ 结论：**能否自动还原取决于排版规则，不取决于是否中文**。
