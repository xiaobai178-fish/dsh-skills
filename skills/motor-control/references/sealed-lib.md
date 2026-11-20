# 封库（.lib/.a）与厂商库的可读性分析

## 1. 先判三件事

```powershell
node scripts/lib-scan.mjs <工程目录>                       # 一次给出：库列表、成员、是否 strip、符号、调用关系
node scripts/lib-scan.mjs <目录> --dwarf out.txt            # 未 strip 时导出 DWARF
```

| 判据 | 含义 |
|---|---|
| `armar -t x.lib` 有成员 | 是静态库（AR 归档），成员通常是 `xxx.o` |
| `fromelf -s` 输出含 `.debug_info/.debug_line` | **未 strip**，可恢复函数/参数/局部变量/结构/源文件名 |
| 只有少量符号、无 `.debug_*` | 已 strip → 走 map + 反汇编 |

## 2. 不 strip 的封库能挖到什么（实测）

`南北星`/`深水泵` 工程的 `SOURCE/inc/BLDC.lib`（9.3 KB，成员 `bldc.o`）：

- 源文件名：`..\SOURCE\src\BLDC.c`
- 可执行节符号：`i.HALL_Get`（498 字节）
- DWARF 名字 30 个，例如：`HALL_Get`、`Detect_Cur`、`_fwdres`、`_newold`、`ipd_hall`、`_Fwdres`、`De_CurCur_A/B/C`、`De_DiffCur_AA/BB/CC`、`AA_13`、`BB_13`
- 类型：`unsigned char`、`unsigned short`、`short`

→ **封库不等于黑盒**：参数名、局部变量名、结构成员都能恢复，再配合 `.h` 就能还原接口语义。

## 3. 变量分析四步法

```powershell
# ① 从 map 拿地址/大小/归属（Keil：USER\Listings\xxx.map）
Select-String -Path xxx.map -Pattern 'HALL_Get' -Context 1,1

# ② 从 DWARF 拿名字与类型
node scripts/lib-scan.mjs <目录> --dwarf out.txt
Select-String -Path out.txt -Pattern 'DW_AT_name ipd_hall' -Context 3,3
Select-String -Path out.txt -Pattern 'DW_TAG_structure_type|DW_TAG_member' -Context 0,2

# ③ 反汇编看常量/状态机/查表
& 'D:\Keil_v5\ARM\ARMCC\Bin\fromelf.exe' --text -c .\SOURCE\inc\BLDC.lib -o dis.txt
Select-String -Path dis.txt -Pattern 'MOVS|CMP|B\s' | Select-Object -First 40

# ④ 运行时观察：按 map 的地址在调试器里 watch，或读 RAM 快照
```

## 4. 从 map 看"谁在用它"（省掉猜接口）

Keil map 的 `Section Cross References` 段形如：

```
ctrlloop.o(i.HLL_PO) refers to bldc.o(i.HALL_Get) for HALL_Get
```

即：`HLL_PO` 函数调用了封库里的 `HALL_Get`。把某个封库成员的所有引用抓出来，就知道它的调用上下文、被调频率（打断点看）、参数从哪来。

## 5. 已 strip 的库怎么办

1. 符号表（`fromelf -s`）通常仍给出导出函数名与大小 → 至少知道 API 边界。
2. `.map` 给出地址与大小 → 反汇编定位边界。
3. 反汇编 + 常量特征（阈值、查表、PID 系数）可反推行为。
4. 若库导出变量，可在调试器中按 map 地址 watch；内部静态变量不可见，只能靠反汇编推断栈/寄存器布局。

## 6. 与开源库对照（快速理解封库行为）

- 六步换相/霍尔：对照 SimpleFOC 的 `BLDCMotor` 或 VESC 的 `mc_interface.c`。
- FOC 观测器：对照 VESC `mcpwm_foc.c`、ODrive `foc.cpp`。
- 把封库反汇编里的常量（如换相表 6 项、PID 初值）与开源实现对照，往往能直接对上。
