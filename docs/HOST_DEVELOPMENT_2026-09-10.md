# Host JS 开发与组合验收

本页把统一 JS 目录包、在线生命周期、watch、带预算的 cleanup 与 doctor 串成一次开发流程。

需要同一个包同时运行 Host 和 renderer 时，使用
[双入口示例](../examples/local-host-renderer-capability/README.md)。它在 renderer 激活中
等待自己的 Host capability，并参与双入口共享代次、依赖闭包与失败补偿；
[实际 JS 验收](HOST_RENDERER_VM_ACCEPTANCE_2026-09-10.md)执行两侧真实入口代码。
下文保留独立 cleanup-host 的开发流程。
使用便携发行目录中的真实 [cleanup-host 示例](../examples/cleanup-host/README.md)：它保留一个
CDP session 和属于本代的 JS global，退出时删除该 global 并 detach session，不依赖官方
renderer 或 adapter。

## 便携目录准备

将发行 ZIP 解压到独立目录，例如 `C:\Tools\codlet-0.1.0-win-x64`。保留 `codlet.exe`、
`runtime/`、`examples/`、`types/` 和 `docs/` 的相对位置。固定 Node 已随包提供，无需另装
系统 Node；TS 插件仍应先构建为 JS。构建与文件清单见 [便携发行说明](DISTRIBUTION.md)。

以下实机命令使用当前用户的 Codlet registry，会保存指定插件的启停偏好。正常关闭准备
测试的 Codex 实例后，在 PowerShell 终端一执行：

```powershell
$packageDir = 'C:\Tools\codlet-0.1.0-win-x64'
$codletExe = Join-Path $packageDir 'codlet.exe'
& $codletExe plugin list
& $codletExe plugin disable codlet-gui
& $codletExe plugin disable codex.ui.adapter
& $codletExe launch --watch
```

如已有其他启用的本地插件，先按实际 ID 停用，便可单独观察 Core 加这个示例。GUI 要先于
它所依赖的 adapter 停用。`launch --watch` 保留在终端一运行；普通 `launch` 不观察文件。

## 在线加入示例

在终端二使用同一个发行目录与可执行文件路径：

```powershell
$packageDir = 'C:\Tools\codlet-0.1.0-win-x64'
$codletExe = Join-Path $packageDir 'codlet.exe'
$pluginRoot = Join-Path $packageDir 'examples\cleanup-host'
[IO.File]::WriteAllText(
  (Join-Path $pluginRoot 'settings.json'),
  '{"report":"development"}',
  [Text.UTF8Encoding]::new($false)
)
& $codletExe plugin add $pluginRoot --trust --grant host.process --grant cdp.raw
& $codletExe plugin enable example.cleanup-host
& $codletExe doctor --json
Get-Content -LiteralPath (Join-Path $pluginRoot 'development.active.json')
```

PowerShell 的 `& $codletExe` 用于执行保存在变量中的程序路径。报告配置写为不带 BOM 的
UTF-8，适用于 Windows PowerShell 和新 PowerShell。示例默认选择第一个可用 CDP target；
`settings.json` 也可设置明确的 `targetId`。如果初始化时还没有 target，待 Codex 完成启动
后可用 `plugin reload example.cleanup-host` 重试。

`doctor` 的 `runtime.hostProcesses.sample.plugins` 应包含示例 ID、实际 Node PID、
generation 和 `state: "active"`。`development.active.json` 记录示例保留的 session ID
与本代 generation。当前运行状态以执行器/receipt 为准；示例报告只记录它自身完成的步骤。

## 编辑、热重载与清理

用编辑器打开 `examples/cleanup-host/dist/host.js`，将 marker 的值
`Codlet cleanup example` 改为另一个字符串并保存。终端一会记录 watch 的 requested、
operation-id 和完成结果；同一稳定版本只提交一次。两次相同观察与 quiet 条件满足后，
旧代先执行 `deactivate(cleanup)`，新代才开始 activate。

```powershell
& $codletExe plugin operation '<从 watch 日志复制的 operation-id>' --json
& $codletExe doctor --json
Get-Content -LiteralPath (Join-Path $pluginRoot 'development.cleanup.json')
Get-Content -LiteralPath (Join-Path $pluginRoot 'development.active.json')
```

正常结果是 receipt 为 `applied`、doctor 显示更大的 generation 及该代 PID，cleanup
报告为 `completed: true`，active 报告包含新 session。`cleanup.completed` 表示受限协作
清理阶段已确认；`state: exited` 和 `exit.workersReaped` 才是该进程/IO 退休事实。运行时
样本只保留每个 ID 的最新代及有限终态记录，因此不要把新代样本中缺少旧代当作完整历史。

