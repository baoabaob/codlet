# Core UI 容器与分屏内存审查

2026-10-13。包含消费者 popup 局部 app-region 修正的当前候选，已获用户手动确认：进入分屏后可以正常拖动窗口。当前 Core 没有给 UI 容器或 popup 层设置 `app-region: no-drag`，本轮无需增加 Core 拖窗补丁。分屏中的 UI 容器和 Native transcript 都挂在现有页面里，不会因每增加一个面板就启动一份完整客户端。面板仍会增加组件、DOM、订阅、历史及绘制资源，实际增量由主验收方在同一实例内测量。

本轮只读审阅 Core、消费者源码及冻结 bundle，并运行离线检查。现有 Native 实例、用户会话/草稿、消费者与 Adapter 文件均未修改；没有部署或重启。源码结论不能代替该实例的最终窗口命中验证。

## 容器和拖窗范围

| 路径 | 实际职责 | 对拖窗结论的约束 |
| --- | --- | --- |
| [Core container](../../../frontend/src/runtime.jsx:106) | 创建 `div`；styled 容器加 `data-codlet-official-ui` 和主题，neutral 容器加 `data-codlet-react-ui` | 无 `app-region`、窗口几何、全屏定位或鼠标拦截声明 |
| [Core mount](../../../frontend/src/runtime.jsx:114) | `ReactDOM.createRoot(node)`，通过 context 指定 portal 目标和 Escape scope | React root 是当前 document 中的组件树，不是 OS 窗口或进程 |
| [CSS build](../../../frontend/build.mjs:74) | SDK 选择器限定在 styled 容器内，命名空间隔离动画、变量和 cascade layer | 当前编译 CSS 和 UI bundle 均无 `app-region` / `no-drag` 声明 |
| [Core page overlay](../../../frontend/src/page.js:47) | 创建 styled overlay，设置 `display: contents` | Core 页面 API 没有创建全屏 `no-drag` 面 |
| [消费者 UiRegion](../../../../codlet-split-workbench/src/native.js:13) | 在一个 React 树内 portal 到可复用的 styled DOM 容器；容器 `display: contents` | UiRegion 本身不调用 `createRoot`，也不创建应用运行时 |
| [消费者 popup](../../../../codlet-split-workbench/src/native.js:31) | neutral root 的同级 styled popup，以及普通 styled root 内的 OwnedPortals，均使用 `position: fixed; inset: 0; pointer-events: none` | 全屏定位由消费者指定；Core 未声明 app-region，但容器仍需检查祖先继承 |
| [消费者 CSS](../../../../codlet-split-workbench/src/styles.css:20) | `.csw-workspace`、composer dock、selected target、composer mask 设 `no-drag`；另有按钮规则 | 需要核对这些元素的实际矩形、可见性、transform、裁剪及与 Native 标题栏的重叠 |

冻结消费者 `consumer-b1cdf35b-ab49-4d27-a1f1-377f0734c4e6/consumer/renderer.js` 中相应 UiRegion、popup 与 CSS 路径也已核对；并非仅根据当前源码推断旧 bundle。消费者 renderer 与 Adapter renderer 的 SHA256 均匹配其冻结清单。

`pointer-events: none` 只能说明 DOM 指针命中行为，不能据此证明最终 Native caption 区安全。Electron 的公开契约将 `no-drag` 定义为从可拖动矩形中排除的区域；它不是普通按钮事件监听器。因此现场需要同时检查 app-region 与几何，而不能只看 `elementsFromPoint` 或透明度。[Electron 窗口交互文档](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)

该文档只提供一般契约参考；当前客户端的 Owl 原生命中实现没有在本轮验证。应在拥有全屏 popup 几何的消费者层处理继承范围，不要给所有 Core 容器强加 `drag`、`no-drag`、Native 专用标题栏高度或窗口移动逻辑。

