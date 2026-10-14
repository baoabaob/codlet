# 独立测试客户端

本地开发工具，固定使用已经审核的 Codex Windows `{{packageVersion}}` 和现有实验资料目录 `{{labRoot}}`。它不是面向最终用户的安装包。

- 启动：双击 `Start-TestClient.cmd`；成功确认后前台窗口退出，后台协调器及测试客户端继续运行。
- 新建的空测试 profile：先手动运行 `Login-TestProfile.cmd`，按官方设备登录提示认证。凭据仅保存到这个测试 profile 的 file store；无需复制日常 profile。登录完成后再启动测试客户端。
- 也可运行 `Start-TestClient.cmd -Onboarding` 打开所属测试 profile 的原生登录/初始化窗口。该模式明确标为 `awaiting_authentication` / `awaiting_sandbox`，不会报告测试 ready；正常启动的认证与 sandbox 门槛保持不变。仅在这两个待办状态每 5 秒检查一次就绪条件，达到 ready 后停止该轮询，因此待办期间不能作为空闲 CPU 性能样本。
- 首次 Windows 设置写入后，外置后端可能仍使用启动时的旧配置；仅重新连接 WebSocket 不会重新加载。协调器检测到已保存的 sandbox 模式与 `notConfigured` 不一致时，最多正常重启自己的客户端和后端一次，保留此 profile 的登录与设置。退出未成功则不重开；重开仍按全部条件检查。
- 停止：使用 `Stop-TestClient.cmd` 或测试窗口的退出操作；仅关闭窗口可能继续驻留。
- 插件：使用可选的 Codlet GUI，或本目录的 `Test-Plugins.cmd`。
- 诊断：`Test-Doctor.cmd --json`；`Export-Diagnostics.cmd` 导出本地诊断包。

启动最多等待 60 秒。确认必须匹配本次协调器 PID、创建时间及 ready 状态。失败会保留错误原因和日志路径；超时只表示尚未确认，后台进程可能继续准备。先检查状态，勿反复双击。`-StartupTimeoutSeconds` 支持 20–60 秒。

若上次被中断，确认旧测试进程均已退出后运行 `Start-TestClient.cmd -RecoverInterrupted`。恢复会核对最近协调器日志和已记录进程，不会绕过活动进程、官方 CLI 签名/摘要或客户端版本不匹配。官方客户端升级后应重新审核、重新生成这套开发工具。

状态发布若持续遇到文件占用，日志会提示 `state files may be stale`，并保留唯一 `.tmp` 文件供诊断。不要把临时文件当作已发布状态，也不要删除故障证据或手工把 `starting` 改成 `closed`。最近 lab report 若已有匹配的正常退出及 worker 回收记录，旧 `starting` 本身不会阻止经身份检查的恢复；缺少完整退出记录时，显式恢复仍走更严格的已记录进程退役检查。

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

命令固定指向实验资料目录中的 `codlet/config.json`，不要用普通 `codlet launch` 代替这个开发启动入口。Core 已包含界面与桌面 SDK；可选 GUI 使用 CLI 启用 `codlet-gui` 即可。旧 Adapter 注册保留但不执行第二份。

启动日志是本目录的 `launch-*.stdout.log` / `launch-*.stderr.log`，协调器状态及报告路径由启动器显示。测试后端使用独立实验设置，工具可用范围可能与正式客户端不同。日志中的启动成功不能替代实际 UI、权限和插件行为验收。

完整资料见[文档索引](docs/README.md)、[开发指南](docs/development.md)和[故障排查](docs/troubleshooting.md)。
