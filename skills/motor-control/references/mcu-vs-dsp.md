# MCU 与 DSP 平台对照（STM32 / LKS / PY32 / TI C2000）

## 1. 外设映射表

| 功能 | STM32（F0/F1/F4/G4） | TI C2000（F2800137 等） | LKS32 | PY32 |
|---|---|---|---|---|
| 三相 PWM | `TIM1` CH1/2/3 + N 通道，`BDTR` 死区 | `EPWM1/2/3`，`EPWM_setDeadBandDelay`、`EPWM_setTimeBasePeriod` | 专用 PWM 模块（寄存器） | `TIM1` 类似 STM32 |
| 采样触发 | `ADC` 注入组 + `TIM` 触发（`ADC_ExternalTrigInjectedConv`） | `ADC_setupSOC(ch, trigger=EPWM_SOCx)` | ADC + PWM 联动 | ADC + TIM 触发 |
| 硬件过流 | `BRK` 输入（`TIM_Break_Enable`） | `EPWM_setTripZoneAction` + `CMPSS` 比较器 | 比较器 + 封波 | 比较器 |
| 死区单位 | `BDTR.DTG` 查表编码（ns 级） | `EPWM_setDeadBandDelay`（计数） | 计数 | 计数 |
| 运放/比较器 | 部分型号有 OPAMP/COMP | `CMPSS`（含 DAC 阈值） | 有 | 部分有 |
| 数学加速 | 无（G4 有 CORDIC/FMAC） | `CLA` 协处理器、浮点单元、TMU | 定点 | 定点 |
| 典型主频 | F0: 48 MHz；F1: 72 MHz；F4: 168/180 MHz；G4: 170 MHz | F2800137: 120 MHz | 48~96 MHz | 24~48 MHz |

## 2. 数值运算差异（最影响读码）

| 项 | MCU（多为定点） | C2000 DSP |
|---|---|---|
| 数据类型 | `int16`/`int32`、`q15`/`q1.15`、少用 float | `float32` 常用，CLA 也支持 |
| 三角函数 | 查表 + 插值（`sin_table[]`、`SIN_TABLE_SIZE`） | `sinf/cosf` 或 TMU 加速 |
| 电流环周期 | 容易被运算量限制（10~20 kHz 吃力） | 通常可取 PWM 频率（20 kHz+） |
| 溢出处理 | 定点必须自己限幅，看 `clamp`/`sat` | 浮点相对宽松，仍需限幅 |

## 3. 移植时最容易错的点

1. **死区单位**：STM32 是 DTG 编码（见 RM 表），C2000/LKS 是计数 → 同一 `2 µs` 换算出的寄存器值完全不同。
2. **ADC 触发源**：STM32 注入组与规则组触发不同；C2000 用 SOC + 触发源枚举，采样点位置靠 `EPWM` 计数器比较。
3. **PWM 计数方向**：中心对齐 vs 增减计数对采样点与占空比写入时机的影响。
4. **中断优先级**：电流环中断必须高于通信；看 `NVIC`/`PIE` 配置。
5. **定点 Q 格式**：`q15` 乘法后移位量、饱和处理，移植到浮点时要重算 PI 参数（否则量纲全错）。

## 4. 工程识别小技巧

| 看到 | 说明 |
|---|---|
| `#include "driverlib.h"`、`EPWM_`、`ADC_setupSOC`、`Interrupt_register` | TI C2000 |
| `stm32f0xx.h`、`HAL_TIM_PWM_Start`、`TIM_BDTRConfig` | STM32 |
| `LKS32MC0xx`、`SVPWM` 带中文字段的寄存器宏 | LKS（凌鸥） |
| `PY32F0xx.h`、`HAL_` 前缀 | 普冉 PY32 |

## 5. 选型建议（针对你的场景）

- **无感 FOC + 高转速/高带宽**：C2000（浮点 + CLA + CMPSS 硬件保护）优势明显，你现有 F2800137 工程即属此类。
- **低成本水泵/风机（六步或简易 FOC）**：STM32F0/G0、PY32、LKS32 够用，代价是定点运算与查表。
- **无电解电容 + 高动态**：优先浮点 + 高 PWM 频率（≥16 kHz 避开噪声，且采样窗口更宽裕）。
