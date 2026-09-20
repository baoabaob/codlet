# 用户选择官方 UI 后再阅读

Codlet 的 `context.ui` API 2 直接复用 `@openai/apps-sdk-ui` 的组件和图标。通过 `const ui=context.ui.create()` 取得 `ui.React`、`ui.components`、`ui.icons`，用 `ui.mount()` 挂载并在停用时 `ui.dispose()`。不要再造近似的按钮、开关、弹出菜单、搜索框或外观 CSS。

`runtime.json` 指向的 `types/renderer-ui.d.ts` 是当前完整类型和可用组件清单。需要主导航整页时声明 `codex.ui.navigation.page@1` 的 Target 依赖并用 `ui.page()`；普通 DOM 挂载不必依赖导航适配器。

按需读取 `docs/UI_COMPONENTS_2026-09-13.md` 和 `docs/OFFICIAL_UI_STYLE_2026-09-13.md`；具体 API 以附带类型为准。遵循客户端字号、页面宽度、间距、焦点、悬浮、键盘与深色模式。CSS 仅处理布局并使用现有变量，说明文字末尾不加句号。
