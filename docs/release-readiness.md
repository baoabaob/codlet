# Codlet 发布准备与验证范围

当前已发布的 Windows x64 preview 为 **[1.0.0-rc.22](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.22)**，适配官方包 `26.1027.3384.0`、应用 `26.1027.30824` / build `22943`，包含 Desktop `0.2.22`、UI `0.1.19` 和可选 GUI `1.0.0-rc.6`。[rc.22 验证记录](releases/1.0.0-rc.22/validation.md)给出生产程序的安装、Native/侧栏/分屏分项验收及边界；[发布记录](releases/1.0.0-rc.22/publication.md)保存公开资产和下载校验。

`b32fc5e` 生产包通过 8 项标准嵌入源、13 项完整输入嵌入、portable/MSI 各 39 项文件哈希、setup 内嵌 MSI 和安装结构检查。四项 Rust 定向检查共 9 用例通过；前端字节沿用冻结的 `c7436bb` 输出。实际 Core 哈希为 `c30f696c…`；`47312` 独立 VM 的 rc.21 升级、同版 maintenance、Native/侧栏/分屏与权限读取均通过，Core 日志未出现 cleanup/consumer 拒收错误。公开 setup 匿名下载 HTTP 200，完整 SHA-256 与该安装包相同。

`47312` 首个 renderer session 的 `Runtime.enable` 到期后，原退休请求由真实 `session_ended` 终结，既有恢复流程接续成功。该轮原 harness 保留 `failed`：末项更新检查已终结为网络错误；同一 Core/owner 的一次新检查成功返回 `upToDate`，网络设置未改。前一 `5ed` 也记录过同形错误及一次成功复核，现有通用错误无法细分具体传输原因。功能分项、成功复核和正常退出构成本次准入依据。更早的冷启动失败、未执行 kind-only probe 和修复链保留在验证记录中。

rc.20/rc.21 MSI 用户升级到 rc.22 时，需先保存工作并完全退出 Codex/Codlet，再直接运行 rc.22 setup EXE。旧更新器可能在启动 Windows Installer 前拒绝 Windows 自带 PowerShell 的硬链接。新修复从安装后的 rc.22 Core 生效，不能修补已经运行的旧进程。Setup 保留安装目录、用户/机器范围与功能选择，只更新 Codlet；官方客户端按其已有更新流程单独完成更新。若官方更新后自动打开客户端，应完全退出，再从 Codlet 快捷方式启动。

rc.22 改变常驻 observer 与 Rust updater，schema-1/schema-2 均使用完整 runtime 和匹配 setup，不提供面向 rc.21 的在线组件包。既有兼容在线更新契约继续覆盖声明的 JavaScript 模块、Native source 和显式插件状态；Rust/Node、固定桥接与注入组件变化需要下一次启动。未知回执查询原操作，不盲目重放。详见[在线更新契约](core-online-update.md)。

[rc.20 验证记录](releases/1.0.0-rc.20/validation.md)和 [Native 适配说明](native-adaptation-20261028.md)保留 build 22391/21828 的历史通过范围。[rc.21 记录](releases/1.0.0-rc.21/validation.md)保留 Electron 上传结束后的响应处理修复，以及官方包 `26.1023.6621.0` 的直接 setup 恢复：安装目录、用户范围和功能选择保留，Core 哈希与公开包一致，Core/Native ready 且用户确认恢复。历史证据不代替新 Native 验收。最新 macOS 包仍为 [rc.7](releases/1.0.0-rc.7/validation.md)，使用其记录的官方客户端身份。

本轮仍未覆盖：

- macOS 本轮桌面验收与 Windows ARM64；macOS 整包更新走 next-start，尚无在线组件包契约。
- Windows 真机与 macOS 的安装、升级、卸载及签名；Windows VM 证据不覆盖这些环境。
- 物理 IME、附件、系统拖动/快捷键/剪贴板等未在本轮执行的交互。
- 真实 OAuth、任意上游模型和其他未覆盖网络路径；此前性能结果不自动继承。
- 真实账号设置与 Statsig 网络路径、首次 Node 下载；本轮使用合成 loopback API-key 后端和已核 pinned Node。
- 新 Native 菜单没有明确的 read-only 选项，read-only 权限写入不受支持且未执行；没有替换为更宽权限。
- 公开 release selector 的更新版本安装与官方 Native updater 重启；本轮验证了真实 sealed helper、setup maintenance、系统 PowerShell 硬链接和 Core CLI 重启。

[0.2.0 发布准备记录](history/releases/0.2.0-readiness.md)保留旧门禁、提交和结果，只用于追溯。旧 Adapter 的远端仓库、标签和 Release 未在本次目录整理中修改；可在替代 Core 发布可用后设为只读归档。
