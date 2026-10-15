# Native 标题栏拖动：静态源码核对

2026-10-12（Asia/Shanghai）。本轮只读观察记录、现有启动记录、Core 源码和固定安装包。没有启动或操纵客户端，没有修改 Native/Core 窗口逻辑。为便于复核，仅新增本文及静态提取副本。

结论：**有源码依据说明窗口拖动依赖明确的拖动区域，但没有证据把两次失败归因于分屏、Core、Native 或 Computer Use 中的任何一方。** 下一步应核对同一点的实际命中和真实鼠标对照，尚不支持修改窗口逻辑。

## 观察证据

实例为 Native `26.1007.2314.0`，lab SHA256 `89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`，coordinator `1791815522339-44336`。历史 Desktop PID 59360、FILETIME `134362891289616551`、HWND 5900302 已退出，不能用于后续控制。

- [零面板观察](../../../../codlet-split-workbench/.checks/native-comparison/consumer-a556e483-20fa-4e02-9dc3-0fd2c801e1e9/ui-observations.md)：标题空白处 `(600,18)→(640,48)`，窗口 origin 保持 `(907,277)`；原生侧栏收展成功。
- [五面板观察](../../../../codlet-split-workbench/.checks/native-comparison/consumer-e8225b49-4a19-481b-9c12-2585735bfa79/ui-observations.md)：另一空白处 `(1040,18)→(1080,58)` 也未移动窗口；面板排序、自由移动、resize 及侧栏收展成功。
- [最终内部快照](../../../../codlet-split-workbench/.checks/native-comparison/consumer-e8225b49-4a19-481b-9c12-2585735bfa79/driver/command-1791816641298-b7707184-b916-44a1-aec2-0b6c5b8e5d1b.result.json)的 `visibility=visible`、`eventCount=37`、consumer 边界 `(341,96,935,570)`，与本次前台关联相符；它不包含两个拖动起点的 computed app-region、原生命中结果或鼠标按下/移动/释放时序。

两次观察不是同坐标、同页面状态的配对实验：第一次在 home，第二次在 synthetic session 且装有五面板。失败已出现在零 Adapter/consumer 基线，因此不支持“分屏引入窗口无法移动”。交互成功也不代表非客户区或窗口拖动通道必然正常。

## 固定安装包中的依据

从该版本 `app/resources/app.asar` 静态读取字节，没有导入或执行其中代码。副本及每个文件的 SHA256 见[提取清单](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/manifest.json)。主进程文件摘要与此前审核副本一致。

| 位置 | 可确认的内容 | 不能据此确认的内容 |
| --- | --- | --- |
| [main-BklS_2Y2.js:1544](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/main-BklS_2Y2.js) | `createPrimaryWindow` 使用 primary appearance；`z9` 的 Windows primary 分支设置 `titleBarStyle: hidden`、`titleBarOverlay: j9(windowZoom)`；overlay 高度为 `round(36 * zoom)`。 | 两个旧测试点的实际原生命中、有效拖动矩形，或所有空白点都可拖动。overlay 高度不能直接作为截图坐标边界。 |
| [app-shared CSS:1](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/app-shared-9a94b907ed47.css) | `.draggable` 设置 `-webkit-app-region: drag`；其中按钮及 application-menu-bar 内的规则设为 `no-drag`；`.no-drag` 也明确排除；另有 `initial` 重置工具类。[index.html:139](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/index.html)直接引入这份 CSS。 | 当时覆盖测试点的元素、祖先、布局分支和最终区域合成结果。 |
| [app-initial CSS:1](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/app-initial-99e8b4b455fa.css)及 [JS:1697](../../../.codlet-artifacts/native-window-drag-review-2026-10-12/app-initial-b8e1c8014bb4.js) | 应用菜单顶栏/部分 toolbar 声明 drag；按钮 no-drag；特定标题栏及分栏布局重置 toolbar 的 app-region。标题栏容器还有 pointer-events、inert、clip、位置及高度条件。 | 仅凭截图空白或单个 class 判定有效拖动命中。DOM 样式声明也不能替代最终原生区域。 |
| 安装包 `resources/owl-electron-app.json` | `runtimeName=owl`，runtime archive SHA 为 `7b8fe683aa175cb3a63e942792c833569466f95d237e527b765e03b5fba4ecdc`。 | 本次没有 Owl Windows 二进制的原生命中/拖动实现源码，不能把一般 Electron 行为当作此运行时已经验证的实现。 |

