# Codlet 发布准备与验证范围

当前 Windows 预览版为 **1.0.0-rc.19**。Codlet 提供轻量插件加载、统一 SDK 和 AI 创建流程。Core 根据实际接口和能力接入客户端；未知文件指纹进入协议和结构验证。

本轮变更、安装包和检查集中在 [1.0.0-rc.19 验证记录](releases/1.0.0-rc.19/validation.md)，包括运行中客户端的 skill 注册修复及隐藏窗口内独立 transcript 的只读定位检查。此前的 [rc.18](releases/1.0.0-rc.18/validation.md) 记录 Native 深层工作区归属、更新确认和联合更新交接；Native VM 功能验收见 [rc.17](releases/1.0.0-rc.17/validation.md)，独立 Windows VM 的完整安装与升级、取消、失败回滚、维护和降级见 [rc.11](releases/1.0.0-rc.11/validation.md)。[仓库职责](repository-layout.md)说明源码、分发和归档位置。

兼容在线更新覆盖明确列出的 Core JavaScript 模块、Native source 和显式插件状态。Rust/Node、固定桥接与注入组件继续常驻；这些组件变化以及首次从旧架构升级，需要自然退出后的下一次启动。回执未知时查询原操作，不盲目重放。详见[在线更新契约](core-online-update.md)。

当前 Windows Native 包身份为 `26.1021.3705.0`，应用 `26.1021.31345` / build `21828`。最新 macOS 包仍为 [rc.7](releases/1.0.0-rc.7/validation.md)，使用其记录的官方客户端身份。以下范围仍需独立设备验收：

- macOS 本轮桌面验收与 Windows ARM64；macOS 整包更新走 next-start，尚无在线组件包契约。
- Windows 真机与 macOS 的安装、升级、卸载及签名；Windows VM 证据不覆盖这些环境。
- 物理 IME、附件、系统拖动/快捷键/剪贴板等未在本轮执行的交互。
- 真实 OAuth、任意上游模型和其他未覆盖网络路径；此前性能结果不自动继承。

[0.2.0 发布准备记录](history/releases/0.2.0-readiness.md)保留旧门禁、提交和结果，只用于追溯。旧 Adapter 的远端仓库、标签和 Release 未在本次目录整理中修改；可在替代 Core 发布可用后设为只读归档。
