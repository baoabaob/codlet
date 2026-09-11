# UI helpers 与 Desktop 扩展（2026-09-11）

这一批提供可复用 UI 控件、当前窗口的本地任务选择、原生任务打开入口和提交拦截器诊断。Core 只增加可选的通用 DOM helper 工厂；Codex 的主题变量、路由和历史结构继续位于独立 Adapter 中。

## UI helpers

RendererContext 的可选 `ui` 为 API 1。消费者先通过 `codex.ui.appearance@1` 的 `describe` 获取外观描述，再调用 `context.ui.create(appearance)`。旧运行时没有这个字段时，消费者应报告需要更新。此扩展不改变 Core RPC、权限或 raw 模式。

外观描述包含 `api`、`available`、`themeToken`、有限的 `roles`、`nativeLayout` 和 `nativeTokensAvailable`。style 尚未挂载或已经卸载时 `available=false`。没有标题栏挂载点仍可使用外观；原生变量不可用时使用系统颜色和字体回退。所有样式限于主动加入主题与角色标记的元素，跟随 Native 主题、字号和减少动态效果设置。

`element`、`button`、`switch`、`row`、`status`、`dialog` 返回由当前 UI 实例拥有的节点或控制器。使用 textContent 写入文字；按钮必须有可访问名称。`on` 绑定本地事件；`busy` 在结束时恢复原有 disabled 状态；`after` 提供 0–60000 ms 的可取消计时器。上限为 4096 个节点、8192 个监听器和 64 个待执行计时器。

`dialog.show` 使用原生 showModal，支持指定初始焦点与返回焦点。Esc、取消、关闭按钮和边界外主指针统一进入可否决的关闭回调。二级确认应把初始焦点放到 Cancel。关闭后恢复存活的触发元素；整体卸载关闭所有 modal、移除节点并恢复外部焦点，保留更晚打开的原生弹窗。

`remove` 仅允许移除当前所有者的节点，连同其后代监听器一起清理。`dispose` 幂等，并通过 `onDeactivate` 自动执行；销毁过的对话框不能重新打开。自行创建的 Promise、请求或异步回调仍由消费者管理，完成后应检查 `ui.signal.aborted`。这不是权限边界或自动事务回滚。

Codlet 管理页与 [普通 UI 示例](../examples/ui-controls/README.md) 已接入同一套控件和主题角色；管理页保留自己的操作回执、忙碌状态与确认逻辑。接口见 [renderer-ui.d.ts](../types/renderer-ui.d.ts)。

## 当前任务与原生导航

`codex.backend.read@1` 增加 `selection.get`，返回当前窗口的本地 `threadId`、`activeTurnId`、`activeTurnKnown`、`resumeState` 和 `streamRole`。主页、设置或其他路由的 threadId 为 null。activeTurnId 只表示运行中回合；历史未加载、结构不支持或超过 4096 项的边界时，activeTurnKnown=false，不能据 null 断言任务空闲。

`codex.backend.events@1` 增加 `selection.changed` 和 `selection.unavailable`。路由 push/replace/go、当前任务的加载和回合状态变化驱动事件，未变化时不重复发布，不设置空闲轮询。有限事件缓存、cursor、gap 与既有事件接口相同。

`codex.backend.write@1` 增加 `threads.open({threadId})`。Adapter 先验证已存在的本地任务身份，再进入原生 `/local/<id>` 页面，由 Native 自行恢复历史、设置和流归属。它不会创建空历史、重建原生权限配置或额外请求流归属转移。返回 `opening` 表示导航已发出；只有 Native 状态已 resumed 才返回 `opened`。观察选择事件或再次读取状态后，仍须满足原有 owner 检查才能写入回合。重复打开当前任务不会增加历史条目。

streamRole 是各窗口已有 Native manager 的原值，不是 Codlet 实现的窗口互斥锁。本次两个主窗口打开同一任务时 Native 均返回 owner；SDK 不将该值扩写为“只有一个窗口可操作”。原有 follower 拒绝逻辑保留。

验证任务期间用户切换路由会令请求以 `desktop_navigation_superseded` 结束；并发校验被拒绝。Native 的单一 `listen` 订阅不被接管。卸载只恢复仍由本实例拥有的路由方法；发现外部覆盖时保留覆盖并报告需要重新加载。

新增导航仅对已审核的 Windows Desktop 页面 `26.903.71938 / 8576` 开放。旧页面 `26.903.61454 / 8378` 继续提供既有后端和提交能力，但导航单独返回 unavailable。头像 overlay、缺失或不唯一的路由也不提供导航；导航失败不关闭其余后端 API。兼容性返回值中的 `navigation` 单独报告结果。

## 提交拦截器诊断

`codex.ui.preSubmit@1` 的 `interceptors.list` 返回按实际执行顺序排列的注册信息，包括插件 ID、generation、拦截器 ID、priority、timeout、enabled、调用次数、失败次数、最近及累计耗时、最近失败代码和时间。这里不保存输入、上下文或插件错误文字。

注册返回可调用的 `InterceptorHandle`：直接调用仍执行卸载；`setEnabled(boolean)` 和 `inspect()` 只能操作此句柄所属拦截器。注册可指定 `enabled:false`。停用会取消已经捕获该拦截器、尚未发出的提交；重新启用保留当前注册的统计。所有拦截器停用时原生提交仍同步直通。

