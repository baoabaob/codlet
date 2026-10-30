# Codlet 发布准备与验证范围

当前 Windows x64 本地候选 **1.0.0-rc.21** 修复 rc.20 将 Electron 上传流关闭误判为 HTTP 请求失败的问题。该错误会阻断账户、工作区设置和界面功能开关请求；[rc.21 验证记录](releases/1.0.0-rc.21/validation.md)记录修复与交付状态。rc.20 已于 2026-10-28 发布。Codlet 提供轻量插件加载、统一 SDK 和 AI 创建流程。Core 根据实际接口和能力接入客户端；未知文件指纹进入协议和结构验证。

[rc.20 验证记录](releases/1.0.0-rc.20/validation.md) 和 [Native 适配说明](native-adaptation-20261028.md) 保留同一生产程序在 build 22391/21828 上的真实对话、权限读取、侧栏布局热切换、project/list 分组及正常退出证据；这些测试未覆盖本次失败的已登录 Desktop HTTP 路径。新版还实际经过初次 CDP 初始化超时、原 session 退休确认和自动恢复，无手工 reload。快捷键只验证接口准备；无远端的 connection 分组和物理按键不在通过范围。安装包结构和安装升级须分别记录。[rc.19](releases/1.0.0-rc.19/validation.md)、[rc.18](releases/1.0.0-rc.18/validation.md)、[rc.17](releases/1.0.0-rc.17/validation.md) 和 [rc.11 安装验收](releases/1.0.0-rc.11/validation.md) 保留各自原始范围。[仓库职责](repository-layout.md)说明源码、分发和归档位置。

兼容在线更新覆盖明确列出的 Core JavaScript 模块、Native source 和显式插件状态。Rust/Node、固定桥接与注入组件继续常驻；这些组件变化以及首次从旧架构升级，需要自然退出后的下一次启动。回执未知时查询原操作，不盲目重放。详见[在线更新契约](core-online-update.md)。

本轮实际取得并验收的 Windows Native 包为 `26.1023.6123.0`，应用 `26.1023.50603` / build `22391`；`26.1021.3705.0` / build `21828` 的同程序回归也已通过。最终官方分发复查仍返回 `.6123.0`，Store 通知中的 `26.1023.6621.0` 尚无取得和验收证据。最新 macOS 包仍为 [rc.7](releases/1.0.0-rc.7/validation.md)，使用其记录的官方客户端身份。以下范围仍需独立设备验收：

- macOS 本轮桌面验收与 Windows ARM64；macOS 整包更新走 next-start，尚无在线组件包契约。
- Windows 真机与 macOS 的安装、升级、卸载及签名；Windows VM 证据不覆盖这些环境。
- 物理 IME、附件、系统拖动/快捷键/剪贴板等未在本轮执行的交互。
- 真实 OAuth、任意上游模型和其他未覆盖网络路径；此前性能结果不自动继承。

[0.2.0 发布准备记录](history/releases/0.2.0-readiness.md)保留旧门禁、提交和结果，只用于追溯。旧 Adapter 的远端仓库、标签和 Release 未在本次目录整理中修改；可在替代 Core 发布可用后设为只读归档。
