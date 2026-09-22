# 独立测试客户端

本地开发工具，固定使用已经审核的 Codex Windows `{{packageVersion}}` 和现有实验资料目录 `{{labRoot}}`。它不是面向最终用户的安装包。

- 启动：双击 `Start-TestClient.cmd`；成功确认后前台窗口退出，后台协调器及测试客户端继续运行。
- 停止：使用 `Stop-TestClient.cmd` 或测试窗口的退出操作；仅关闭窗口可能继续驻留。
- 插件：使用可选的 Codlet GUI，或本目录的 `Test-Plugins.cmd`。
- 诊断：`Test-Doctor.cmd --json`；`Export-Diagnostics.cmd` 导出本地诊断包。

启动最多等待 60 秒。确认必须匹配本次协调器 PID、创建时间及 ready 状态。失败会保留错误原因和日志路径；超时只表示尚未确认，后台进程可能继续准备。先检查状态，勿反复双击。`-StartupTimeoutSeconds` 支持 20–60 秒。

若上次被中断，确认旧测试进程均已退出后运行 `Start-TestClient.cmd -RecoverInterrupted`。恢复会核对最近协调器日志和已记录进程，不会绕过活动进程、官方 CLI 签名/摘要或客户端版本不匹配。官方客户端升级后应重新审核、重新生成这套开发工具。

```powershell
.\Test-Plugins.cmd list --json
.\Test-Plugins.cmd preview "C:\你的插件目录" --json
.\Test-Plugins.cmd add "C:\你的插件目录" --trust --grant ui.dom
.\Test-Plugins.cmd enable 插件ID --json
.\Test-Plugins.cmd reload 插件ID --json
.\Test-Plugins.cmd disable 插件ID --json
.\Test-Plugins.cmd permissions 插件ID --json
.\Test-Plugins.cmd remove 插件ID --json
```

`add` 默认停用；明确加 `--enable` 才立即启用。撤权、依赖级联和移除源文件有各自确认要求，见[管理契约](docs/spec/management.md)。默认不监听源码。随附的隐藏额度提示、本地管理及 GitHub 双版本样例用于验收，并不会因随包存在而自动授权。

命令固定指向实验资料目录中的 `codlet/config.json`，不要用普通 `codlet launch` 代替这个开发启动入口。可选 GUI 依赖 UI Adapter；停用依赖后可用 CLI 依次启用 `codex.ui.adapter`、`codlet-gui` 恢复。

启动日志是本目录的 `launch-*.stdout.log` / `launch-*.stderr.log`，协调器状态及报告路径由启动器显示。测试后端使用独立实验设置，工具可用范围可能与正式客户端不同。日志中的启动成功不能替代实际 UI、权限和插件行为验收。

完整资料见[文档索引](docs/README.md)、[开发指南](docs/development.md)和[故障排查](docs/troubleshooting.md)。