watch 只观察 `codlet.json` 和其声明的 JS 主入口。TS 输入、`require` 模块和其他资源改变
后，需要自行构建主入口或明确执行 reload。改变注册目录或完整 grants 会暂停 host watch，
需用 CLI enable/reload 明确选择；注册一个新目录本身不会自动执行它。
已加载的 canonical root 若消失或被替换为指向其他目录的 junction，host watch 同样暂停并
去重诊断；排队执行前及候选装载后还会核对 root，防止只凭旧注册路径字符串跟到别处。

若希望观察失败补偿，可在示例 `activate` 最后临时加一行 `throw new Error('dev failure')`，
保留原有 `deactivate`。当失败发生在 attach/marker 建立之后，候选也应先清理自身 session，
随后在当前授信仍允许时用旧源码快照和新 generation 恢复，receipt 为 `rolled_back`。
同一坏入口不会因为补偿产生的新代数而不断重启。修复入口并保存后可再次稳定选取；补偿
不会改写磁盘上的坏代码。

## 停用与最终检查

```powershell
& $codletExe plugin disable example.cleanup-host
& $codletExe doctor --json
Get-Content -LiteralPath (Join-Path $pluginRoot 'development.cleanup.json')
```

检查示例的最新记录：`state: "exited"`、`cleanup.phase: "completed"`、请求/订阅/outbox
计数为零、`exit.workersReaped: true`。正常示例还应有 `exitCode: 0`、`forced: false`。
之后可正常关闭本次 Codex；若要恢复 GUI 偏好，按 adapter、GUI 的顺序重新 enable。示例
注册可在 disable 后用 `plugin remove example.cleanup-host` 移除，其目录与报告文件保留。

## 本轮组合证据与限度

自动组合验收复制仓库真实 cleanup-host 到临时目录，使用固定 Node、既有 raw-host 假 CDP
对端、实际 HostControl/Watcher/StatusPublisher/ControlBroker 和 doctor 模型。静态包发现
输入是夹具数据；host 的进程、代数、资源和退出数据来自真实执行器样本，没有手填 host DTO。

验收链路为 enable → watch 替换 → Inspect/doctor → 已 attach 后初始化失败 → 清理候选并
补偿旧快照 → 稳定轮询不重复失败 → disable → 最终退出快照。逐项核对每代 marker 设置/
删除命令，以及每次 Detach 早于下一次 Attach，防止旧代或坏候选 session 累计。

组合专项 `actual_cleanup_example_completes_enable_watch_inspection_compensation_and_disable_as_one_flow`
通过，实际结果如下：

| 阶段 | 最新运行代数 | 保留 session 数 | 回执/事实 |
| --- | --- | --- | --- |
| 在线 enable | 1 | 1 | applied；Inspect/doctor 显示真实 Node active |
| 编辑主入口并 watch | 2 | 1 | applied；第 1 代先 Delete、Detach，再启动第 2 代 |
| 已 attach 的候选失败 | 失败 3 → 恢复 4 | 1 | rolled_back；第 2、3 代均完成清理，第 4 代使用旧快照 |
| 重复稳定轮询 | 4 | 1 | 没有重复 receipt、Attach 或重启 |
| disable | 4，exited | 0 | cleanup completed；exit 0、forced=false、workersReaped=true，资源计数为零 |
| Runtime 结束 | 保留第 4 代退出事实 | 0 | terminated；ownerAlive=false、runtimeStopping=true |

记录到的每个 session 顺序都是 `Attach → Set → Delete → Detach`，依次为 raw-session-1、
2、3、4；下一次 Attach 均晚于前一个 Detach。Inspector 已取得的旧样本保持不变，重复
只读查询不创建新 publication 或生命周期动作。

同批新增的真实 Windows canonical-root/junction 单项及 5 个必要兼容复核也已通过；详见
[host watch 的边界验证](HOST_WATCH_2026-09-10.md)。这些检查使用临时 registry 和测试进程，
未重跑完整 M0/M1。此自动夹具维护 CDP session 并记录/确认 evaluate 指令，
不执行真实页面 JavaScript；命令配对不等于 GUI 视觉或真实页面效果验收。上述便携实机流程
尚未在真实 Codex 中重跑，也没有改写此前 M0/M1 证据。

cleanup 只给本代声明并获授的原语一个有限总预算。它不能撤回所有 raw CDP、文件或网络
副作用，普通用户 Node 也不是安全沙箱。详见 [清理契约](HOST_CLEANUP_2026-09-10.md)、
[执行诊断](HOST_INSPECTION_2026-09-10.md)、[host watch](HOST_WATCH_2026-09-10.md) 和
[类型声明](../types/host.d.ts)。
