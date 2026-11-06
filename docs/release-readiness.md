# Codlet 发布准备与验证范围

## rc.24 验证范围

Windows x64 **1.0.0-rc.24 preview**适配 Native 包 `26.1103.3517.0`、应用 `26.1103.31037` / build `25241`，包含 Desktop `0.2.23`、UI `0.1.21` 和 GUI `1.0.0-rc.7`。新增 Rspack 模块归属验证，并修复会话元数据、权限缓存和工作区接口变化。

完整 Codex 测试 666 项通过、2 项跳过；Rust 隔离检查 39 项通过。独立 Native 常驻构建完成模拟消息、历史、权限读取、工作状态变化、消息区挂载与滚动、快捷键注册、独立面板和页面恢复。发布脚本及安装器自检通过。具体产物、实验构建与生产安装验收的区别见 [rc.24 验证记录](releases/1.0.0-rc.24/validation.md)。

rc.24 提供完整 runtime 更新包和 setup，需要重启 Core。该轮没有执行真实账号上游网络、MSI 安装升级、macOS/ARM64 或私有分屏插件的完整验收。

## rc.23 验证范围

Windows x64 **1.0.0-rc.23 preview**修复插件页面就绪、Native 工具栏发现、插件健康状态和会话滚动位置恢复。生产程序来自 Core `ba1ecd6afb122cc1aaaf1ec6b0942c80819368bc`，包含 Desktop `0.2.22`、UI `0.1.20`，安装器提供 GUI `1.0.0-rc.7`。官方客户端目标仍为包 `26.1027.3384.0`、应用 `26.1027.30824` / build `22943`。[rc.23 验证记录](releases/1.0.0-rc.23/validation.md)保存具体结果和产物身份。

| 项目 | 当前结果 |
| --- | --- |
| 构建与载荷 | 95 项冻结输入、14 项必需嵌入内容、portable/MSI 各 39 项文件、setup 内嵌 MSI 全部匹配 |
| Windows 生产升级 | 独立 VM 从已发布 rc.22 经生产 setup 升级到 rc.23；用户范围和目录保留，已安装 Core SHA-256 为 `51287f13…` |
| 页面与功能测试 | 冷启动出现唯一页面入口及真实 Native HeaderToolbar；空闲重载从 generation 1 到 2 后仍只有一个入口和一个 lease；只读检查完成，0 项失败 |
| 健康状态与 GUI 操作 | 激活失败、活动诊断、诊断解除、通过 GUI 重载插件时的局部错误与恢复均已覆盖 |
| 本地插件更新 | 独立配置目录验证了官方 GUI 来源、已有授权、禁用偏好和存储保留；重复执行无写入；未确认操作阻止重放 |
| 滚动与拖动区域 | 78 项滚动回归、真实 Native anchor 对照、37px 到 0px 的精度对照、R3 四卡片 ready；同 owner CSS 对照将标题栏相交区域从 21 降到 0，最终私有包通过 157 项回归 |
| 最终分屏冷启动矩阵 | 未执行；同 owner 更新 op0005 已知回滚，随后 VM 恢复环境在新 Core 测试开始前失效 |
| VM 停止 | 原 R3 的宿主 VM 进程经授权强制终止；6GB 恢复 VM 经一次 poweroff 停止，宿主 PID 退出。均不计作正常 Native Quit |

健康矩阵的原始报告保留 `failed`：观察代码把 `renderer.error` 结构对象当成字符串而抛错，后续诊断字段读取也与实际结构不符。独立 continuation 读取真实字段，完成此前未执行的健康阶段。已完成的功能插件重载没有重放；通过 GUI 发起的三次目标插件重载各有一次点击和独立操作回执，结果分别为 `rolled_back`、`applied`、`applied`。健康阶段没有发起模型请求。

rc.23 使用完整 runtime 更新包和匹配的 setup。已安装的 Windows 版本通过 setup 升级；portable 更新包用于现有 portable 安装。自定义插件需要更新其自己的包或源码。物理窗口拖动未在本轮执行，源码、CSS 和几何检查不等同于物理拖动验收；macOS、Windows ARM64 和未执行的真实账号/上游网络路径也不在本轮范围内。

最终私有 Split 包的滚动和 CSS 证据来自定向回归、既有 Native owner 中的模块/样式对照及最终源码字节核对。op0005 因辅助 target 的状态快照请求到期而 `rolled_back`，旧 generation 保留；可选 probe 的结果未确认，未重放。后续 6GB 恢复 VM 在本轮 Core 测试开始前再次失去 guest-control/heartbeat，最终精确包的独立 cold 矩阵没有开始。VM 停止和证据保全单独记录，不计作正常 Native 退出或矩阵通过。

## 已发布的 rc.22

此前的 Windows x64 preview **[1.0.0-rc.22](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.22)** 适配官方包 `26.1027.3384.0`、应用 `26.1027.30824` / build `22943`，包含 Desktop `0.2.22`、UI `0.1.19` 和可选 GUI `1.0.0-rc.6`。[rc.22 验证记录](releases/1.0.0-rc.22/validation.md)给出生产程序的安装、Native/侧栏/分屏分项验收及边界；[发布记录](releases/1.0.0-rc.22/publication.md)保存公开资产和下载校验。

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
