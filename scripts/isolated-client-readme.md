# 独立测试客户端

适配 Codex Windows `{{packageVersion}}`，使用当前插件运行时，支持可选的 M3 主世界 ABI。

新运行时提供共享 UI 控件。`examples/ui-controls` 可作为普通 `ui.dom` 插件注册，在菜单栏显示 **UI** 示例；M3/M4 面板提供当前任务同步、原生任务打开和拦截器诊断。Codlet 菜单支持从本地文件夹导入：检查后逐项授权，默认停用，可选择立即启用；Details 中可查看权限、撤销和移除。移除保留作者文件，测试入口不启用自动监听。

本轮手测请按 `M5-ManualTest.md` 操作。随附 `plugins/local-management-check` 测试样例；它尚未注册，启用后仅显示一个可清理的状态标记。

M5b 新增 **Import GitHub**、来源记录、手动更新和历史回滚，步骤在 `M5-GitHubManualTest.md`；`plugins/github-release-check/v1`、`v2` 是未注册、未上传的发布素材。审批补验和 M0/M1 的解释在 `Remaining-Acceptance.md`，正式启动专项另行安排。完整说明位于 `docs`。

- 启动：双击 `Start-TestClient.cmd`。前台最多等待 60 秒，只有本次后台协调器的 PID、进程创建时间和 ready 状态全部匹配才显示启动成功。成功后前台窗口退出，后台协调器和测试客户端继续运行。首次启动需要准备运行时缓存，稍等片刻。
- 停止：双击 `Stop-TestClient.cmd`，或在测试窗口菜单中选择退出。仅关闭窗口可能让客户端继续驻留。
- 登录资料：继续使用 `{{labRoot}}` 中原有的测试登录、历史和设置。
- 插件：在测试窗口的 **Codlet** 菜单中管理；启停状态保存在测试注册表中，随附“隐藏额度提示”的本地源码包。

若上次测试被中断，普通启动会保留缺少关闭证明的报错。确认旧测试进程已退出后，可在本目录运行 `Start-TestClient.cmd -RecoverInterrupted`。它会核对最新原始日志、匹配的协调器状态及全部已记录进程；活动或无法确认的进程会阻止恢复。旧日志和账号历史保持原样，新日志明确记录上一轮清理结果未知。

启动失败时，命令窗口会保留错误原因和本次日志路径，按任意键后才关闭。若提示固定的官方 CLI 路径不存在、摘要不匹配或 Codex 包版本变化，通常是官方客户端已升级；需要重新审核并使用匹配版本的测试包。`-RecoverInterrupted` 只处理旧测试被中断的记录，不能批准新版本或修复失效的 CLI 路径。启动器不会自动修改固定版本、恢复记录或重试启动。

若 60 秒内未取得本次 ready，窗口会明确显示“结果仍未知”。后台协调器保留，可能随后完成启动或报告失败；不要再次双击启动。先检查提示中的协调器状态和日志，进入 `ready` 或 `starting` 后可用 `Stop-TestClient.cmd` 请求正常关闭。启动器不会因等待超时而强杀任何进程。终端可使用 `Start-TestClient.cmd -StartupTimeoutSeconds 20` 调整等待时间，允许范围为 20–60 秒。

在这个目录打开终端，使用 `Test-Plugins.cmd` 管理本地插件。`add` 默认注册为停用，加入 `--enable` 可立即启用；移除带有依赖的插件时使用 `--cascade` 确认同时停用这些依赖：

```powershell
.\Test-Plugins.cmd list
.\Test-Plugins.cmd preview "C:\你的插件目录" --json
.\Test-Plugins.cmd add "C:\你的插件目录" --trust --grant ui.dom
.\Test-Plugins.cmd enable 插件ID --json
.\Test-Plugins.cmd reload 插件ID --json
.\Test-Plugins.cmd disable 插件ID --json
.\Test-Plugins.cmd permissions 插件ID --json
.\Test-Plugins.cmd revoke 插件ID ui.dom --json
.\Test-Plugins.cmd remove 插件ID --json
```

“隐藏额度提示”的 ID 是 `dev.local.hide-usage-banner`。源码在 `plugins/hide-usage-banner`；修改后用上面的 `reload` 命令重载。支持本地 Renderer、Host 和组合插件；Host 使用随附的固定 Node 运行时，权限和 OS 访问范围沿用 M2 的显式授权。此测试入口不自动监听源文件。

所有命令固定指向测试注册表 `{{labRoot}}/codlet/config.json`。日常 Codex、其登录资料、默认 Codlet 注册表和快捷方式不被修改。不要用普通 `codlet launch` 代替这个测试启动入口。

使用 `Test-Doctor.cmd --json` 获取测试实例的静态检查和已认证运行时诊断。它使用匹配的测试程序并校验资料目录；普通 `codlet.exe` 与运行中的测试 Host 路径不同，会拒绝把该 Host 当成自己的实例。

在界面确认关闭 Codex UI Adapter 时，会同时停用依赖它的 Codlet GUI，菜单和面板随之消失。需要恢复时，在本目录终端依次运行：

```powershell
.\Test-Plugins.cmd enable codex.ui.adapter --json
.\Test-Plugins.cmd enable codlet-gui --json
```

测试环境继续使用独立 WebSocket 后端、开发模式和受限功能设置；后端默认只读，额外写入需要当前回合的明确审批，浏览器、电脑控制和 app-tools 桥关闭。插件代码仍需自行信任。客户端升级到未审核版本时，入口会拒绝启动，需要重新核对兼容性。

启动日志是本目录最新的 `launch-*.stdout.log` / `launch-*.stderr.log`。当前状态和详细启动报告在测试资料目录的 `logs/manual-client.json` 及其 `report` 指向的文件中。日志中的启动/激活状态不代替你的界面功能测试。
