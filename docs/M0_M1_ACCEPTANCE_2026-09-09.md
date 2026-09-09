# M0/M1 验收记录与正式客户端运行步骤

日期：2026-09-09。当前安装的 Codex 为 `26.903.8094.0`，已不同于 2026-09-08 隔离 GUI 记录中的 `26.901.6511.0`。旧版本的实测保留为历史证据，不替代这次正式启动路径的验收。

## 本轮执行范围

本轮按用户要求开始 M0/M1 验收。原版 Codex 正在运行并承载本次验收任务，因此先验证已有实例冲突拒绝、只读诊断及自动化回归，并准备可从独立 Windows 控制台运行的正式入口。没有关闭、重启或附着原版实例，也没有把隔离 Dev/WebSocket 启动当作 production launch。

实测基线为源码 `0802046` 的已留证 release：

- `doctor --json` 与 `status --json` 均退出 0，runtime 为 `not_running`；安装包版本为 `26.903.8094.0`。
- `launch` 和 `launch --watch` 均以实例冲突退出 1；没有启动新的 Codlet Host 或 Codex。
- `%LOCALAPPDATA%\Codlet\config.json` 前后均不存在；原 Desktop PID 36924 和 backend PID 63656 的创建时间保持不变。
- 原版实例存在时拒绝启动，是本项预期结果，不是一次成功的扩展会话验收。

证据位于 `.codlet-artifacts/m0-m1-acceptance-2026-09-09/` 的 `conflict-and-doctor.json`、`doctor.json`、`status.json`、`launch-conflict.txt` 和 `watch-conflict.txt`。

## 验收发现的控制管道问题

首轮 Rust 回归在“提交成功但客户端未接收响应”的用例中失败。后续用真实 named pipe 和同步屏障稳定复现：服务端收到 response ACK 后合法断开管道，客户端随后再次调用管道身份查询，得到 Win32 error 233，将有效结果误判为 `UntrustedServer`。

修复保留发送请求前和接收响应后的完整身份检查；ACK 发出后，仅观察已持有的同一 Host process handle，允许服务端正常断开连接。没有扩大超时、重新提交操作或放宽 scope/image/PID 校验。新的确定性回归与既有控制管道测试共同验证该行为。

最终验证：Rust 308 项通过、0 项失败，1 项显式生产启动测试保留 ignored；Node 63 项通过；M0/M1 正常 harness 与 crash harness 的 PowerShell 夹具通过；Clippy（all targets/features，`-D warnings`）、fmt 和 release 构建通过。控制修复提交为 `0e87b0b`，验收脚本提交为 `6887249`；release 构建耗时 13.44 秒，SHA-256 为 `5203FB538863D28A779FC64D7119F981ADF2234DB2DF35D9A6E4F6CADA2DDEB1`。最终二进制复查 doctor 退出 0，无 Host，无测试进程残留，原版进程身份仍一致。

这些自动化结果不代表真实 M0/M1 门禁通过。首轮失败日志 `cargo-test.log` 予以保留；修复后的完整结果在 `cargo-test-final.log`。其他证据为 `node-test.log`、`m0-m1-harness-tests-final.log`、`m0-crash-harness-tests.log`、`post-verification-state.json` 和 `verification.json`，均位于上述本地留证目录。

## 正式验收入口

已复用 `scripts/Invoke-M0Acceptance.ps1`，默认 M0 行为保持原样。显式 `-RuntimeMode M1` 执行正式 `codlet launch`；加 `-Watch` 执行正式 `codlet launch --watch`。M1 使用独立的 `codlet.m1-acceptance/v1` 报告，记录 before/active/after 进程与监听端口、实际命令、active/stopped 协议和 worker 回收结果；GUI、运行控制、doctor 与 watch 的人工观察单独保留为 pending。

脚本不会关闭冲突进程、修改用户 profile 或自动宣告里程碑通过。脚本退出 0 仅代表所记录的运行链路符合检查条件，`m0Decision` / `m1Decision` 仍为 `not_determined`。

新脚本已在本机分别执行 M0 和 M1-watch preflight；两份真实报告均为 `executionStatus: preflight_conflict`、`scriptExitCode: 2`、`codlet.invoked: false`。报告位于 `m0-preflight/` 与 `m1-watch-preflight/`，没有把拒绝启动记为 GUI 或生命周期通过。

本地留证目录中准备了三个可双击的入口，均使用同一目录内的固定 release：

- `run-m0.cmd`：M0 marker 与前台 Host 正常生命周期。
- `run-m1.cmd`：正式插件运行路径。
- `run-m1-watch.cmd`：正式插件运行路径加文件监听。

这些入口必须从当前 Codex 以外的控制台运行。先保存当前工作并正常退出所有 Codex 实例，再打开相应入口；只关窗口可能仍留下托盘进程，脚本的 preflight 会明确拒绝残留冲突。验收过程中保持该控制台运行，完成观察后正常退出本次 Codex，让脚本记录 after 快照。

## M1 操作与观察清单

