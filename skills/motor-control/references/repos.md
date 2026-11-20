# 高星开源参考（星标数 2026-11-20 用 GitHub API 核实）

| 仓库 | ★ | 语言 | 该看什么 |
|---|---|---|---|
| [odriverobotics/ODrive](https://github.com/odriverobotics/ODrive) | 3858 | C++ | `Firmware/MotorControl/`：FOC 主循环、编码器/霍尔、电流环、制动斩波；`foc.cpp` 与 `controller.cpp` 是范本 |
| [vedderb/bldc](https://github.com/vedderb/bldc) | 3583 | C | `motor/`：无感观测器（flux observer）、`mc_interface.c`、`mcpwm_foc.c`；实战级参数辨识与故障处理 |
| [simplefoc/Arduino-FOC](https://github.com/simplefoc/Arduino-FOC) | 3118 | C++ | `src/common/`：Clarke/Park/SVPWM 实现、`BLDCMotor`、`sensors/`；入门到产线过渡最好的教科书式代码 |
| [EFeru/hoverboard-firmware-hack-FOC](https://github.com/EFeru/hoverboard-firmware-hack-FOC) | 1852 | C | 双电机 FOC 在低端 MCU 上的实现，定点/查表技巧多，适合低成本参考 |
| [mjbots/moteus](https://github.com/mjbots/moteus) | 1392 | C++ | `fw/`：高带宽 FOC、DRV8323 驱动、无感/有感切换、故障语义清晰 |
| [Sguan-ZhouQing/SguanFOC_Library](https://github.com/Sguan-ZhouQing/SguanFOC_Library) | 1171 | C | 有/无感 PMSM FOC 库，含 SVPWM 多模式、位置/速度/电流多环、LADRC；中文注释多，适合对照 |
| [lucysrausch/hoverboard-firmware-hack](https://github.com/lucysrausch/hoverboard-firmware-hack) | 875 | C | 该系列前身，可对比 FOC 版改动 |
| [Aalto-Electric-Drives/motulator](https://github.com/Aalto-Electric-Drives/motulator) | 267 | Python | 电机+并网变换器仿真，验证观测器/无电解电容控制算法时可用于对照仿真 |

## 按主题挑仓库

| 主题 | 首选 |
|---|---|
| 无感 FOC 观测器（SMO/磁链） | VESC、moteus、ODrive |
| 低成本 MCU 定点 FOC | hoverboard-FOC、SimpleFOC |
| 代码可读性与算法教学 | SimpleFOC、SguanFOC |
| 量产级故障与保护设计 | VESC、moteus |
| 无电解电容/PFC-like | 开源实现少（多为厂商方案），优先用 motulator 做仿真验证，再看 TI/ST 的 PFC 应用笔记 |

## 学习路径建议（按你的项目）

1. **先看 SimpleFOC** 的 `Clarke/Park/SVPWM` 三个函数，建立"最小可用 FOC"心智模型。
2. **再看 VESC 的 `mcpwm_foc.c`**，理解观测器、参数辨识、故障恢复在真实代码里怎么长。
3. **最后看 moteus/ODrive** 的电机控制层，学习工程分层（驱动层/控制层/通信层）与单元测试。
4. 把其中的公式与你自己工程（F2800137）的 `foc_core.c` 逐项对照，差异就是你的改进点清单。

## 注意

- 以上星标为 2026-11-20 通过 `api.github.com` 实时查询所得；数字会变，用前可复核。
- 这些仓库只作**算法与工程结构参考**；直接抄代码要注意许可证（ODrive 为 MIT，VESC 为 GPL-3.0，SimpleFOC 为 MIT，moteus 为 Apache-2.0，hoverboard-FOC 为 MIT）。
- 无电解电容方案的开源实现很少，多数关键点写在 TI/ST/Infineon 应用笔记里；分析用户工程时以代码为准。
