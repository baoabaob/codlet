# Core 渲染成本与嵌入视图评估

日期：2026-10-11。已交付 Core 源码、离线基准、新版独立 Native 启动适配及 [release 后台矩阵](core-native-background-2026-10-11.md)：72 场景、12 组 idle 和退出检查完成。前台呈现与 Native 输入响应尚未验收。未安装或发布到日常实例。

生成的 UI bundle 从 HEAD 的 716,360 字节变为 717,389 字节（+1,029 字节，含 notices）。UI factory 仍加载同一份 React/SDK 并安装旧有主题监听；中性挂载不承诺省掉整个 SDK 初始化。多个 root 共用这份 Core React 实例，但仍有各自 root 和容器成本。

## 成本定位及最小接口

此前 `frontend/src/runtime.jsx` 对每次 render 使用 flushSync；新建容器会对所有容器读主题并重复写属性。样式编译已经限制在 data-codlet-official-ui 下，但把 Native 正文放进该 scope 仍会受到 reset/utility 影响。这些是明确的 Core 成本，尚不能解释整个客户端卡顿比例。

新增 `mountReact(container, content, {sync?, onCommit?, overlay?, scope?})`，默认交给 React 调度。render 返回请求 revision；中间请求可合并，只有真正提交的 revision 回调。onCommit 是父级 layout effect 回执，表示这次树已进入 commit；不保证全部 passive effect 完成、不代表绘制或 Native 输入器 ready。只在传入回调时增加 Commit 组件，不创建性能 observer、计时器、样本或磁盘写入。消费者自己的组件订阅更新不会产生新的请求 revision。

首次请求 revision 为 1；sync 模式可能在 mountReact/render 返回前回调，勿在回调中访问尚未赋值的句柄。scope 接受 `{contains(node):boolean}`，可以覆盖正文、独立控件及 overlay；该组合已通过共享 state、Escape 和单 root 清理测试。

旧 API 2 `mount` 保持同步，避免破坏立即查询 DOM、设置初始焦点等既有调用。`mountReact` 默认不同；确需在返回前查询 DOM 的调用可明确 `{sync:true}`，或将测量/焦点操作放到自己的 layout effect。`page.js` 保留旧挂载行为；没有证据将它强行异步化。后续 major API 可以统一默认行为，本次不偷偷改变旧 consumer。

因此现有仍调用 mount 的 consumer 不会自动获得调度收益，需要独立迁移到 mountReact 并验证 ready/焦点语义；本次没有修改 Adapter 或分屏仓库。主题重复写入优化则对既有 styled 容器直接生效。

`container(parent, {styled:false})` 创建中性、同 owner 的挂载节点。SDK 控件可单独放入 styled container，再用 createPortal 进入同一个 React 树；Native 正文无需额外 root。中性节点必须位于 styled scope 之外：如果祖先已有 data-codlet-official-ui，后代仍会匹配 CSS。这不是 Shadow DOM 隔离，也不会隔离 Native 的全局副作用。overlay 和 Escape scope 默认是 mount 节点；混合页面应显式传入正确 scope，不能把样式范围当作交互归属证明。

主题只对 styled 容器处理；每次通知只读一次 host token 集合，完整主题值未变化时跳过所有节点写入；创建新节点仅初始化该节点。真实主题变化增量比较属性。observer 仍按旧 host 兼容范围监听 head/root/body，未据此承诺零样式读取。`removeContainer` 幂等同步卸载并从 owner 集合释放节点；只调用 DOM remove 会保留 owner 引用直到 dispose，因此频繁创建销毁应使用该方法。unmount 同步取消待提交工作、执行 React 清理，容器可复用；并不等待 Native 草稿持久化，Adapter 的 close Promise 仍应交由 Core onCleanup 等待。

不增加分屏、选择、布局、输入互斥、缓存或预热 API。Adapter 可直接使用 Core 能力；本轮接口不要求其再封装这些能力。

## 可复现验证

在仓库根目录：

```text
cd frontend
node build.mjs
npm run typecheck
cd ..
node --test tests/ui_scheduling.test.mjs tests/ui_helpers.test.mjs tests/bootstrap_ui.test.mjs tests/bootstrap_helpers.test.mjs tests/page_registration.test.mjs tests/core_native_plan.test.mjs
node scripts/check-core-ui-isolated.mjs
node scripts/check-core-ui-isolated.mjs --baseline
node scripts/benchmark-core-ui.mjs .codlet-artifacts/core-ui-offline-2026-10-11.json
```

复审后相关 UI/生命周期测试 34 项通过，Native 启动预检测试 3 项通过；类型检查及 bundle 构建通过。旧 ui_helpers 实际含 21 项（此前 regex 枚举漏掉 6 个动态用例），现整文件执行，21/21 通过；HEAD 原始 bundle 对照同样 21/21。两项 portal/tooltip 超时由 jsdom+nwsapi 2.2.27 的原生状态 selector 递归导致，调试栈为 Element.matches → isFullscreen → Element.matches。fixture 对不支持的 :modal/:popover-open/:fullscreen 明确返回 false；这不验证 Chromium Native 顶层布局，未修改产品选择器代码。

复审用失败回归测试确认并修复主题缓存竞态：缓存 light → 同一 task 切 dark 并建新容器 → 恢复 light；原实现跳过全量同步而让新容器停留 dark。定向创建现在使全量缓存失效，后续通知按最终 host 主题核对所有节点。另补异步更新不重挂子组件、sync override、dispose 取消晚到 commit、异常 cleanup 释放容器、跨 owner 隔离，以及中性 root/控件 portal 共用状态测试。