所查主进程 JS 未找到 `setMovable`、`movable:false` 或针对主窗口 `will-move` 的阻止逻辑；存在宠物窗口自己的 move 处理。这是所查 JS 的范围结论，不是对 Owl 内部实现或运行时全部状态的排除证明。

## 启动器与 Core

部署目录中的 lab 二进制摘要与上面的 89c5…一致；部署的 `isolated-client.mjs` 与当前工作区文件摘要相同，均为 `d95e9de81eaed41d9237b6cc6804800a1e3999b8682d8f7f809cde6e33f9688c`。

- [协调器](../../../scripts/isolated-client.mjs)传入实验 root、固定版本、专属 backend URL、resume 等参数。历史 `child-environment.json` 确认 dev、隔离路径、专属 WS、更新关闭及功能 overrides；其中没有窗口不可移动或标题栏禁用项。dev/隔离环境本身仍是与日常客户端不同的条件。
- [lab 启动](../../../src/lab.rs:332)的额外客户端参数只来自可选 startup trace；[Desktop 进程创建](../../../src/windows/process.rs:336)明确 `no_window: false`，底层另加 CDP pipe 参数。[源码第 510 行起](../../../src/windows/process.rs:510)可复核参数构造。协调器的 `windowsHide` 和 PowerShell `WindowStyle Hidden` 不能据此解释为 Desktop 被设置为不可移动。
- 在所查 Core 的 Windows、CDP、renderer 及 UI runtime 源码中，没有发现设置原生 titlebar/app-region、movable、窗口位置或非客户区命中规则的路径。UI 样式及 React 挂载按插件创建；[runtime.jsx](../../../frontend/src/runtime.jsx:57)没有全窗口拖动拦截逻辑。这里是静态审查，没有对 89c5…二进制做完整源码重建或逐字节行为认证。
- 零插件不等于没有 Core：[历史 report](https://github.com/baoabaob/codlet-plugins/blob/main/.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/profile/logs/run-1791815523625-17092/report.jsonl)记录 `plugin_count=0`、isolated world attempted=0，但 CDP 已连接。[Core attach](../../../src/renderer.rs:394)也会建立会话/RPC，并尝试安装 runtime skill；[lab management](../../../src/lab/management.rs:58)启用该功能。因此现有基线没有隔离掉所有 Core/CDP 影响。

## Computer Use 的边界

安装包附带 `@oai/sky` 的 Windows JS wrapper 把 `drag` 转发为 window、from/to 坐标及可选 screenshotId，未在这一方法暴露按下停留时间、移动步数或释放节奏。低层输入由 transport/helper 处理。这份可见 wrapper 没有提供本轮实际原生消息序列，也没有证据证明用户本轮加载的 wrapper 字节与此副本相同。

所以不能把未移动解释成输入根本未发出、Native 主线程卡住、必然击中了客户区，或确定的工具时序缺陷。现有证据也不能量化 input-to-paint 或稳定分位。

## 最小后续实验（仅建议，本轮未执行）

1. 下次另获前台验证授权时，只用一个重新建立身份的独立实例，在同一个 synthetic 页面保持零临时插件和固定窗口状态。重新关联 PID＋创建时间、HWND、Target、截图，不复用上述历史 ID。
2. 动作前用只读快照记录窗口与 viewport 几何、DPI/缩放、候选顶栏元素及覆盖层的矩形和 computed `app-region`、pointer-events、inert；明确截图窗口坐标与 CSS 坐标的换算。选一个视觉空白、声明 drag、没有已知 no-drag 覆盖的点。该检查仍只是候选命中依据。
3. 在这个**同一点、同页面、同窗口状态**各做一次正常 `sky.drag` 和用户实体鼠标拖动。每次记录前后独立截图及窗口位置；如首次移动成功，后一次用新截图定位同一顶栏元素内的位置。保持草稿不变，不增加面板矩阵，不用改 CSS、伪造 DOM 事件或程序直接移动窗口来代替拖动。

若实体鼠标能移动而 sky 不能，优先核对工具的坐标/输入序列，仍不直接判定具体时序 bug；若两者都不能，继续检查有效拖动区域及 Native/Core 状态，不先改窗口逻辑；若两者都能，保留旧失败记录，只能说明未稳定复现。要进一步归因 Core，还需要单独设计保留隔离条件的接入前后对照，现有零插件基线不足以回答。
