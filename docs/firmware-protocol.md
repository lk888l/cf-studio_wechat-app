# WL1 固件协议审计

审计日期：2026-09-08。本说明来自只读检查本地仓库 `C:\kk_data\code\stm32\wheeled-legged_Robot-WL1` 的 Git 对象；未切换分支、未修改或烧录固件。

## 版本基线

| 引用                   | 审计时提交                                 | 结论                                                                   |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| 本地 `main`            | `43d35a30ce69484af1e455d2df69d15929f3adbc` | 当前小程序兼容的旧主分支基线                                           |
| 本地缓存 `origin/main` | `9b58e9e2c5841b2cead52b57b195567b3c94cd3d` | 比本地 main 多一个提交；R 协议相同，增加平衡启动门控及遥控器 UART 桥接 |
| `feature/SoftEngine`   | `72c0dd92bda1845b18797e0b879cd059f41dfe4d` | 未来目标；R 协议相同，解析、运行状态和任务架构不同                     |

这里的 `origin/main` 是本地已缓存引用，不代表审计时重新拉取了远端，也不能据此判断车上实际烧录的提交。小程序不自动推断或切换固件版本。两个 main 版本都支持下述基本遥控帧。

## 车端接线和传输

蓝牙串口模块连接的是 **car_firmware 的 USART1**，直接发送 `R` 命令即可，无需 `nrfsend` 包装。

| 项目     | 固件设置                               |
| -------- | -------------------------------------- |
| 波特率   | 115200                                 |
| 数据格式 | 8 数据位、无校验、1 停止位、无硬件流控 |
| MCU RX   | PA10，接模块 TX                        |
| MCU TX   | PA15，接模块 RX                        |
| 接收     | DMA receive-to-idle，128 字节缓冲      |
| 命令容器 | 32 字节，队列深度 4                    |

