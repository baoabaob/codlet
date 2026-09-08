# 官方外观动态适配核对 — 2026-09-08

**现有适配已经动态继承客户端主题；本次修正了菜单入口用错文字层级的问题，并补全了部分外观偏好。** Codlet 不保存一份当前颜色/字体快照，也不读取或复制用户的外观配置文件。客户端修改有效 CSS 变量后，适配层与采用它的 GUI 由浏览器重新计算样式。

## 原因与修改

用户指出 Codlet 字色比旁边的官方菜单深。安装包 `26.901.6511.0` 的原菜单定义位于 `webview/assets/app-initial-f87238153a19.js:6355`：未打开时使用三级文字色，hover/focus 使用 description 色，打开时才使用正文色。原适配层已有正文和三级颜色别名，但 GUI 将入口与面板统一设为正文色，因而产生色差。

本次将菜单默认、hover/focus、打开状态分别映射；面板正文仍使用正文色。hover 背景采用官方菜单的前景 5% 混合，打开背景保留原生选择色。入口按原菜单 4px/10px 内边距与透明 1px 边框自然排版，高度随字号增长。普通状态字重与标题/标签的中等字重改为原生变量。

面板按钮和开关原先写死 `cursor: default`，现在读取客户端的交互光标偏好。开关动画原先只检查系统 media query；现在优先使用客户端 `data-reduced-motion` 的明确选择，缺省时才跟随系统。所有原生属性名和根属性判断都保留在适配层，GUI 只消费 Codlet 别名。

## 动态继承范围

| 用户设置/样式角色 | 连接方式 |
| --- | --- |
| 浅色、深色、背景、前景、对比度 | 客户端生成当前主题变量；面板 surface、正文、描述、边框、菜单选择色均引用这些变量。 |
| 强调色 | `--codlet-ui-accent` → `--color-chart-blue` → 当前客户端强调色映射。名字中的 blue 不代表固定蓝色。 |
| UI 字体和字形 | `--codlet-ui-font` → `--font-sans` → `--vscode-font-family`；客户端字体设置及异步字体加载更新此链。 |
| UI 字号 | 基准、小字、说明、标题分别引用 `--text-base`、`--text-sm`、`--text-xs`、`--text-heading-md`。 |
| 字重 | 普通/中等字重引用原生对应变量。 |
| 鼠标指针 | 面板控件引用 `--cursor-interaction`；标题栏菜单沿用官方菜单的默认光标。 |
| 减少动态效果 | 客户端显式开/关优先；未设置时跟随系统偏好。 |

字体配置应用代码在同一 JS 文件第 8224 行，对 documentElement/body 设置变量；基础 CSS 的 `--font-sans`、主题色和尺寸引用链已核对。代码字体、内容字体分别属于客户端的代码/内容角色，不能把它们不加区分地用于菜单和普通 UI。当前 Codlet GUI 没有代码编辑器。

600px/420px 对话框宽度、开关尺寸、内边距等是所选官方组件变体的布局规则。它们保留为布局参数，不等于把主题固定成默认配色；这些参数也不意味着已经实现完整的官方组件库。

## 新增别名

原有 27 个别名保留，新增以下 8 个，共 35 个：

| 别名 | 原生来源/状态 |
| --- | --- |
| `--codlet-ui-menu-fg` | `--color-text-tertiary` |
| `--codlet-ui-menu-hover-fg` | `--color-codex-description` |
| `--codlet-ui-menu-hover-bg` | `--color-text` 在 OKLab 中与透明色混合，前景占 5% |
| `--codlet-ui-menu-active-fg` | `--color-text` |
| `--codlet-ui-font-weight-normal` | `--font-weight-normal` |
| `--codlet-ui-font-weight-medium` | `--font-weight-medium` |
| `--codlet-ui-cursor` | `--cursor-interaction` |
| `--codlet-ui-motion-duration` | `--transition-duration-basic`，减少动态效果时为 0ms |

样式仅匹配 adapter 自己的 mount 与显式带 `data-codlet-ui-theme="codex.ui.titlebar.afterMenu@1"` 的插件 surface。没有全局重设页面样式，不强制其他插件使用这些颜色、字体或动画。

## 验证

全部 63 项 Node 测试通过，涵盖新增别名、原生引用、motion 选择器的作用域和现有 GUI 生命周期。没有为本次 CSS 调整扩展 Host 或增加私有执行接口。发布构建成功。

同一已登录的实验目录通过 `--resume-from` 启动新 Dev/WebSocket 客户端，启动检查 1833ms。实机首个快照中 Codlet 默认字色已与相邻菜单的弱化文字一致，用户随后自行检查并反馈效果正常。用户接手窗口后自动点击暂停；本轮没有完成自定义字体、颜色和字号每一种组合的逐项实机量化检查，动态继承结论同时依据上述实际 CSS 引用链。之前的明暗主题与窄窗实测见 [GUI 修复记录](GUI_REPAIR_2026-09-08.md)。

测试时出现的“调试”侧边项与 Debug 面板来自官方客户端：`allowDebugMenu` 检查 build flavor 的 internal 条件，renderer 通过 `electronBridge.getBuildFlavor()` 获取该值。实验 harness 以 `BUILD_FLAVOR=dev` 启动，故这些入口可见。它们不是本次 Codlet 实现的功能，普通 `codlet launch` 没有新增开启 Dev 模式的行为。

本机产物保留在 `.codlet-artifacts/appearance-followup-2026-09-08/`；原生源码副本与机器证据不提交 Git。
