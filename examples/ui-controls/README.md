# Shared UI controls

普通 isolated-world Renderer 示例，只申请 `ui.dom`，依赖 `codex.ui.appearance@1` 和 `codex.ui.titlebar.afterMenu@1`。不申请插件管理或 Desktop 后端写入能力。

菜单栏的 **UI** 按钮打开设置面板，展示开关、计数按钮、600 ms 加载状态、错误提示和二级确认弹窗。重置前默认聚焦 Cancel。开关和计数都只修改示例内存状态。

启用内置 Codex UI Adapter 后，将本目录作为本地插件添加，授权 `ui.dom`，再启用 `example.ui.controls`。需要本批次或更新版本的 managed renderer runtime；旧运行时没有 `context.ui` 时会报告明确错误。

控件通过 `context.ui.create(appearance)` 建立独立所有者。`ui.on`、`ui.after`、`ui.remove` 和 `ui.dispose` 负责资源生命周期；关闭弹窗会恢复焦点，卸载会取消计时器、移除监听器和 DOM。插件通过 `ui.signal` 检查自行发起的异步工作是否已经过期。具体接口见 [UI 类型](../../types/renderer-ui.d.ts) 和 [开发说明](../../docs/UI_HELPERS_AND_NAVIGATION_2026-09-11.md)。

测试客户端中启停此示例后，检查原生输入框、Esc、Tab、确认取消、主题切换和窄窗口。原生私有选择器、主题变量或后端消息都不应出现在普通示例代码中。