[M3/M4 示例](../examples/desktop-m3-m4/README.md) 已增加选择同步、任务打开按钮和诊断入口，并使用真实的拦截器启停句柄。[Desktop 类型](../types/codex-desktop.d.ts) 包含新增 DTO。

## 验证与适用边界

自动检查已通过：114 项 Node 检查、22 项 Rust renderer 单元检查、TypeScript strict 声明检查、Clippy 全 target/feature、fmt 和 7 组发行包检查。Node 范围包括原有 GUI/RPC/idle 回归、两个 world 的代次替换、弹窗/焦点/定时器清理、只属于自己节点的移除、Native 导航竞争与漂移、拦截器启停及诊断内容边界。

实机使用原有隔离测试资料目录与已审核的 Windows x64 包 `26.903.9818.0`。日常 Desktop 及其后端进程不受测试控制。原始 JSON 和截图保存在工作区 `.codlet-artifacts/ui-desktop-extensions-2026-09-11`，不进入发行包。

| 实机项目 | 结果 |
| --- | --- |
| 管理 GUI 与普通 UI 示例 | 同一 appearance/role 契约可见；600px 设置面板、420px 确认框、开关/按钮/错误/加载状态可用 |
| 键盘与卸载 | Tab/Shift+Tab 留在二级确认内；初始焦点 Cancel，Esc 返回 Reset 触发按钮且不传到底层；双弹窗卸载后零残留 modal/控件，恢复 Native 输入框焦点 |
| 主题 | 通过 Native 外观页从原有“系统”切为“深色”，两个消费者跟随原生颜色，再恢复“系统”及浅色结果 |
| 窄窗、字号、动态效果 | 420px viewport 无横向溢出；同时增大 Native 在 html/body 的字体变量后，修正固定行高过紧问题，文字与行高共同缩放；减少动态效果标记使开关过渡变为 0s；测试覆盖项随后恢复 |
| 原生冷打开 | 测试任务最初 getConversation 未载入；threads.open 返回 opening，约一秒后 Native resumed/owner，既有回合 ID 未变；没有空历史预热或额外连接 |
| 运行回合选择 | 新测试回合 `01a08ece-9fb6-7f92-82ac-d9e04633970e` 的返回 ID、Native canonical 状态与 selection.changed 相同；自然完成后 activeTurnId=null、activeTurnKnown=true，并收到 turn.completed |
| 拦截诊断 | 正常提交与一次主动拒绝后 calls=2、failures=1；失败代码 interceptor_failed，不包含草稿或错误正文；只观察到 submission.blocked，没有新增回合；停用再启用保留统计 |
| 辅助窗口 | 头像 overlay 不显示标题栏消费者，并单独报告 navigation unavailable；后端兼容性仍 available |
| 多主窗口与重载 | 原生菜单新建第二个窗口后，各主窗口一份 GUI/UI 菜单、不同标题 ID、独立计数/弹窗；第二窗口可原生恢复相同任务。全局控件重载关闭旧弹窗，Adapter 及其依赖者按新 generation 重载，回执无 target failure |

此处的字号与减少动态效果项验证 Native 变量/标记的实时继承；不是修改用户的持久字体设置。计时器取消和迟到异步回调另有确定性自动检查。回合在中断尝试送达前已经完成，尝试返回 no active turn，不能将这次尝试计为成功中断；最终状态由事件和历史再次确认。

独立 `item/fileChange/requestApproval` 的真实 approve/decline 仍未覆盖：当前只读 projectless 路径由 Native 启用 request_permissions_tool，直接 apply_patch 在此前实验中被策略提前拒绝，没有发出该类请求。权限申请分支的通过不能充当 fileChange 分支的通过；本批次不改变测试权限设置来绕过此边界。M0/M1 生产入口、重复运行、crash 等发布门禁仍保留，本批次不宣称完整生产或跨平台验收。

## 最终测试客户端

原测试入口 `.codlet-artifacts/lab-update-2026-09-10/client` 已更新并重新启动，沿用原实验资料与登录。最终 codlet-lab.exe 的 SHA256 为 `1AE4A48FE72892ABFEBC7704FB11B07CD26C4114C191E69AD573659C7B9D5F95`。新二进制再次确认 20px 标签对应 27.6923px 行高，以及主窗口各一份菜单、零残留弹窗。

最终恢复原选中任务 `01a08b6f-48d2-7a52-9251-f04197868c65`、原 M3 草稿/操作回合与已开启的拦截开关，面板保持关闭；未向该原任务发送新消息。两个临时验收包均已停用并移除，探针进程正常退出。保留原六个启用包及新的 `example.ui.controls` 示例。最终 doctor 的 failedChecks 为空，日常 Desktop 与后端 PID/创建时间保持不变；doctor 仍不充当端点和 GUI 验收的替代证据。

收尾回归还覆盖了退役 context 创建 UI、挂载令牌错误两种失败路径，确保创建失败不先留下文档监听器。当前客户端 Host/协调器/Desktop/后端的进程及采样信息保存在 final-processes.json、doctor-final.json 和 final-state.json 中。下一功能工作包是 M5a 本地导入与管理。
