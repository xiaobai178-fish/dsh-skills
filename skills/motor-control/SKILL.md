---
name: motor-control
description: 电机电控（无感 BLDC、FOC、无电解电容、MCU/DSP 双平台）的工程分析与读图技能树。给出「先看什么、怎么从代码推出控制拓扑与参数、怎么和原理图对账」的固定流程，并自带电机符号扫描脚本。当用户要分析/修改/优化一个电机控制固件工程，或要读电机驱动板原理图并与固件对账时使用（可与其他技能叠加）。
whenToUse: 要读懂或改动 BLDC/PMSM 驱动固件（无感六步、FOC、有感/无感、单/双/三电阻采样、无电解电容方案）；要判断某工程的换相方式、观测器类型、环路结构、采样时序、死区与保护；要把原理图/网表与固件的引脚、通道、阈值逐项对账；要评估 STM32 / LKS / PY32 / TI C2000 平台上的实现差异。
---

# 电机电控技能树（无感 BLDC / FOC / 无电解电容）

> 本技能只解决"**怎么系统地看懂并改进一个电机驱动工程**"。密文/GBK 的读取用 `dlp-encrypted-source` 技能，原理图/数据手册的解析用 `datasheet-reading`（硬件读图分析技能树），三者常一起用。

## 0. 五步分析法（固定流程，别跳步）

```
① 工程画像   → node scripts/motor-scan.mjs <工程目录>
               （同时可用 dlp-encrypted-source/scripts/overview.mjs 拿编码与模块信息）
①b 有 .lib？ → node scripts/lib-scan.mjs <工程目录>
               （判是否 strip；未 strip 就 --dwarf 导出变量名，再 grep）
② 控制拓扑   → 有感/无感？六步/FOC？看 symbol 段"换相/观测器"命中
②b 追变量   → node scripts/var-trace.mjs <目录> <变量名> --map <map>
               （定义→写→宏写→取地址→读，附 map 地址；宏写必须展开看）
③ 环路与参数 → 电流环/速度环结构、Kp/Ki 来源、限幅、前馈、弱磁、MTPA
④ 采样与保护 → 单/双/三电阻、采样时刻、零漂校准、比较器与 TZ/CBC、欠压过压堵转
⑤ 硬件对账   → 读图取引脚/通道/增益/电阻值/阈值，逐项与固件常量比对（见 references/schematic-crosscheck.md）
```

**输出报告固定结构**：平台与外设 → 换相/控制策略 → 环路与参数 → 采样与标定链 → 保护与故障码 → 硬件对账差异清单 → 可疑点与改进建议。

## 1. 快速判定拓扑（看符号，不看注释）

| 现象（代码特征） | 判定 |
|---|---|
| `HALL_NUM`/`Hall_Calc`/`Phase_Step`/六张换相表 | 有霍尔六步 |
| BEMF/过零比较、`ZERO_CROSS`、`30°`延迟、`commutate` 表 | 无感六步 |
| `Clarke`/`Park`/`InvPark`/`SVPWM`/`sin`+`cos` 查表 | FOC |
| `SMO`/`Sliding`/`Flux`/`Observer`/`PLL`/`Luemberger` | 无感观测器 |
| `Inject`/`HFI`/`pulse`+`inductance` | 低速注入型无感 |
| `EPWM_setTripZoneAction`/`CMPSS`/`BRK`+`comparator` | 硬件过流保护 |
| `ADC_setupSOC`/`ADC_ChannelConfig`+`CHSELR` | 电流/电压采样 |

## 2. 关键换算（这些能直接算，别信注释）

| 量 | 公式 |
|---|---|
| PWM 频率（中心对齐） | `f = SysClk / (2 × ARR × (PSC+1))` |
| 死区时间 | `t_dt = DTG_counts / SysClk`（C2000）或按 RM 的死区公式（STM32 BDTR） |
| 采样电阻→电流 | `I = (ADC − ZERO) / GAIN / R_shunt`（注意运放增益与偏置） |
| 电角度 | `θe = pole_pairs × θm`，`ωe = pole_pairs × ωm` |
| 转速（rpm） | 霍尔周期 T（µs/电周期）→ `rpm = 60e6 / (T × pole_pairs × 6)`（六步） |
| 观测器带宽 | SMO/PLL 的 Kp/Ki 要按 `ωc ≈ 2π×f_bandwidth` 反算，与 PWM/电流环频率匹配 |
| 电流环带宽 | 一般取 PWM 频率的 1/10~1/20；PI 零点常取 `ωi = Rs/Ls` |

