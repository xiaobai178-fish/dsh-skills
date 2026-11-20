# FOC（磁场定向控制）精要 —— 读代码时的对照表

## 1. 变换链（代码里最常见的一段）

```
ia, ib, ic ──Clarke──▶ iα, iβ ──Park(θe)──▶ id, iq ──PI──▶ vd, vq ──InvPark──▶ vα, vβ ──SVPWM──▶ Ta,Tb,Tc
```

| 环节 | 判断要点 |
|---|---|
| Clarke | 等幅变换系数 2/3 还是等功率 √(2/3)；有的工程用 `ic = -(ia+ib)` 省一路采样 |
| Park | `sin/cos` 是查表还是 `sinf/cosf`；表长与插值方式决定精度与耗时 |
| InvPark | 输出 `vα/vβ` 后接 SVPWM 或 SPWM |
| SVPWM | 扇区判断 + 作用时间 + 七段式；也有用"零序注入"等价实现的（`Vmid` 注入法） |

## 2. 电流环（内环）

- 标准 PI：`v_d = Kp*(id_ref - id) + Ki*∫` 再叠加解耦项 `-ωe*Lq*iq`、`+ωe*Ld*id + ωe*λ`（反电动势前馈）。
- 检查：是否有解耦前馈？没有解耦时高速性能差。
- 限幅：输出电压限量到 `Vdc/√3`（SVPWM 线性区）或含过调制。
- 抗积分饱和：看是否有 `clamp`/`anti-windup`。
- 带宽取 PWM 的 1/10~1/20；PI 零点常设 `Ki/Kp = Rs/Ls`。

## 3. 速度环（外环）

- 输出是 `iq_ref`（转矩电流），限幅 = 最大转矩电流。
- 采样周期通常比电流环慢（1 ms 级）；注意是否有低通滤波与加速度前馈。
- 低速时用观测器角度，高速时可能有角度补偿（观测器延迟补偿 `θ + ωe*T_delay`）。

## 4. 无感观测器（核心差异点）

| 类型 | 代码特征 | 适用 | 注意 |
|---|---|---|---|
| SMO 滑模 | `SMO`/`smo_gain`/`sign()`/饱和函数 | 中高速 | 抖振；增益随 λ、|ω| 缩放；需低通+角度补偿 |
| 龙伯格/全维观测器 | 状态矩阵、`K1/K2` 增益 | 中高速 | 依赖 Rs/Ls/λ 精度 |
| 磁链观测 | `flux_alpha/beta`、积分器 | 中高速 | 积分漂移需高通/补偿 |
| PLL 锁相 | `pll_kp/pll_ki`、`err = -eα*cos + eβ*sin` | 角度提取 | 带宽要低于电流环 |
| HFI 高频注入 | `inject`/`hf`/`demod` | 零低速 | 噪声、需要凸极（Ld≠Lq） |
| I/f 或 V/f 开环 | 斜坡角度、`openloop` | 启动/兜底 | 切换点要平滑 |

**读代码时要找的三件事**：用哪个观测器 → 增益怎么给（常量/自整定）→ 切换逻辑（开环↔闭环判定条件）。

## 5. 参数辨识与自整定（多数量产工程都有）

- `Rs`：注入直流/双脉冲测压降。
- `Ld/Lq`：脉冲电压法或高频注入拟合。
- `λ`（磁链）：反电动势常数，开环拖动测 `V/f` 或观测器反算。
- 惯量/摩擦：速度阶跃响应拟合。
- 代码里常见 `selftune`/`auto`/`ident`/`R_est`/`L_est` 命名。

## 6. MTPA / 弱磁

- MTPA：`id = f(iq)`（表贴式近似 `id=0`；内嵌式用公式或查表）。
- 弱磁：`id < 0`，受电压/电流圆约束；看是否有 `field_weakening`、`fw`、`vlim`。
- 过调制区处理：电压饱和后的角度前馈/电压限幅。

## 7. 死区与逆变器非线性

- 死区补偿：按电流方向补偿 `Td`；代码里 `deadtime_comp`、`sign(ia)*Td`。
- 死区时间换算：`counts = t_ns × SysClk / 1e9`（C2000 常见 `CFG_DEADBAND_NS`）。
- 最小脉宽限制：`min_pulse`/`narrow_pulse` 处理，避免窄脉冲丢失。

## 8. 与你工程（TI F2800137）的对应关系

| 概念 | 你工程中的实现（示例） |
|---|---|
| 变换 | `FOC_Clarke` / `FOC_Park` / `FOC_InvPark`（foc_core.c） |
| SMO | `CFG_OBS_SMO_GAIN`、`smo_gain`、`s_obs_omega` |
| 角度 | `pll_kp` / `pll_ki` |
| 死区 | `CFG_DEADBAND_NS`（2500 ns）+ `BOARD_DB_COUNTS` |
| PWM | `EPWM1/2/3_BASE`、`EPWM_setTimeBasePeriod` |
| 采样 | `ADC_setupSOC(ADC_SOC_NUMBER0, ADC_TRIGGER_SW_ONLY/EPWM_SOC)` |
| 保护 | `EPWM_setTripZoneAction(..., EPWM_TZ_ACTION_HIGH_Z)` |
| 自整定 | `foc_auto.c` / `selftune.c`（Auto_smoGainMax 等） |
