# Codlet 发布准备与验证范围

当前 **1.0.0-rc.1** 是统一 Core 的本地候选，尚未公开发布，也未安装到日常 Native。UI/Desktop 实现由 Core 维护；GUI、完整功能验收插件和分屏工作台使用 `context.codex`。旧 Adapter 注册、授权和数据保留，安装器只提供可选 GUI。

源码、不可覆写制品、自动检查和实际 Native 结果集中在 [1.0.0-rc.1 验证记录](releases/1.0.0-rc.1/validation.md)。[实现契约](releases/1.0.0-rc.1/implementation.md)说明迁移与 SDK；[仓库职责](repository-layout.md)说明源码、分发和归档位置。

兼容在线更新覆盖明确列出的 Core JavaScript 模块、Native source 和显式插件状态。Rust/Node、固定桥接与注入组件继续常驻；这些组件变化以及首次从旧架构升级，需要自然退出后的下一次启动。回执未知时查询原操作，不盲目重放。详见[在线更新契约](core-online-update.md)。

本候选的实机证据来自独立 Windows Native 和合成数据。自动测试、实际 IPC、Native 功能和人工输入验收分别记录。以下范围仍独立保留：

- macOS 本轮桌面验收与 Windows ARM64；macOS 整包更新走 next-start，尚无在线组件包契约。
- 干净设备的安装、升级、卸载及签名。
- 物理 IME、附件、系统拖动/快捷键/剪贴板等未在本轮执行的交互。
- 真实 OAuth、任意上游模型和其他未覆盖网络路径；此前性能结果不自动继承。

[0.2.0 发布准备记录](history/releases/0.2.0-readiness.md)保留旧门禁、提交和结果，只用于追溯。旧 Adapter 的远端仓库、标签和 Release 未在本次目录整理中修改；可在替代 Core 发布可用后设为只读归档。
