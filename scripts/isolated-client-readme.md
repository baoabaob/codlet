# 独立测试客户端

适配 Codex Windows `{{packageVersion}}`，使用当前 M2 插件运行时。

- 启动：双击 `Start-TestClient.cmd`。首次启动需要准备新版运行时缓存，稍等片刻。
- 停止：双击 `Stop-TestClient.cmd`，或在测试窗口菜单中选择退出。仅关闭窗口可能让客户端继续驻留。
- 登录资料：继续使用 `{{labRoot}}` 中原有的测试登录、历史和设置。
- 插件：在测试窗口的 **Codlet** 菜单中管理；启停状态保存在测试注册表中，随附“隐藏额度提示”的本地源码包。

在这个目录打开终端，使用 `Test-Plugins.cmd` 管理本地插件：

```powershell
.\Test-Plugins.cmd list
.\Test-Plugins.cmd add "C:\你的插件目录" --trust --grant ui.dom
.\Test-Plugins.cmd enable 插件ID --json
.\Test-Plugins.cmd reload 插件ID --json
.\Test-Plugins.cmd disable 插件ID --json
.\Test-Plugins.cmd permissions 插件ID --json
.\Test-Plugins.cmd revoke 插件ID ui.dom --json
.\Test-Plugins.cmd remove 插件ID
```

“隐藏额度提示”的 ID 是 `dev.local.hide-usage-banner`。源码在 `plugins/hide-usage-banner`；修改后用上面的 `reload` 命令重载。支持本地 Renderer、Host 和组合插件；Host 使用随附的固定 Node 运行时，权限和 OS 访问范围沿用 M2 的显式授权。此测试入口不自动监听源文件。

所有命令固定指向测试注册表 `{{labRoot}}/codlet/config.json`。日常 Codex、其登录资料、默认 Codlet 注册表和快捷方式不被修改。不要用普通 `codlet launch` 代替这个测试启动入口。

测试环境继续使用独立 WebSocket 后端、开发模式和受限功能设置；后端的终端/文件执行保持只读，浏览器与电脑控制功能关闭。插件代码仍需自行信任。客户端升级到其他版本时，入口会拒绝启动，需要重新核对兼容性。

启动日志是本目录最新的 `launch-*.stdout.log` / `launch-*.stderr.log`。当前状态和详细启动报告在测试资料目录的 `logs/manual-client.json` 及其 `report` 指向的文件中。日志中的启动/激活状态不代替你的界面功能测试。