以下命令在第二个普通 PowerShell 窗口中运行。所有控制命令必须使用启动 Host 的同一路径二进制，且使用同一 `%LOCALAPPDATA%`。不要把测试实例改成另一个 profile 来规避正式路径的实例冲突。

```powershell
$acceptanceDir = 'C:\Users\cccake\Documents\ChatGPT\codex轻量扩展插件\.codlet-artifacts\m0-m1-acceptance-2026-09-09'
$codletExe = Join-Path $acceptanceDir 'codlet.exe'
& $codletExe status --json
& $codletExe doctor --json
```

1. 检查 Codlet 入口、列表、面板关闭、Tab/Shift-Tab、明暗主题与窄窗。新建窗口、刷新和切换文档后再次检查；`active=true` 不能代替肉眼确认挂载与交互。
2. 用 `plugin disable codex.ui.adapter --json` 验证仍有 GUI dependent 时的拒绝；确认 GUI 没有因此消失。用 `plugin reload codex.ui.adapter --json` 验证 provider 与 dependent 的 generation 换代和恢复。
3. 在 Host 已启动后注册下列无官方 adapter 依赖的测试插件，再执行 enable，验证新插件无需重启即可加载。插件只显示一个可移除的测试标记，没有文件/网络功能。fixture 已准备，但尚未在用户 registry 中注册。

```powershell
& $codletExe plugin list
# 先确认没有已有的同名注册；若存在，应先保留其配置并为测试选择新 ID。
& $codletExe plugin add (Join-Path $acceptanceDir 'fixture') --trust --grant ui.dom
& $codletExe plugin enable dev.codlet.acceptance-marker --json
& $codletExe doctor --json
```

4. 确认所有已接入窗口出现 `Codlet acceptance marker A`；检查新插件的实际 generation。手动 `reload` 后标记应只有一份。`disable` 后全部标记消失；再次 `enable` 应恢复。
5. 在 `run-m1-watch.cmd` 启动的会话中，保持 marker 已加载，执行下列保存。观察 A 变为 B、generation 增加、无重复标记；watch 不应要求重启或手动 reload。改回 A 后再观察一次。

```powershell
Copy-Item -LiteralPath (Join-Path $acceptanceDir 'marker-B.js') -Destination (Join-Path $acceptanceDir 'fixture\renderer.js') -Force
& $codletExe doctor --json
# 完成 B 的观察后再改回 A。
Copy-Item -LiteralPath (Join-Path $acceptanceDir 'marker-A.js') -Destination (Join-Path $acceptanceDir 'fixture\renderer.js') -Force
```

6. 通过 GUI 确认自我禁用，确认所有窗口的 Codlet 入口消失；用同一二进制 `plugin enable codlet --json` 恢复。若专门验证无官方插件路径，可在记录初始启用状态后依次停用 GUI 和 UI adapter，检查 marker 仍工作，再按原状态恢复。该项只证明当前 L1 插件不依赖官方 adapter，不等于 L2–L4 已实现。
7. 保存各步 `--json` 输出和实际观察。清理本次 marker：先 `plugin disable dev.codlet.acceptance-marker --json`，再 `plugin remove dev.codlet.acceptance-marker`；后者保留源文件与该 ID 的禁用偏好。不要为了清理测试而删除整个用户 registry。
8. 正常退出本次 Codex，确认 Host 返回、worker 回收、没有新增相关进程或 Codlet CDP listener。把 GUI 观察作为单独记录附上，不能把 pending 自动改成 passed。

## 仍需单独完成的门禁

| 门禁 | 当前状态与所需证据 |
| --- | --- |
| 当前 build 的 M0 marker、多窗口、正常退出 | 需无冲突的正式 M0 运行 |
| 当前 build 的 M1 GUI、热载入、控制、watch、Inspect 组合 | 需正式 M1/M1-watch 运行与对应观察 |
| 官方入口零 Codlet 行为 | 当前原版会话无 Host 仅是局部证据；仍需记录独立官方启动与前后基线 |
| 连续冷启动、成功率、孤儿与端口基线 | 原计划要求至少 100 次；本轮未执行，不能以单次成功替代 |
| `DEFECT-001` | 保留已知单主实例限制；原计划将修复/发布决定放在 M5 前，不把它单独误记成当前 M1 的新增功能缺口 |
| `DEFECT-002` / Host crash | 保留历史 failed 结果；当前 build 的专用 crash harness 尚未运行；不把 EOF 当成 Codex 已退出 |

Crash harness 会明确终止它自己启动并持有身份的 Runtime Host；它不会强制终止 Codex。需要在无其他实例、无未保存工作时从独立控制台运行 `scripts/Invoke-M0CrashAcceptance.ps1 -CodletPath <同一固定二进制> -ConfirmRuntimeCrash`。正常 M1 脚本不隐式执行 crash 测试。

M0/M1 的原验收条件不会因为本轮[已确认的开放 Core 方向](CORE_EXTENSION_BOUNDARY_2026-09-09.md)而被自动降低或改写。未来架构约束与当前版本的实测证据分别记录。