串口设置来源：[usart.c 第 46–53、77–85 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Core/Src/usart.c#L46)。模块 UART 的波特率必须匹配固件；小程序不通过业务串口发送模块 AT 配置命令。

**接收边界依赖 UART 空闲事件，而不是换行。** 每个接收块作为一条完整命令入队；车端没有跨接收块的文本重组，也不按 LF 拆分同一块里的多条命令。旧主分支把超长块截取为前 32 字节，UART 入队也未先检查队列是否满。必须发送短帧，逐条串行发送，避免积压和突发。来源：[main.cpp 第 313–364 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/UserApp/main.cpp#L313)、[LkUart.hpp 第 188–211 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/Peripheral/LkUart.hpp#L188)。

蓝牙模块须将一条写入作为连续 UART 字节输出。单次 BLE 写入本身不是对模块 UART 行为的证明，首次硬件验证必须确认模块不会把一条命令拆成多个带空闲间隔的串口块。通用的“每 20 字节切一片”不适用于此旧固件。

## 遥控帧

```text
R <turn> <velocity> <roll> <height>
```

ASCII，命令名大小写敏感，字段之间使用**单个 ASCII 空格**。本项目的紧凑遥控帧不附加 LF、CRLF 或 NUL。原遥控器的 nRF 无线 payload 才需要补 NUL 到 32 字节；直接 UART 无需补齐。

| 字段     | 含义                           | 小程序采用的边界 | 编码                         |
| -------- | ------------------------------ | ---------------- | ---------------------------- |
| turn     | 左轮 RPM − 右轮 RPM 的目标差值 | −100…100         | 整数                         |
| velocity | 两轮平均 RPM 目标              | −100…100         | 整数；取 UI 前后速度的相反数 |
| roll     | 横滚目标，度                   | −18…18           | 整数                         |
| height   | 共同腿高目标，mm               | 44.5…78.5        | 一位小数                     |

这些速度、转向、横滚边界来自已存在的实体遥控器限幅，并非主分支车端对输入的校验。小程序必须自行拒绝非有限数、限幅和量化。腿高在车端最终会受到物理目标限幅。UI 的正速度编码为负 `velocity`，与实体遥控器一致；实际前进/左右转方向还应结合车轮安装进行架空验证。

实现来源：[R 处理器，第 296–304 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/UserApp/main.cpp#L296)、[遥控器限制，第 3–11 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/tele_firmware/Component/UserApp/RemoteControlState.hpp#L3)、[遥控器编码，第 10–17 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/tele_firmware/Component/UserApp/RemoteCommandCodec.cpp#L10)。

示例（代码块中的显示换行不属于发送数据）：

```text
R 0 0 0 44.5
R 0 -30 0 61.5
R -100 -100 -18 78.5
```

最后一帧为最坏符号/位数组合，恰好 **20 字节**；采用上述范围和量化后可以完整放入单次默认 20 字节 BLE 特征值写入。原实体遥控器把所有值保留一位小数，其最坏帧为 26 字节，不能在本项目中直接套用并分片。

旧主分支解析器实际上没有跳过数字参数前的额外空格；固件文档所写“一个或多个空格”比实现宽松。它也没有检查数值 token 是否全部消费，因此不能依赖车端拒绝后缀垃圾。规范编码只产生单空格和正常有限数。来源：[TaskReactor.hpp 第 120–164 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/Module/Basic/TaskReactor.hpp#L120)。

实体遥控器周期为 50 ms（20 Hz）。应用可采用有界周期调度，合并尚未发送的摇杆状态，优先归零，确保不会因 BLE 写入变慢而重放历史运动指令。该频率是实体遥控器的基线，并非车端要求的保活频率。来源：[tele main.cpp 第 23–28 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/tele_firmware/Component/UserApp/main.cpp#L23)。

## 归零、仲裁与执行确认

- `R 0 0 0 <当前高度>` 表示速度、转向、横滚归零并保持腿高；平衡控制继续运行。这是“运动归零”，不是硬件急停或断电。
- `VandD 0 0` 只归零速度/转向。没有 `stop`、`estop`、`arm`、`disarm`、跳跃或模式切换命令。
- `motor 0 0` 在当前实际 PID 控制路径中不会接管电机：命令只打印并发送无人消费的通知，不能用作停机。
- 主分支没有通信失联看门狗；没有任何命令接收时间戳用于目标超时。蓝牙断开或手机被系统终止后，最后目标可能一直保留。小程序的松手、取消触摸、隐藏、卸载和主动断开归零只能在链路仍可写时生效；硬件层面的失联停止需要 MCU 或桥接器新增看门狗。
- UART 与 nRF 使用同一命令队列和同一组目标，没有控制权租约或源优先级；最后处理的帧覆盖先前目标。手机控制时应停止实体遥控器发送，以免互相覆盖。
- `R` 成功不返回 ACK、序号或目标状态。蓝牙写入成功只能显示“已发送”；不得显示“机器人已执行”“硬件已停止”。未收到数据也不等于命令失败。

依据：[目标赋值和共同队列，第 289–365 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/UserApp/main.cpp#L289)、[被注释的 motor 通知消费，第 514–518 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/UserApp/main.cpp#L514)，以及两个 main 提交完整命令表及 MotionControl 循环审计。

`origin/main` 的较新提交增加了平衡启动门控：姿态与传感器正常、目标速度和转向绝对值 <1、姿态稳定 50 个 10 ms 样本后允许电机输出；俯仰或横滚超过 30°、传感器异常会取消使能。本地较旧 `main` 没有这个门控。门控不会在断连后归零目标，也不能通过现有串口命令可靠查询。来源：[BalanceStartupGate.hpp](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/Component/UserApp/CtrlAlgorithm/BalanceStartupGate.hpp#L10)。

## 其他主分支命令与回包

| 命令                                              | 作用/回包                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `VandD <difference> <velocity>`                   | 更新两个运动目标，无成功回包                                                           |
| `target_roll <degrees>`                           | 更新横滚目标，无成功回包                                                               |
| `legheight <mm>`                                  | 更新腿高并打印 `Servo angel: <angle> <x> <bias>`；诊断计算先于限幅                     |
| `showimu -y` / `showimu -n`                       | 开关约 100 Hz `Roll,Pitch,Yaw` 文本输出                                                |
| `showrpm -y` / `showrpm -n`                       | 开关约 20 Hz `A: <left RPM>\tB: <right RPM>` 文本输出                                  |
| `anglebias <degrees>`                             | 旧 main 仅短暂改变实时偏置；较新 origin/main 设置最低腿高的 RAM 校准基准，重启恢复默认 |
| `anglepid/velocitypid/differpid -p/-i/-d <value>` | RAM 调参；angle Kp 被控制环按腿高重算                                                  |
| `rollpid -p/-i <value>`                           | 主分支两个选项都误写 Ki，不应作为普通遥控功能暴露                                      |
| 未知命令                                          | `receive: <原文本>`，不是成功确认                                                      |

无电量、测距、机器人类型识别、协议版本查询或控制目标 ACK。首次遥控应保持高频诊断关闭；不把启动日志或 nRF 发送成功日志解释为某条 `R` 已执行。完整表见对应提交的 [commands.md](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/9b58e9e2c5841b2cead52b57b195567b3c94cd3d/car_firmware/docs/commands.md)。

## 未来 feature/SoftEngine

基本 `R` 字段顺序、单位、串口设置保持兼容，因此紧凑 20 字节帧也可复用。该分支当前主要差异：

1. `CommandServiceTask` 替代 main.cpp 中命令表；参数通过快照一次发布，拒绝部分更新、非有限数、尾随垃圾和多余参数；支持空格、TAB、CRLF。
2. 接收仍按 idle 块处理，没有为旧协议增加跨块拼接；长度 >32 整帧拒绝，队列满打印拒绝原因。
3. 新增 `ping`、`status`、`button` 诊断；`ping` 返回 `pong state=... control=...`，`status` 返回状态及硬件/任务失败位图。这些只适用于明确选择的 SoftEngine 设备档案，不能假定主分支支持。
4. `rollpid -p` 已正确写 Kp；`anglebias` 是 RAM 中的最低腿高基准，当前默认 9.5°；主分支的新提交默认 12.6°。
5. `motor` 明确返回 `motor rejected: raw PWM is unavailable in PID control mode`。
6. 运行时故障和 IMU 读取错误能关闭输出，但仍没有通信目标超时、控制源仲裁或串口急停命令。不能把“SoftEngine”档案标记为具备已验证失联停止能力。

来源：[CommandServiceTask.cpp 第 73–198 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/72c0dd92bda1845b18797e0b879cd059f41dfe4d/car_firmware/Component/UserApp/Tasks/CommandServiceTask.cpp#L73)、[TextCommandParser.hpp](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/72c0dd92bda1845b18797e0b879cd059f41dfe4d/car_firmware/Component/Module/Basic/TextCommandParser.hpp#L41)、[MotionControlTask.cpp 第 35–53 行](https://github.com/lk888l/wheeled-legged_Robot-WL1/blob/72c0dd92bda1845b18797e0b879cd059f41dfe4d/car_firmware/Component/UserApp/Tasks/MotionControlTask.cpp#L35)。

主分支 tele_firmware 新增的 UART-to-nRF 桥接与车端 UART 是两个独立入口；本项目连接车上的模块，不复用遥控器的 `joystick on/off`、`nrfsend` 包装或桥接 ACK 语义。未来换到 SoftEngine 后，应单独执行该档案的板上协议验收再启用新增诊断能力。