基准默认不运行，使用固定 20/200/2000 项合成节点（循环 pre/button/aside/p）与相同 React element；0/1/2/4/5/8 root，各 5 轮 × 20 请求。先等待初始 commit，再完成 5 次 warm-up，最后等待全部末次请求提交；超时、请求核算不平或资源未恢复会失败。报告保留 bundle/fixture/benchmark SHA256、实际依赖版本、runId、样本量及 P50/P95/P99/max，分别列 render 请求、对应 revision commit 延迟、创建和同步 cleanup，明确计数合并与取消。创建和销毁仅每 root 一次，样本量小，不能用这些尾分位推断生产分布。fixture 的 i18n observer 单列为基线，检查 UI 自有 observer/media listener 归零。

最终完整数据见 [core-ui-offline-2026-10-11.json](core-ui-offline-2026-10-11.json)，bundle SHA256 为 `e7644939e6d08415fac865a3019b676485b75375d41d69f9efcc11968731d78d`。18 个场景清理后 UI 自有 observer/media listener 增量均为 0；同 props render 请求 P95 为 0.065–0.128 ms，commit 延迟 P95 为 16.44–47.42 ms。后者受此 Node/jsdom 环境调度影响，绝不可用前者宣称切换在 1 ms 内完成。相同 React element 会触发子树复用，不能代表流式文本更新成本。8 root 各 fixture 为 800 次请求、403 次实际 commit、397 次合并、0 次取消。

主题未变时零容器 mutation、主题变化传播、新节点不重写旧节点、中性节点无 scope/主题 style、取消待提交工作、同步选择、容器复用/销毁通过逻辑测试。未测 Native 按钮响应、长任务、实际帧间隔、60 秒进程组 idle CPU、Native retained heap/草稿；jsdom 延迟包含 Node 调度和测试等待，不能证明整窗流畅或 Native 绘制改善。不能拿 request 返回耗时冒充 commit/输入 ready。

## 单窗口内独立嵌入视图

静态核实使用留存构建 26.1002.7124 的 assets/main-p91kJShj.js，不能视作当前日常客户端版本。源码第 1323 行处理 open-in-new-window，经窗口打开函数进入第 1540 行的 WindowManager createWindow：new m.BrowserWindow、webPreferences/preload、webContents 诊断、registerWindow、initialRoute 及加载。第 1540 行注册维护 window/webContents ID、hostId 和 appServiceWindowIds，并调用 onWindowRegistered；应用组装处把它接到同一个服务的 registerWindow。第 1297 行服务 registerWindow 创建面向该 webContents 的 oY 通信处理器。因此“新窗口”复用应用协调服务的判断有源码依据，而非为每个窗口重新启动整个后端。

该主进程源码 SHA256：`aafd6a750458cb39b6202f9be00231482122d32ac14017b79d544c4ab741e889`。只读取留存文件，没有执行其中模块。

该 bundle 第 995 行已经用 WebContentsView 做下载相关视图，但这条路径只有 session/sandbox 等配置，不等于具备 Native 会话上下文。第 1540 行窗口服务依赖 BrowserWindow 的窗口身份、外观、焦点、关闭和菜单；不能把 view.webContents 塞进 registerWindow 就宣称接入完成。当前 Core 公共类型没有嵌入 Native view 的创建和管理能力。

Electron 官方 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 确认主进程创建并挂到窗口 contentView；[process model](https://www.electronjs.org/docs/latest/tutorial/process-model) 说明 web embed 有 renderer 成本；[BaseWindow resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management) 要求显式关闭子 webContents，关闭父 BaseWindow 不自动释放它们。

| 维度 | 同页小组件 | 独立嵌入 Native view |
| --- | --- | --- |
| 渲染执行 | 共用主页面线程，组件长任务会影响原生按钮 | 有 renderer 隔离机会；主进程、GPU、共享协调服务仍可能阻塞，必须核实实际 PID |
| 初始化 | 已存在 Native 模块和上下文，增量组件/root | 新 document/preload/React/路由、页面缓存和订阅；须按 host/session 注册通信，不可复制未知窗口身份 |
| 主进程接入 | 无新增 Electron view 管理 | 生命周期、几何边界、DPI、焦点/IME、快捷键、菜单、弹窗/下载、权限、崩溃和退出清理均需适配 |
| 资源 | 增量组件、监听和 root | renderer heap、代码初始化、DOM、视图合成表面、IPC/订阅；共享 session 不代表共享 JS heap |
| 当前证据 | Core 离线逻辑已验证，Native 成本待测 | Electron 架构可行，Native 完整接入未实现、CPU/内存和接入工时没有测量结论 |

故不预设采用嵌入 view，也不把“隔离”当作“轻量”。下一轮公平对照应同 bundle/fixture/视口，测主页面+1/2/5 组件与主页面+1/2/5 view 的冷加载、按钮 P95 增量、实际 PID、CPU 秒、working set/heap/GPU、60 秒空闲和退出恢复；不把独立 renderer 误报为独立后端或独立会话数据。

## Native 验证边界

新版 26.1007.2314.0 已完成 20 项精确源码检查、lab 兼容修复和真实隔离启动；当前独立 run 为 `core-e674f238-bc43-483c-bdb1-8b90802cbe3e`，原生测试窗口 PID 59936，状态 awaiting_authentication。进程/创建时间、专属后端、registry、数据路径和本次 Target 已核验，活动/归档会话为空，日常进程身份保持不变。身份认证及 Windows sandbox 首次初始化尚未完成，因此不把这次启动结果当作 Native 性能通过。详见 [环境适配报告](native-isolation-26.1007.2314.0.md) 和 [Native runbook](core-native-runbook.md)。原草稿恢复资料未读取或改写；没有修改另外两个仓库。