后续只读现场 [report.json](../../../../codlet-split-workbench/.checks/native-comparison/dev.split-workbench.inspect-a65e7ef6-a60e-4397-8974-778ce46dc878/report.json:958)（北京时间 2026-10-13 16:58:48）缩小了范围：中性根 popup 的 computed `appRegion` 为 `none`，矩形为 1774×1100；mask/target 普通 styled root 内两个 `csw-portals` 的 computed 值均为 `no-drag`，与其消费者祖先声明一致，且 `pointerEvents` 都为 `none`。该次记录中 mask/target 为 `display: none`、子 popup 矩形为零，因此它还没有记录到这两个 popup 展开后覆盖标题栏的几何，更不是 OS 拖窗失败的因果证明。

消费者已增加 `.csw-portals {-webkit-app-region: initial}`，将明确的 `no-drag` 保留在实际 menu/listbox/dialog/menuitem/button/link/input 等控件上。后续候选的 [只读现场](../../../../codlet-split-workbench/.checks/native-comparison/dev.split-workbench.inspect-e981ee24-547e-4e80-9c69-6314127c78a5/report.json:2508) 确认三个 popup 的 computed 值均为 `none`；[Computer Use 记录](../../../../codlet-split-workbench/.checks/native-comparison/consumer-3aea99bc-daa6-4ccd-b32e-994527fd6d24/feature-layout-ui.md:16) 中，8 面板下三个标题栏点各拖动 40×20 都没有移窗。后续用户手动对照证明这套 CU 操作不能可靠判定 caption 行为，因而不能据此判定分屏修复失败。消费者 popup 的继承问题已消除；主验收方标记为 c89 的当前候选包含此修正，用户已明确反馈“目前进入分屏后也可以正常拖动窗口了”。分屏拖窗据此记为用户实际手动确认通过，不将旧 CU 记录改写为自动验证通过。

### 隐藏的 Native 全屏 MAIN

[18:15:48 的只读记录](../../../../codlet-split-workbench/.checks/native-comparison/dev.split-workbench.inspect-e981ee24-547e-4e80-9c69-6314127c78a5/report.json:957) 中，`captionBlockers` 第一个元素为 Native `MAIN`，类名 `flex h-full min-h-0 flex-col overflow-hidden bg-surface no-drag`，矩形 `(0,0,1774,1100)`，computed `visibility:hidden`、`pointerEvents:none` 且处于 inert 子树；后代 WEBVIEW 也为 hidden。该字段是 DOM 候选清单，不是 Native 最终命中区域列表。主验收方的 DWM/DPI 记录与 CU 截图矩形一致，降低了几何换算错误的可能性，不能单独认证 caption 命中。

在安装包 26.1007.2314.0 中找到了精确类名来源：[surface-e94d8e1db29a.js](../../../.codlet-artifacts/native-hidden-caption-review-2026-10-13/surface-e94d8e1db29a.js)。这是 Native authenticated ChatGPT webview surface：MAIN 内有返回 ChatGPT 的 draggable header 和 WEBVIEW，组件在 webview 脱离 document 后才排队调用其 destroy。该组件本身没有设置 MAIN 的 hidden/inert，隐藏状态来自外部控制或继承；仅凭此工厂不能确定当前外部控制者。静态提取未执行包内 JavaScript，文件 SHA256 为 `9d1409ac1e38b93932aaf021cfafa594b6e1ab5105457c155b86ff94de0d2d96`，完整清单见 [manifest](../../../.codlet-artifacts/native-hidden-caption-review-2026-10-13/manifest.json)。

当前上游 Chromium 的 `LayoutObject::AddDraggableRegions` 在收集矩形前先排除 `visibility` 非 visible 的对象及非 box；随后排除 region mode 为 none 的对象，才记录 drag/no-drag 矩形。这段路径没有用 pointer-events 或 inert 作为过滤条件。因此不能把本次 **hidden** MAIN 的全屏 no-drag 值直接当成有效阻挡证据。[Chromium 区域收集代码](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/layout/layout_object.cc)