## 3. 参考文档索引（按需读，不要一次全读）

| 文件 | 内容 |
|---|---|
| `references/sensorless-bldc.md` | 无感六步：BEMF 过零、启动三段法、换相表、失步/堵转、低速难点 |
| `references/foc.md` | FOC：变换、SVPWM、电流/速度环、观测器（SMO/龙伯格/磁链/HFI）、MTPA、弱磁、参数辨识 |
| `references/capacitorless.md` | 无电解电容：母线纹波与拍频机理、前馈/补偿、启动冲击、采样窗口压缩、控制要点 |
| `references/sensing-and-protection.md` | 单/双/三电阻采样、时序与零漂、比较器/TZ/CBC 保护、退饱和、过温、故障码设计 |
| `references/mcu-vs-dsp.md` | STM32 / LKS32 / PY32 / TI C2000 外设与数值运算对照，移植与定点/浮点要点 |
| `references/schematic-crosscheck.md` | 读图→提取清单→与固件对账的固定方法（与 datasheet-reading 配合） |
| `references/sealed-lib.md` | 封库 `.lib`/`.a` 与厂商库：判 strip、DWARF 取变量、map 看调用、反汇编、已 strip 的对策 |
| `references/repos.md` | 高星开源参考（星标已核实）+ 每个仓库该看哪个文件 |

## 4. 脚本

```powershell
node scripts/motor-scan.mjs <工程目录>                  # 电机域符号扫描：拓扑/观测器/采样/驱动/环路/保护/参数
node scripts/motor-scan.mjs <目录> --verbose            # 每类给更多样本
node scripts/motor-scan.mjs <目录> --include-vendor      # 连 TI/ST 厂商库一起扫（默认排除，避免库里上千处 EPWM_/TIM_ 淹没应用层）
node scripts/lib-scan.mjs <工程目录>                     # 封库/厂商库：列出 .lib、判是否 strip、取符号、解析 .map 调用关系
node scripts/lib-scan.mjs <目录> --dwarf out.txt         # 导出 DWARF，可 grep 出函数名/参数/局部变量/结构体
node scripts/var-trace.mjs <工程目录> <变量名> [--map <map文件>]   # 变量链路：定义→写→宏写→取地址→读，附 map 地址/归属
```

### 什么时候用哪个

| 场景 | 用哪个 |
|---|---|
| 想看应用层怎么写的 | `motor-scan`（默认） |
| 想确认 TI/ST 库里某个外设怎么配的 | `motor-scan --include-vendor` 或直接读库源码 |
| 工程里有 `.lib`/`.a`（封库） | `lib-scan`，必要时加 `--dwarf` |
| 从封库追到谁在调用、传什么参数 | `lib-scan` 的「链接 map」段 + 反汇编 |
| 某个变量的完整链路 | `var-trace`（宏写/取地址会单独标出） |

扫描前请先确认编码/密文（用 `dlp-encrypted-source` 的 `detect.mjs`）：本技能脚本自带 GBK 解码与注释剥离，可独立运行。

## 5. 厂商库与封库（三种形态，对策不同）

| 形态 | 特征 | 能读到什么 | 对策 |
|---|---|---|---|
| ① 开源源码库 | `LIB/`、`driverlib/` 下 .c/.h 齐全（STM32 StdPeriph、TI driverlib） | 全部源码 | 默认**排除**避免噪声；要看用 `--include-vendor` |
| ② 预编译但保留调试信息 | `.lib` 里有 `.debug_info/.debug_line`，`fromelf -s` 能看到 `i.Func` 节符号 | **函数名、参数名、局部变量、结构体、源文件名** | `lib-scan --dwarf` 导出后 grep `DW_AT_name` |
| ③ 已 strip 的封库 / 只有 .h | 符号表只剩少量符号，无 `.debug_*` | 仅导出符号与大小 | 靠 `.map` 找调用关系 + 反汇编看常量/查表 + 头文件语义 |

**封库时怎么分析"已有变量"**（按性价比排序）：

