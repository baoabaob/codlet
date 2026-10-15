# Codlet 发布准备与验证范围

当前候选为 **1.0.0-rc.2**。Core 根据实际接口和能力接入客户端；未知文件指纹进入协议和结构验证。UI/Desktop 实现由 Core 维护，普通插件使用 `context.codex`。

本轮变更与检查集中在 [1.0.0-rc.2 验证记录](releases/1.0.0-rc.2/validation.md)。[1.0.0-rc.1 记录](releases/1.0.0-rc.1/validation.md)保留此前验收和制品身份；它使用专用 source 的流量检查没有覆盖正式安装后的自动接入。[仓库职责](repository-layout.md)说明源码、分发和归档位置。

兼容在线更新覆盖明确列出的 Core JavaScript 模块、Native source 和显式插件状态。Rust/Node、固定桥接与注入组件继续常驻；这些组件变化以及首次从旧架构升级，需要自然退出后的下一次启动。回执未知时查询原操作，不盲目重放。详见[在线更新契约](core-online-update.md)。

本轮已验证真实后端的只读协议与配置往返、生产后端启动函数，以及真实 Node 调试器暂停入口的捕获。正式安装包的完整桌面启动需要在当前托管窗口退出后验证。以下范围另行保留：

- macOS 本轮桌面验收与 Windows ARM64；macOS 整包更新走 next-start，尚无在线组件包契约。
- 干净设备的安装、升级、卸载及签名。
- 物理 IME、附件、系统拖动/快捷键/剪贴板等未在本轮执行的交互。
- 真实 OAuth、任意上游模型和其他未覆盖网络路径；此前性能结果不自动继承。

[0.2.0 发布准备记录](history/releases/0.2.0-readiness.md)保留旧门禁、提交和结果，只用于追溯。旧 Adapter 的远端仓库、标签和 Release 未在本次目录整理中修改；可在替代 Core 发布可用后设为只读归档。