这是上游代码审查，并未证明 Owl fork、已发送区域缓存或 guest WebContents 生命周期完全相同。宿主 DOM 的 hidden 状态也不提供 guest 内部区域/原生命中信息。当前没有依据修改这个 Native MAIN、删除 WEBVIEW、清除其 class，或添加 Core/Win32 拖窗替代逻辑。

同一 CU agent 随后的 [Native 零面板对照](../../../../codlet-split-workbench/.checks/native-comparison/consumer-3aea99bc-daa6-4ccd-b32e-994527fd6d24/feature-layout-ui.md:40) 已记录：退出工作台且移除 probe 后，相同三个空白标题栏点仍不移窗；分屏内横/竖分隔线拖动则成功。随后用户亲手确认 Native 原生页面可以正常拖动，主验收方于 2026-10-13 回传该结果，之后又回传用户对当前分屏候选拖窗正常的确认。此前零面板和 8 面板的 CU 负结果属于本次自动拖动方法的验证局限；普通格栅拖动成功也不能校准非客户区拖窗输入。零面板仍是同一加载过插件的实例，不等同于全新且 Core/Adapter 关闭的基线。Core/Win32 无需因此修改，不再追加 caption 自动复测；本项通过范围限于用户确认的当前候选与当前现场，不扩展为其他功能或所有环境的验收。

## 每个面板增加什么