1. **`.map`**：Keil 链接产物里有 `符号名 / 地址 / 大小 / 所属 .o`，还能看到 `xxx.o(...) refers to bldc.o(i.HALL_Get) for HALL_Get` 的调用关系 → 先拿到"有哪些变量、多大、谁在用"。
2. **DWARF（若未 strip）**：`fromelf --text -g <lib> -o out.txt`，grep `DW_AT_name` → 函数/参数/局部变量/结构成员名全出来（本机 `BLDC.lib` 实测可恢复 30 个名字，含 `ipd_hall`、`De_DiffCur_AA`）。
3. **反汇编**：`fromelf --text -c <lib> -o dis.txt` → 看常量阈值、状态机分支、查表数据（如换相表）。
4. **运行时**：从 `.map` 取符号地址，用调试器 watch / 读 RAM；配合 `.map` 的段信息判断变量在 `.data` 还是 `.bss`。
5. **接口语义**：同工程的 `.h`（如 `BLDC.H`）给出原型与结构体定义，与 map/DWARF 交叉印证。

> 实测结论：`南北星`/`深水泵` 工程里的 `BLDC.lib` 属于形态②——**未 strip**，所以封库并不等于黑盒。



## 6. 变量链路溯源（分析的核心动作）

目标：**任何一个变量，都能说清"谁定义、谁写、谁读、什么时刻、地址在哪"**。

```powershell
node scripts/var-trace.mjs <工程目录> <变量名> --map <工程>\USER\Listings\xxx.map
```

输出六段：定义/声明 → 写入 → **宏实参（可能被宏写）** → 取地址 → 结构体成员 → 读取，最后给"链路摘要"和 map 里的地址/大小/所属 .o。

### 判读顺序（拿到输出后必须这么做）

1. **写入点定性**：在中断里写 → 高频；在主循环写 → 低频；在初始化写 → 一次。决定这个变量的"新鲜度"。
2. **宏写要打开宏**：形如 `GET_ADC_IBUS(Adc_IBUS, A, B)` 的宏在宏体内给第一个实参赋值（`X = A - B`），文本层面看起来像"读"。**这是最常见的漏判**。
3. **取地址点**：说明可能被指针/函数改写，需人工进函数看目标。
4. **结构体成员**：`PID.Current` 这类要先看结构体定义（`TypeDef.h`）确认字段语义。
5. **map 地址**：`0x2000_xxxx  Data  2  global.o(.data)` → 可在调试器按地址 watch，确认实际写入频率与数值范围。

### 能力边界（必须对用户说明）

| 能覆盖 | 覆盖不了 / 需人工 |
|---|---|
| 直接赋值、复合赋值、自增自减 | 宏展开后的赋值（只会标"宏实参"，需看宏定义） |
| 全局/静态/extern 声明与定义 | 指针别名（`p = &x` 之后再 `*p = ...`） |
| 结构体成员访问（`.字段`） | 通过 `memcpy`/`memset`/DMA 直接写内存 |
| map 里的地址与调用方 | 编译器优化掉的变量（`-O2` 下可能并入寄存器） |
| 封库内变量（未 strip 时 DWARF 有名字） | 已 strip 封库的内部静态变量 |

> 真正的**语义级**溯源需要 `clangd/ctags` + 编译数据库（`compile_commands.json`）。Keil 工程可用 `.uvprojx` 的 include/define 生成；目前未做，属下一步优化项。



## 7. 常见判断错误（经验）

1. **注释与代码不符**：宏名写 40us/50us 实际都是 20 kHz；参数表注释写 900 转，实际单位可能是 ADC 计数。**只认代码与实测**。
2. **把"有霍尔表"当成有感方案**：不少无感工程也保留霍尔接口做兜底或标定，要看 `HALL_Get` 是否真的参与换相。
3. **忽略电流环实际采样点**：中心对齐 PWM 的谷点/峰点采样对应不同相电流，单电阻方案还与占空比相关，看 `ADC SOC/触发源` 才知道。
4. **把 `CFG_*` 常量当默认值**：很多工程会由自整定（selftune/auto）覆盖，要看运行时写入路径。
5. **无电解电容方案被当成普通 FOC 分析**：纹波前馈、拍频抑制、启动限流往往是这类工程的核心，见 `references/capacitorless.md`。