- Core 的 UI factory 在 renderer bootstrap 中延迟加载并缓存；`ui.create()` 创建 owner 的容器/roots 集合、主题观察器和清理注册。同一 factory 的 style 元素由 owners 计数共享。[bootstrap](../../../bundled/runtime/bootstrap.js:486)、[UI lifetime](../../../frontend/src/runtime.jsx:57)
- 单个 `ui.container()` 只分配 DOM 和主题属性；调用 `mountReact()` 才创建 React root。多个 UiRegion 复用同一消费者树，不会每个区域再加载 React。
- Native transcript 使用现有 Native React、provider、conversation manager 和 history 读取路径，为每个视图建立 root、内容组件、订阅、scroller 和就绪观察器。历史请求按 thread 去重；可选样式隔离是 Shadow DOM 加 Native 样式链接，不是 iframe、WebContents 或新进程。[transcript](https://github.com/baoabaob/codlet/blob/main/codex/frontend/src/adapter/workspace-transcript.js#L14)、[shadow](https://github.com/baoabaob/codlet/blob/main/codex/frontend/src/adapter/workspace-shadow.js#L31)
- 当前 `native-navigation` 输入方案导航/绑定 Native 主输入器；消费者没有为每个面板创建完整 editor。[NavigationInput](../../../../codlet-split-workbench/src/navigation-input.js:8) 冻结 build 也记录 `additionalEditors: 0`，这表示方案配置，不是进程内存实测。

所以“多一个面板就复制整个客户端、内存直接翻倍”不是这些挂载路径的实现方式。这不等于每个面板成本固定或可忽略：长历史、附件预览、语法高亮、渲染缓存和并行活动会影响增量；同一 renderer 内也可能出现显著增长。卸载视图会移除其 root/观察器/DOM，Native manager 中已加载历史与运行时缓存不一定立即释放，退出工作台后的私有内存不必精确回到初始字节数。

## 由实例 owner 执行的内存对照

复用现有 [sample-process-group.ps1](../../../scripts/native-core/sample-process-group.ps1) 和 [process-ownership.ps1](../../../scripts/native-core/process-ownership.ps1)，无需再引入一个采样器。每次调用固定 60 秒，只读取进程计数并写入新 JSON；不会改变 UI、发送消息或读取会话正文。

1. 先按 owner 的既有流程重新确认当前 coordinator、Target 与完整 roots。向 sampler 传入**新鲜** evidence，其 `processes` 为 `{pid, filetime, image}` 数组；`filetime` 保持十进制字符串。不要从本说明复制历史 PID，也不要将缺少根身份的记录当证据。
2. 为普通单会话 A、N 面板 B、退出工作台回到原页面 A2 各保留一个唯一的新输出。统一窗口/DPI、可见性、历史/附件规模与相近活动条件，先等布局/加载稳定；记录阶段元数据及前后实际面板数。使用真实已有内容时，不要清空历史或草稿来制造基线。
3. 以每份 JSON 的 `before` / `after` 分别求和 `live === true` 的 `privateBytes`，除以 `1024*1024` 得 MiB。两个端点分别展示，不称为 60 秒平均值或峰值。主要比较 B−A、B/A，以及 A2−A；也列进程数与新增/退出的 PID+创建时间身份。
4. `workingSetBytes` 可辅助看驻留量，但跨进程相加可能重复计算共享页，不能标为“实际独占物理内存”。`privateBytes` 是不能与其他进程共享的已分配内存，也不是实际驻留 RAM。[PrivateMemorySize64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64)、[Windows working set](https://learn.microsoft.com/en-us/windows/win32/memory/working-set)
5. 如需判断是否持续泄漏，在内容/活动相近时再做少量同样的开关循环，比较退出后的趋势和消费者资源数。单次高水位不能单独确认泄漏；不能通过强制 GC、清缓存或终止子进程改善读数。退出工作台后的内存采样和关闭整个客户端后的身份退役是两项不同检查。

sampler 会固定 roots 的 PID、精确创建时间和 image，保留进程句柄；每轮 CIM 图检查父子创建时间并复核打开句柄后的创建身份。它记录父子边、roots、采样时间及脚本 SHA；不会按进程名字筛除“看起来无关”的进程。根退出或身份不匹配会失败，不应用旧值补齐。

限制：两次端点扫描遗漏期间出生又退出的进程，以及发现时父进程已消失的新子进程；采样组不包括外部共享服务/未证明归属的独立进程。这份工具适合比较已确认进程组的稳态，不提供全系统精确峰值或单面板专属内存。60 秒内若用户继续生成内容，应记录活动并避免将差值全部归因于面板。

## 验证与版本

本轮既有 UI scheduling/lifetime 回归 7/7 通过；进程归属离线回归 15/15 通过（含 3 个 mocked collector 调用）。前者使用 jsdom 且不执行真实 CSS cascade/窗口命中，后者替换所有进程查询与等待；均不能算 Native 拖窗或实际内存测试。本轮没有改动产品源码或采样器。

| 文件 | SHA256 |
| --- | --- |
| `frontend/src/runtime.jsx` | `693d425458e1d847510f8a70fef287486ac619136f57b1aab04c7ffa575214f0` |
| `frontend/build.mjs` | `2d40897b0dc0f4189386a0844d2efdd968c1f758f13596caa2270b3d000a4255` |
| `frontend/.build/runtime.css` | `45538cd682d9e8e9c0cdb3f774c472faa77cb20c9f46a8b050d2d51a3c506a7d` |
| `bundled/runtime/ui.js` | `e7644939e6d08415fac865a3019b676485b75375d41d69f9efcc11968731d78d` |
| `sample-process-group.ps1` | `786565dc48e50177b1f31dbcdba4ffbf8d35413eca84ea5e27db60a14b2bb119` |
| `process-ownership.ps1` | `ee4ccc8f543e48c231a5f8e33bd45d16d39c2b9a7b2d399e35f31217524e4e28` |
| 冻结消费者 `renderer.js` | `5743534f82cb305dd748583cc4a7a9cf52a21df4bbcc258611f9218397e271f0` |
| 冻结 UI Adapter `renderer.js` | `1af5784ab9ed4de0ae54fd08f28a0a98394a0df6bd27d16bd38d96397944f2c8` |

这些是本轮所读文件的身份；没有据此声称当前 live Core 二进制与整个工作区逐字节对应。冻结 bundle 与历史证据均保持原样。
