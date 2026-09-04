# Codlet（暂定名）产品与技术开发方案

> 状态：Draft 0.11；日期：2026-09-04；平台：Windows-first；产品名：开发阶段暂用 `Codlet`，公开发布名必须通过命名与商标门禁。

## 1. 执行摘要

Codlet 是一个面向 Codex Desktop 的轻量级运行时扩展内核。只有用户主动选择 Codlet 专用启动器时，启动前端才创建独立、会话级长驻的 Runtime Host；由 Runtime Host 启动官方 Codex、在整个 Codex 会话中持有继承式 CDP pipe，并通过通用 capability 基础设施装载、隔离和调度用户插件。

Codlet Core 不认识 Codex 的 DOM、React、task、turn、skill 或 provider。所有 Codex 私有知识由第一方 adapter codlet 提供；管理 GUI 本身也只是这些能力的普通消费者。产品的核心价值不是内置大量增强功能，而是提供稳定、可诊断、可热更新的插件运行时，让用户在明确授权下扩展 renderer、host 和 Codex backend。

术语约定：底层产品称为 Codlet Runtime；每个插件称为一个 codlet。随运行时发布的第一个第一方 codlet 也显示为“Codlet”，负责在 Codex 内提供可关闭的管理 GUI。

一句话定义：

> 一个启动前端、一个会话级长驻内核、一套通用 capability broker，以及无限的用户插件。

## 2. 已确认的产品决策

1. 修改 Codex 原生界面是核心需求，不是可选附属功能。
2. Windows 是首发平台；macOS/Linux 不进入首版范围。
3. Codex 只有通过 Codlet 专用启动器才应进入扩展模式；官方入口启动原版纯净 Codex 是产品目标，但当前受 `DEFECT-001` 的 Electron 单主实例限制。
4. Codlet 不监视、不提示、不接管通过官方入口启动的 Codex，也不在后台等待或劫持后续启动。
5. Codlet 安装、升级和卸载均不关闭或重启 Codex，不修改或捆绑官方安装包、快捷方式、协议关联、配置与用户数据。
6. 插件采用 host/renderer 双半模型。
7. renderer 插件允许分级获得 isolated DOM、main world 和 raw CDP 能力。
8. 首版只运行用户明确授信的本地插件；不宣称提供安全沙箱。
9. 不修改 `app.asar`，不修改官方安装目录，不复制或再分发 Codex，不做 DLL 注入。
10. Codex 内的管理 GUI 由第一方 Codlet 插件提供，不写死在 renderer bootstrap 中。
11. 第一方插件默认启用但可完全禁用；禁用后不留下按钮、面板或观察器，CLI 始终是可恢复的控制平面。
12. inherited CDP pipe 是会话级 transport 与存活信号，Runtime Host 正常情况下必须与其启动的 Codex 同寿命；pipe 断开只会请求 Electron 执行协作式 `Browser::Quit()`，不是 Codex 进程必然退出的所有权保证。
13. Codlet Core 只提供通用插件 registry、lifecycle、capability graph、RPC transport、权限和诊断，不包含 Codex-specific selector、React 对象或 backend schema。
14. Codex UI Adapter 和 Codex Backend Adapter 都是第一方高权限 codlet，使用与第三方相同的 manifest、依赖解析、生命周期和诊断；高权限来自显式 grant，不来自隐藏加载路径。
15. 插件能力分为四层：L1 `renderer.dom`、L2 `renderer.main-world`、L3 `cdp.*` / `host.*`、L4 `codex.backend.*`。层级描述语义和风险，不强制规定 adapter 的内部实现路径。
16. L4 必须复用 Desktop 已有的同一 App Server connection 与 thread/turn/item 事实源；独立启动第二个 App Server 不能作为透明 fallback。

## 3. 产品定位

### 3.1 目标用户

- 希望重塑 Codex Desktop 交互的高级用户；
- 希望发布界面增强、工作流和调试插件的开发者；
- 需要内部定制 Codex，但不想维护官方客户端 fork 的团队。

### 3.2 核心场景

1. 用户主动从 Codlet 入口启动 Codex，扩展自动加载。
2. 开发者将一个本地插件目录加入 Codlet，保存代码后插件热重载。
3. 插件增加侧栏、状态区、命令入口或修改现有交互。
4. 高级插件在用户明确授权后进入 main world，观察 React 或调用页面已暴露的 `electronBridge`。
5. 单个插件崩溃或启动失败时，Runtime Host 和 CDP pipe 保持运行，Codex 本身继续运行，Codlet 给出明确诊断。
6. Codex 更新导致适配能力缺失时，相关插件拒绝激活，不静默猜测兼容。

### 3.3 首版非目标

- 替换官方 provider 协议、把独立 App Server 冒充为当前 Desktop backend；
- 会话数据库、备份、导出和同步；
- 插件市场、评分、自动远程安装；
- Tauri/Electron 管理器 GUI；
- Electron main process 任意执行；
- 修改官方签名包、ASAR patch 或原生进程注入；
- 监视官方 Codex 启动、弹出重启提示或控制官方入口启动的进程；
- 替换官方快捷方式、劫持协议关联或随 Codex 自动启动；
- 关闭、重启或更新 Codex；
- 默认遥测和云端账户系统。

## 4. 用户体验

### 4.1 安装

1. 将 Codlet 安装到独立的用户目录，只创建独立的“Codlet”开始菜单快捷方式和卸载入口。
2. 不检测或控制当前 Codex 进程，不要求关闭或重启 Codex，也不在安装完成后自动启动 Codex。
3. 不写入 Codex 官方安装目录、用户数据目录、快捷方式、协议关联或更新配置；安装包不包含 Codex 文件。
4. 首次由用户主动启动 Codlet 时再执行环境检查与注入自检。
5. 卸载只移除 Codlet 自身文件和状态，用户安装的插件数据是否保留由卸载界面明确选择。

### 4.2 日常启动

- 用户从官方入口启动 Codex，且当前没有 Codlet 扩展实例：Codlet 完全不运行、不观察、不提示，得到原版纯净体验。
- 用户主动启动 Codlet，且没有 Codex 实例：启动扩展实例。
- 用户主动启动 Codlet，且已有 Codlet 扩展实例：激活现有窗口。
- 用户主动启动 Codlet，但已有官方纯净实例：Codlet 仅在自己的启动结果中说明实例冲突并退出；不关闭、不重启、不向现有 Codex 注入，也不持续监视。用户可自行关闭 Codex 后重试。
- Codex build 未识别：进入诊断态，只加载满足已探测能力的插件。

上述行为是产品不变量：Codlet 不安装预先常驻的服务，不监视官方入口；只有 Codlet 启动器被主动调用时才检查运行环境，并且只创建和控制本次会话的 Runtime Host 与 Codex 子进程。Runtime Host 在该 Codex 会话期间长驻，Codex 退出后随即退出。`DEFECT-001` 是已接受的当前缺陷，不改写这些产品不变量。

#### 4.2.1 已知缺陷：`DEFECT-001` 单主实例限制

当前 Codlet 约束的是独立 Electron Browser Process，不是 BrowserWindow 数量；Codex 仍可在同一主实例内创建多个窗口。在历史 build `26.825.6671.0` 中，对话右键“在新窗口打开”的实际路径是 `open-in-new-window -> createFreshWindow -> createPrimaryWindow -> new BrowserWindow`；它会创建新的 Windows 顶层窗口和 renderer，但不调用 `app.relaunch()`，也不创建第二个根 `ChatGPT.exe`。该缺陷只包含以下根级结果：

- 官方纯净实例先启动时，Codlet 拒绝再启动扩展实例；
- Codlet 扩展实例先启动时，后续官方启动会被 Electron 转交给该已有主实例，通常激活已有窗口；即使创建新窗口，它也不是独立纯净实例。

这是为保持当前内核简单而暂时接受的缺陷，不是 Codlet 的特性或长期产品语义。M0-M4 不为此增加多 profile、配置复制、已有实例附着或其他备用路径；进入 M5 前必须重新验收、修复或明确阻断发布。

同一 Browser Process 内的 BrowserWindow 不属于 `DEFECT-001`。Draft 0.6 起，Runtime Host 使用 `Target.setDiscoverTargets`、启动快照和 `Target.targetCreated` / `Target.targetInfoChanged` / `Target.targetDestroyed` 事件，持续管理规范文档为 `app://-/index.html` 的全部 page target。目标可以携带 Codex 为窗口路由添加的 query 或 fragment，但其他 origin、path 与非 page 类型仍被拒绝。初始窗口与“在新窗口打开”产生的 renderer 走同一 attach、enable 与 bootstrap 入口，同一 `targetId` 不重复注入，销毁后清理状态。

#### 4.2.2 已知缺陷：`DEFECT-002` Runtime Host 异常退出后 Codex 可能残留

2026-09-01 的真实 crash acceptance 在 build `26.825.6671.0` 上证明：Runtime Host 被强制终止后，精确启动的根 `ChatGPT.exe` PID 53444 在共享 15 秒 deadline 后仍存活，托盘图标与相关辅助进程也仍存在。该结果是有效的门禁失败，不是用户操作错误。

Electron 收到 inherited CDP pipe EOF 后会发起协作式退出，但 Windows 托盘、`before-quit` / `will-quit` 或窗口退出逻辑可以延迟或阻止进程结束。在“不调用 Codex 终止 API、也不把 Codex 放入 `KILL_ON_JOB_CLOSE` Job Object”的既定边界下，Codlet 当前无法提供 Runtime crash 后 Codex 必然退出的硬保证。幸存的 Codex 不再拥有 Codlet runtime 与插件能力；后续主动启动 Codlet 时仍按现有实例冲突处理。该缺陷保持开放，M0 不得因此宣布通过。

### 4.3 管理入口

CLI 是产品中始终可恢复的权威控制平面。当前 M0 保留以下诊断和前台验收命令：

```text
codlet doctor
codlet m0-probe --launch-codex
codlet m0-runtime --launch-codex
```

M1a 新增首个正式启动入口：

```text
codlet launch
```

该命令启动前台 Runtime Host，在每个匹配 renderer 中为每个已启用插件创建独立的 isolated world，加载第一方 manifest，并为当前文档与后续导航安装同一 generation。当前实现仍是实机候选：内置插件启用状态已由 `%LOCALAPPDATA%/Codlet/config.json` 原子持久化；外部插件目录、文件热重载、运行中 CLI 控制和 GUI 自我禁用仍待完成。

M0 的仓库级 Windows 外部验收统一使用以下入口；`-CodletPath` 必须由操作者明确指向已经构建好的 `codlet.exe`，脚本不发现、安装或修改工具链：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe"
```

该脚本只有在用户主动执行时运行。它先只读快照精确命名的 `ChatGPT.exe`/`Codex.exe` 进程，发现任一冲突即明确失败，且不调用 Codlet；无冲突时仅执行一次 `codlet.exe m0-runtime --launch-codex` 并实时回显输出。当 Codlet 输出精确的 Runtime active 协议行时，脚本立即取一次运行中快照；命令返回后再取结束快照。它不终止进程、不重试、不启动官方入口、不持续监视，也不修改 Codex 或用户配置。

Runtime active 后，每个运行中新接管的 BrowserWindow 会在前台输出一条 `renderer-bootstrap: target-id=...; marker-inserted=true; marker-removed=true` 诊断行；同一 `targetId` 只输出一次。该行用于人工验证“在新窗口打开”的自动注入，不进入固定 allowlist 验收报告。

Runtime Host 强制崩溃契约使用独立且显式授权的入口，不扩张正常验收脚本的非干预边界：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0CrashAcceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe" -ConfirmRuntimeCrash
```

该 harness 启动前拒绝任何已有的精确 `ChatGPT.exe`、`Codex.exe` 或 `codlet.exe`。进入 active 后，它以 PID、父 PID、启动时间和规范化可执行路径同时锁定本次 Runtime Host 与 Codex child，并持有两者的 process handle；执行动作前再次核验同一身份和存活状态。它只对自己创建并持有 handle 的 Runtime Host 调用一次 `System.Diagnostics.Process.Kill()`，绝不对 Codex 调用终止 API；随后观察而不假定同一个 Codex process handle 是否会因 pipe-disconnect 退出，并在共享 deadline 内扫描相关进程残留。身份无法建立或发生变化时按基础设施错误拒绝，不按裸 PID 猜测。当前 harness 仍把“Codex 未在 deadline 内退出”记录为 crash contract 失败，用于持续暴露 `DEFECT-002`，而不是把残留改写为成功。

以下只读和下一次启动控制命令已经实现；它们不发现、启动、附着、关闭或重启 Codex：

```text
codlet plugin list
codlet plugin enable <id>
codlet plugin disable <id>
```

`list` 在状态文件不存在时只显示内置默认值，不创建文件。`enable` / `disable` 采用同目录临时文件、flush + `sync_all` 和原子 rename 替换状态；当前没有 Launcher/Runtime Host 控制 IPC，因此命令明确报告只对下一次 `codlet launch` 生效。运行中立即启停、自我禁用和热重载不能借此宣称已实现。

以下命令仍属于后续里程碑：

```text
codlet status
codlet plugin add <path>
codlet plugin reload <id>
```

第一方 `codlet` 插件默认启用。它使用普通 plugin manifest、生命周期和 renderer bridge，在 Codex 顶部应用栏的原生菜单之后增加一个紧凑按钮；点击后打开 Codlet 管理面板。按钮插槽由 adapter capability `codex.ui.titlebar.afterMenu` 提供，不允许插件散落硬编码 selector。

历史 build `26.825.6671.0` 的 capability 探测锚点是 `header[data-app-shell-header-layout] [data-testid="app-shell-header-context-menu-surface"]`。选择器只存在于第一方适配插件；在当前 build 上必须重新验证，缺失时插件保持未挂载，不猜测其他 DOM 位置。后续完整 `doctor` 将把该失败状态明确回传。

用户可在 GUI 中确认后禁用该插件；对应 CLI 在插件注册表里程碑实现后提供：

```text
codlet plugin disable codlet
codlet plugin enable codlet
```

禁用后 GUI 立即完整卸载，只保留 CLI。升级不得擅自重新启用用户已禁用的 GUI。若 Codex 更新导致顶栏插槽失效，该插件拒绝激活并由 `codlet doctor` 报告，不猜测其他挂载位置。

## 5. 总体架构

```text
Codlet Launcher Frontend (short-lived CLI / future GUI)
          │ start / control
          ▼
Codlet Runtime Host (independent, lives for the Codex session)
├── Codex package discovery and Windows process launcher
│   └── inherited CDP input/output handles (owned for the full session)
├── CDP pipe client and target/session controller
├── plugin registry, lifecycle and permission grants
├── capability registry, dependency graph and scoped RPC broker
├── renderer world/binding manager
├── optional plugin-host supervisor
└── diagnostics and logs
          │
          ├── first-party adapter codlets
          │   ├── Codex UI Adapter       -> renderer.dom / renderer.main-world
          │   └── Codex Backend Adapter  -> codex.backend.*
          ├── user codlets
          │   ├── renderer worlds
          │   └── optional host process
          │
          └── Codex Desktop
              ├── renderer / preload bridge
              └── existing App Server connection
```

M0 只交付可实机验收的前台 Runtime Host 路径；独立后台化、启动前端与 Runtime Host 的控制 IPC、未来 GUI 接入均记录为后续里程碑，不在本轮扩张实现。

### 5.1 核心与适配器分离

稳定内核负责：

- Windows 启动和 pipe 生命周期；
- CDP request/response/event 路由；
- 插件 ABI、注册表、状态机、generation 和错误模型；
- capability provider/consumer 注册、精确版本匹配、依赖排序和循环拒绝；
- scoped RPC transport、权限确认、日志和诊断。

第一方 Codex adapter codlet 负责：

- 识别 Codex build 和同一 Browser Process 内的全部 renderer target；
- 提供版本相关的 DOM anchor、React hook、preload bridge 和 App Server 语义；
- 对目标 build 执行兼容性探测。

用户插件依赖 adapter capability，而不是直接依赖 Codlet 内核版本。选择 raw main-world/CDP 的插件自行承担 Codex 内部变化风险。Core 不为 adapter 提供 Codex-specific 特权分支；第一方 adapter 通过普通 manifest 申请并获得高权限 grant。

### 5.2 四层 capability 模型

| 层级 | capability namespace | 面向插件的语义 | 典型实现 | 稳定性 |
|---|---|---|---|---|
| L1 | `renderer.dom.*` | DOM mount、CSS、事件、可逆 UI 资源 | isolated world + 共享 DOM | build adapter 稳定 |
| L2 | `renderer.main-world.*` | 页面全局、React state、私有对象、preload bridge | main world adapter | build-specific、高漂移 |
| L3 | `cdp.*` / `host.*` | raw CDP、文件、进程、网络、系统能力 | Runtime Host broker / plugin host | Codlet 自有契约 |
| L4 | `codex.backend.*` | thread、turn、item、skill、model、provider、approval | Desktop 同一 App Server connection 的 adapter | 官方语义 + 私有接入 |

层级不是插件继承关系。插件只声明自己实际需要的 capability；例如纯 UI 插件不因依赖 L1 而自动获得 L2-L4。L3 明确拆为两类安全边界：

- `cdp.raw`：直接向目标 session 发送 CDP method；
- `host.fs`、`host.process`、`host.network`、`host.system`：由 Runtime Host 在授权后提供的系统能力。

L4 使用 App Server 的官方语义 `Thread -> Turn -> Item`；产品 UI 中的 task/conversation 只能是 adapter 提供的映射，不进入 Core。L4 adapter 可以通过 L2 private bridge 实现，但对消费者暴露的是稳定、版本化的 backend capability，而不是 React 对象。

### 5.3 通用 capability 内核

首版最小原语：

1. descriptor 由稳定名称、精确正整数 API version 和 scope 组成；scope 只有 `runtime`、`target`、`backend-session`、`thread`；
2. manifest 使用结构化 `provides` / `requires`；不接受字符串简写，不做 semver；
3. 同一作用域中的 provider 冲突明确失败，缺失、版本不匹配和依赖循环明确失败；
4. 激活顺序由 capability graph 唯一决定，停用顺序反向执行；manifest 排列和扫描顺序不构成语义；
5. principal 至少包含 plugin id、generation、target/backend session/thread scope 与 grants；旧 generation 的调用全部拒绝；
6. provider 注销后，依赖它的 consumer 立即失去 resolved 状态，不得继续调用陈旧 endpoint；
7. renderer binding、host IPC 和 backend adapter 实现同一 request/response/notification/server-request 模型；Core 不解释 payload 的 Codex 业务含义。

### 5.4 输入/输出 hook 边界

“用户无感修改”必须区分四种不同结果，不能统一称为 output hook：

| 目标 | 所需层级 | 首选路径 | 是否改变 backend 事实 |
|---|---|---|---|
| 修改输入框中的文本 | L1 | DOM/composer UI adapter | 否 |
| 在 `turn/start` 前改写实际输入 | L2 + L4 adapter | 包装 Desktop 同一 app-host RPC 的 pre-submit interceptor | 是 |
| 追加模型可见上下文 | L4 | 明确的 history/inject capability 或受支持 hook | 是，但不替换原输入 |
| 修改屏幕上显示的流式输出 | L1/L2 | item event 后的 presentation transformer | 否 |
| 观察结构化输出、turn/item 生命周期 | L4 | App Server notification adapter | 否 |
| 替换已持久化的 assistant item | 当前不承诺 | 只有经验证的官方/私有 backend mutation contract 才可开放 | 未证实 |

pre-submit interceptor 是 adapter capability，不是 Core 内建业务钩子。多个 interceptor 按用户明确配置顺序串行执行，每个接收上一个的结构化结果；拒绝、超时或异常必须阻止提交并给出来源，不允许绕过失败插件继续发送未经确认的输入。

output presentation transformer 只改变当前 renderer 的显示，不得伪装成 backend history 已被修改。L4 的 item delta observer 可以提供语义完整的流事件，但公开 App Server 协议目前没有通用的“重写既有 assistant item”方法；在新证据出现前，SDK 必须保留这条边界。

## 6. Windows 启动设计

### 6.1 包发现

- 通过 Windows Package API 按 package family 查询当前用户安装包；
- 使用 package full name 获取实际安装目录；
- 不硬编码带版本号的 `WindowsApps` 路径；
- 启动前读取应用版本、包版本和可用的 build metadata。

### 6.2 CDP pipe

Runtime Host 创建两组匿名管道：

1. child read / parent write；
2. parent read / child write。

只有 child 端句柄可继承。使用 `STARTUPINFOEXW` 和 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 将句柄精确传给 Codex，并追加：

```text
--remote-debugging-pipe=JSON
--remote-debugging-io-pipes=<child_read>,<child_write>
```

CDP JSON 消息以单个 NUL 字节分帧，不使用换行或 WebSocket。

### 6.3 生命周期原则

- 启动前端只负责主动启动与控制；独立 Runtime Host 持有由本次会话启动的 Codex process handle 和 CDP pipes；
- Runtime Host 必须在正常 Codex 会话中保持存活。Electron 将 remote-debugging pipe disconnect 绑定到协作式 `Browser::Quit()` 请求，但该请求可被应用退出钩子或托盘生命周期延迟、阻止，不能替代 OS 级进程所有权；
- Codex 不加入 `KILL_ON_JOB_CLOSE` Job Object，也不调用 `TerminateProcess`；process handle 只用于观察退出状态。用户正常关闭 Codex 是当前唯一具有实机证据的干净退出路径，Runtime Host 异常退出后的 Codex 结果按 `DEFECT-002` 记录；
- 用户关闭 Codex 后，Runtime Host 观察 child exit/pipe EOF，在有限 deadline 内回收 CDP workers 并干净退出；
- 单个插件或插件 host 的失败不得结束 Runtime Host；仅插件 host 进程加入 Runtime Host 的 Job Object，保证插件资源可回收且 CDP pipe 继续存活；
- CDP worker 回收使用有限 deadline；显式 shutdown 超时会保留 worker ownership 供重试，而 `ClientInner::drop` 或半启动清理仍无法收回 worker 时，Runtime Host fail-fast 并 abort 自身，绝不静默遗留 detached thread。该路径不调用 Codex 终止 API；进程退出造成的 pipe disconnect 只发起 Electron 协作式退出请求，Codex 可能继续存活。

### 6.4 最大可行性风险

2026-08-30 的只读 `doctor` 检测到安装 build `26.825.6671.0`，用户确认其最新外部 M0 运行使用了该 build。该记录只证明这次外部运行的版本覆盖，不构成对后续 Codex build 的兼容承诺。2026-09-01 的 crash acceptance 又在同一 build 上复现 `DEFECT-002`，因此异常退出硬门禁明确未通过。M0 尚需以明确记录验证会话级 Runtime Host 的正常生命周期、重复性、官方入口零行为、孤儿进程与端口基线；Shell/URI 激活不能替代这些验证。

如果后续受支持的实际 build 无法通过 pipe smoke test，项目暂停该 build 的架构开发并单独评审 transport；不提前实现双路径 fallback。

## 7. 插件模型

### 7.1 目录结构

```text
example-plugin/
├── plugin.json
├── dist/
│   └── renderer.js
└── host/                 # 可选
    └── example-host.exe
```

### 7.2 最小 manifest

```json
{
  "schema": 1,
  "id": "dev.example.sidebar",
  "version": "0.1.0",
  "renderer": {
    "entry": "dist/renderer.js",
    "world": "isolated"
  },
  "permissions": ["ui.dom"],
  "provides": [],
  "requires": [
    {
      "name": "codex.ui.titlebar.afterMenu",
      "api": 1,
      "scope": "target"
    }
  ]
}
```

有 host 时增加：

```json
{
  "host": {
    "command": ["host/example-host.exe"],
    "protocol": "jsonl"
  }
}
```

首版有 capability dependency graph，但没有包依赖、包解析、远程来源或 semver 求解。插件不能按另一个插件的发行版本建立依赖，只能要求明确的 capability API。

### 7.3 权限层级

| 权限 | 能力 | 风险等级 |
|---|---|---:|
| `ui.dom` | L1：isolated world 中读写 DOM、CSS 和事件 | 中 |
| `ui.mainWorld` | L2：访问页面全局、patch 函数、观察 React、调用 preload bridge | 高 |
| `cdp.raw` | L3：直接发送 CDP 方法 | 极高 |
| `host.fs` | L3：通过 broker 读写获准的本地路径 | 高 |
| `host.process` | L3：启动拥有当前用户权限的 host 进程 | 极高 |
| `host.network` | L3：发起网络连接 | 高 |
| `host.system` | L3：访问其他明确列出的系统能力 | 极高 |
| `codex.backend.read` | L4：读取 thread/turn/item/skill/model/provider 语义与事件 | 高 |
| `codex.backend.write` | L4：启动、steer、中断 turn 或响应 approval | 极高 |
| `runtime.manage` | 查询、启停、重载插件并修改运行时配置 | 高 |

权限不是 OS 沙箱。用户必须明确授信插件；安装界面不得暗示陌生插件是安全的。

Electron main process 任意能力不进入 ABI v1。若未来需要 Node inspector 或原生注入，必须作为独立实验项目评审。

### 7.4 双半职责

renderer 半：

- 直接运行于 Codex renderer；
- 修改界面、注册事件和观察页面状态；
- 通过 Codlet binding 与 host 通信；
- 不包含密钥或长期秘密。

host 半：

- 可选、懒启动；
- 负责文件、网络、外部工具和长任务；
- stdin/stdout 只传 JSONL 协议，日志写 stderr；
- 崩溃只影响所属插件。

### 7.5 第一方 GUI codlet

第一方 GUI 的显示名和首版插件 ID 均为 `codlet`。它随 Runtime 发布并默认启用，但在内核看来仍是一个普通插件：

- 使用相同的 manifest、activate/deactivate、generation、权限和错误模型；
- 顶栏按钮只消费 Codex UI Adapter 提供的 `codex.ui.titlebar.afterMenu@1` target-scoped capability；
- 管理面板通过公开、版本化的 `runtime.manage` API 工作，不调用隐藏 IPC；
- 发布清单记录该第一方插件的内容摘要与权限授予，第三方插件请求同一权限时仍需用户明确授权；
- 自我禁用前明确说明“禁用后只能通过 CLI 重新启用”；确认后先提交配置，再执行 deactivate；
- deactivate 必须移除按钮、面板、样式、listener 和 observer，不能残留不可见后台逻辑。

第一版面板只承担运行时状态、插件列表、启用/禁用、重载、权限查看和诊断入口，不演变为独立应用商店。

### 7.6 第一方 adapter codlets

`codex.ui.adapter`：

- 持有 build-specific DOM selector、React 和 preload bridge 探测；
- L1 纵切只提供共享 DOM mount token，不向消费者传递 DOM node 或 JS function；
- adapter 在共享 DOM 中创建 target/document-local mount marker，consumer 在自己的 isolated world 中按 token 解析；
- Codex 重建 header 时 adapter 重建 marker，consumer 重新挂载自身 UI；
- consumer 先停用，adapter 后停用，确保资源回收顺序与 capability graph 一致。

`codex.backend.adapter`：

- 通过 Desktop preload 暴露的 app-host `MessagePort` 复用 Desktop 已维护的 App Server connection；
- 将私有 envelope 映射为版本化的 `codex.backend.thread/turn/item/skill/model/provider/approval` capability；
- 不把 `window.electronBridge`、内部 manager、request id 或 host routing object 直接泄漏给第三方；
- Desktop build 未通过 schema、身份、事件流和写入门禁时拒绝提供 L4；
- 不启动独立 App Server 作为静默 fallback。

## 8. Renderer bridge

### 8.1 注入顺序

1. `Target.setDiscoverTargets(discover=true)`，再以 `Target.getTargets` 补齐启动快照；
2. 选择并验证所有规范文档为 `app://-/index.html` 的 page target（允许窗口路由 query/fragment）；
3. 对每个 target 独立执行 `Target.attachToTarget(flatten=true)`；
4. 对每个 session 执行 `Runtime.enable` 和 `Page.enable`；
5. 注册目标作用域的 capability providers/consumers，并求解激活顺序；
6. 持续处理 target created/info-changed/destroyed，令后续 BrowserWindow 重复步骤 2-5；
7. 为每个插件创建独立 world、binding namespace 和 generation/epoch；
8. 按 provider 到 consumer 的顺序安装 bootstrap 并注入 renderer entry；
9. 等待插件 `ready` 握手后才标记 active。

### 8.2 world 策略

- 默认 `isolated`：每插件独立 world，插件之间只共享 DOM，不共享页面 JS 全局；
- `main`：仅对明确授信插件开放；
- `Page.addScriptToEvaluateOnNewDocument` 负责导航后的自动恢复；
- `Runtime.addBinding` 只接受字符串载荷，Codlet 在其上实现版本化 RPC；
- world 与 binding 按 plugin id + generation 命名，且绑定到指定 execution context；
- renderer RPC v1 的 request/notification 载荷固定为 `{v,type,pluginId,generation[,id],capability,method,params}`；response 固定为 `{v,type:"response",id,ok,result?,error?:{code,message}}`，host 在 provider 调用前完成 principal/lease 校验，并以每个 plugin generation 的单调 request ID 水位拒绝重复或乱序请求；
- capability 不跨 world 传递 JS function、DOM node 或 remote object handle；L1 mount 使用可验证的 DOM token；
- target 销毁、导航离开规范 Codex URL 或 provider 失效时，先停用 consumer，再停用 provider。

### 8.3 可逆性

每个插件必须导出：

```ts
activate(context): void | Promise<void>
deactivate(): void | Promise<void>
```

`deactivate` 必须移除 DOM、CSS、listener、observer、timer 和已知 monkey patch。已经执行的 main-world 修改不能保证完全可逆；若插件声明无法热卸载，禁用操作应明确要求 renderer reload。

## 9. 生命周期与调度

插件状态：

```text
discovered -> validating -> starting -> active -> stopping -> stopped
                         \-> failed
```

激活事务：

1. 解析并验证 manifest；
2. 验证路径全部位于插件根目录；
3. 注册 `provides` / `requires`，求解 scoped capability graph；
4. 检查权限授权、provider API version 和 scope；
5. 如有 host，启动并完成握手；
6. 按 dependency order 注入新 renderer generation；
7. renderer 返回 ready；
8. 原子切换为 active；
9. 再按反向 dependency order 停用旧 generation。

新 generation 失败时保留旧 generation；不自动重试。文件变化 debounce 后重新扫描整个插件目录，避免读到编辑器临时文件和半完成 rename。

调度规则：

- 同一 dependency frontier 内按稳定 plugin id 排序，frontier 之间严格按 capability dependency order 激活；
- 同插件 host RPC 首版单并发；
- 每个请求有明确 deadline；
- observer 类事件可有界并发；
- ID、命令或资源冲突时拒绝后加载者，不静默覆盖；
- 旧 epoch 的消息全部拒绝。

## 10. 技术栈

### 10.1 Rust 内核

首版保持一个 Rust crate，按模块拆分，不提前建立五到十个 crates：

```text
src/
├── main.rs
├── windows/
│   ├── packages.rs
│   ├── process.rs
│   └── pipes.rs
├── cdp/
│   ├── framing.rs
│   ├── client.rs
│   └── session.rs
├── adapter/
├── plugins/
├── host_rpc/
└── diagnostics/
```

仅当模块出现独立消费者或发布边界时再拆 crate。

建议依赖：

- `windows-sys`：最薄的 Win32 FFI；
- `serde`、`serde_json`：manifest、CDP 和 RPC；
- `tracing`、`tracing-subscriber`：结构化日志；
- `notify`：插件文件监控。

核心 CDP 使用阻塞 reader/writer thread 和 NUL framing，不引入 WebSocket client。Tokio 只在 host RPC 的实际并发需求证明后加入。

### 10.2 SDK 分层

Core 只提供一个很薄、与 Codex 无关的开发包：

```text
packages/codlet-sdk/
├── definePlugin
├── lifecycle / generation types
├── capability client and scoped RPC types
├── RendererContext / HostContext types
├── cleanup helpers
└── build template
```

Codex-specific 类型由 adapter 自己发布，例如 `@codlet/codex-ui` 和 `@codlet/codex-backend`。Core SDK 不镜像 React state、Electron bridge 或 App Server protocol；adapter SDK 只暴露其承诺稳定的 capability contract。

插件在开发时由 esbuild 或同类工具打包成单文件 renderer JS；打包器是开发依赖，不进入 Codlet runtime。

## 11. 数据与目录

建议的用户目录：

```text
%LOCALAPPDATA%/Codlet/
├── config.json
├── plugins/
├── logs/
└── state/
```

第一版不使用 SQLite。配置和 registry 使用原子写入的 JSON；插件持久状态由插件在自己的 data 目录管理。

## 12. 安全与隐私

1. 不开放固定或随机 TCP CDP listener，优先 inherited pipe。
2. 不使用 `--remote-allow-origins=*`。
3. 不把 CDP handle、页面数据或秘密写入日志。
4. renderer bridge 不暴露 Node、原始 `ipcRenderer` 或任意 Electron main IPC。
5. raw CDP、main world 和 host process 必须逐项显示高风险授权。
6. 插件来源和入口路径在激活前 canonicalize；越出插件根目录即拒绝。
7. 未识别 Codex target、build 或 capability 时失败并给出诊断。
8. 默认无遥测；测试指标仅保存在本机。

## 13. 性能目标

这些是工程目标，需由基准测试验证：

- Codlet 空闲 CPU 接近 0，不通过轮询发现 renderer 或插件变化；
- 内核常驻私有内存目标低于 20 MB，不含插件 host；
- Codlet 对 Codex 冷启动增加的中位延迟目标低于 300 ms；
- renderer target 就绪后，bootstrap 注入目标低于 100 ms；
- 无插件时不安装 MutationObserver 或页面级周期任务；
- 插件失败不得导致 Codex 主进程退出。

## 14. 测试策略

### 14.1 单元测试

- NUL framing 的分片、粘包、空帧和无效 JSON；
- request ID 路由、事件路由和 pending request teardown；
- manifest/path/permission 校验；
- generation、epoch 和状态机；
- host JSONL 协议；
- capability descriptor、provider 冲突、缺失、精确版本不匹配、循环、确定性排序和 unregister 后失效；
- backend adapter envelope 与 App Server thread/turn/item 映射。

### 14.2 集成测试

- fake CDP child process；
- Windows inherited handle 白名单；
- fake child 中 parent 持有 pipe 时 child 保持运行，parent 显式关闭/EOF 后 fake child 按测试协议退出；该夹具不证明 Electron 托盘应用必然退出；
- child 自行退出后前台 Runtime Host 回收全部 CDP workers；
- 初始多个 renderer、运行中 targetCreated、about:blank 经 targetInfoChanged 成为 Codex page、重复事件去重、targetDestroyed 清理与同 ID 重建；
- 插件 host crash、hang 和 malformed response；
- renderer navigation、reload 和 target replacement；
- 每插件独立 world/binding、provider 到 consumer 的激活顺序和反向停用；
- Codex UI Adapter mount token 在刷新、DOM 重建和多窗口中的隔离与恢复；
- Desktop app-host 同连接探测、L4 notification 订阅、server request/approval 往返和 stale generation 拒绝；
- 文件保存、rename 和半写入场景；
- 第一方 `codlet` 插件的按钮挂载、面板开关、自我禁用和 CLI 重新启用。

### 14.3 实机门禁

正常会话链路的统一留证入口是 `scripts/Invoke-M0Acceptance.ps1`。每次运行在被 git 忽略的 `.codlet-artifacts/m0-acceptance/` 下写入一个 `codlet.m0-acceptance/v1` JSON 报告，固定结构为：

- `executionMode`、`startedAtUtc`、`endedAtUtc`；
- `codlet`：可执行文件路径、固定参数、是否调用、退出码、本次启动 PID、active/stopped 协议观测、`allowlisted-m0-stdout-v1` 规则允许的逐行 stdout，以及未持久化的输出行数；所有输出仍实时显示，但 stderr 和不符合固定 M0 报告语法的 stdout 不写入报告；
- `preflight`：是否冲突及冲突进程；
- `snapshots.before` / `snapshots.active` / `snapshots.after`：分别在启动前、Runtime 明确进入 active 后和命令返回后采集时间、相关进程以及由这些进程持有的 TCP listening 端口；采集失败时数据为 `null` 并记录 `captureError`，不得伪造空快照；
- `manualChecks`：`runtime_visible_and_usable`、`user_closed_codex_normally`、`official_entry_zero_behavior`、`runtime_crash_contract` 四项始终为 `pending_manual_confirmation`；
- `result`：脚本执行状态与退出码，`m0Decision` 固定为 `not_determined`。

报告不采集进程命令行、页面内容、CDP pipe handle 或秘密。脚本只在本次启动 PID 出现于 active 快照、Codlet 输出 worker-reaped 结束协议、且 after 快照没有新增相关进程时把这次脚本执行记为成功；证据不匹配时只报错并留证，不终止任何残留进程。active 快照为端口门禁提供运行中证据，但脚本不自动判定某个端口是否属于 CDP。它不代替官方入口零行为、Runtime 崩溃契约、连续重复和人工可用性判断，也不因此宣布 M0 完成。

异常退出契约由 `scripts/Invoke-M0CrashAcceptance.ps1` 单独留证，在 `.codlet-artifacts/m0-crash-acceptance/` 写入 `codlet.m0-crash-acceptance/v1` 报告。报告记录 Runtime Host/Codex child 的完整进程身份、active 协议、动作时存活状态、强制终止动作及时间、两者退出时间与退出观测、前/中/后进程快照、固定 allowlist 输出和未持久化行数。只有本次 Runtime Host 确实被强制终止、没有出现正常 stopped 协议、同一个 Codex process handle 在共享的 15 秒 deadline 内退出且 after 快照无相关进程时，`crashContractDecision` 才为 `passed`；这是一项尚未满足的目标门禁，不是 Electron 的协议保证。脚本不终止残留 Codex；失败时留给操作者人工检查和关闭。报告 `m0-crash-acceptance-20260901T081559556Z-49124.json` 已证明精确根 PID 53444 存活，因此该次判定必须保持 failed，且总体 `m0Decision: not_determined`。

- 连续冷启动至少 100 次，无孤儿 Runtime Host/plugin-host 进程；
- 同一 Codex build 注入成功率至少 99%；
- 在没有已运行 Codlet 扩展实例时，从官方入口启动 Codex 无 Codlet 进程、日志、提示或界面变化；
- 已有官方纯净 Codex 时主动启动 Codlet，现有进程继续运行且不被注入，Codlet 报告冲突后退出；
- Runtime Host 存活并持有 pipe 时，由它启动的 Codex 持续可见、可交互；
- 用户关闭 Codex 后，Runtime Host 干净退出且无遗留 worker；Runtime Host 强制崩溃时，专用 harness 记录协作式退出结果，当前 build 的 Codex 残留使该目标门禁失败；
- 端口扫描确认没有 Codlet CDP listener；
- 一个故障插件不影响其他插件和 Codex。

## 15. 阶段性验收里程碑

不使用日历排期衡量开发进度。每个阶段必须同时具备可重复的自动化证据和该阶段明确列出的外部实机门禁，二者全部通过才判定完成；实现、测试、文档和兼容性探测可由多个 agent 并行推进，但任何并行产物都必须通过同一集成门禁。

### M0：Transport 可行性门禁

验收条件：

- 能从当前用户安装的 Codex MSIX 定位可执行文件，全程不修改官方包；
- 能使用 `CreateProcessW` 和精确 inherited handles 启动 Codex；
- CDP NUL framing、request/event 路由和持续多 target discovery 均通过自动化测试；
- 能向启动时已有和运行中新建的每个 Codex renderer 注入并完整移除同一个 Codlet bootstrap 标记；
- 前台 Runtime Host 在 marker 探针完成后继续持有 CDP pipes，期间 Codex 可见且可正常使用；
- 用户关闭 Codex 后 Runtime Host 观察退出、回收 CDP workers 并正常返回；Runtime Host 异常退出的目标门禁仍因 `DEFECT-002` 未通过，不得以 pipe EOF 推断 Codex 已退出；
- 没有已运行 Codlet 扩展实例时，官方入口启动的 Codex 不产生任何 Codlet 行为；已有官方实例时主动启动 Codlet，Codlet 只报告冲突并退出；
- 上述完整链路可连续重复通过，无孤儿进程和开放的 CDP TCP 端口。

M0 验收矩阵：

| 门禁 | 自动化证据 | 必需的外部实机判定 |
|---|---|---|
| inherited pipe、路由、target、marker | fake child 覆盖初始/新增/导航/销毁 target；ignored + env opt-in 的一次性 real smoke | 当前安装 build 能完成真实 attach 与 marker；smoke 结束只产生协作式退出请求，操作者需检查并在必要时手动关闭 Codex |
| 会话级 Runtime Host 生命周期 | fake child 验证持 pipe 存活、EOF 退出、child exit 后 worker 回收 | `m0-runtime --launch-codex` 运行期间 Codex 可见可用；用户关闭 Codex 后 Runtime Host 正常返回 |
| 官方入口与实例冲突边界 | 包实例冲突自动化测试 | 无已运行扩展实例时官方入口零 Codlet 行为；既有官方实例不被注入、不被关闭或重启；`DEFECT-001` 作为已知限制留档 |
| 稳定性与外部副作用 | 静态检查、fake child 回归、crash harness 的数据夹具与身份拒绝测试 | 专用 crash harness 当前暴露 `DEFECT-002`；连续重复、孤儿进程与端口扫描全部通过后方可关闭门禁 |

决策：全部通过才进入 M1。若 inherited pipe 不成立，停止插件内核建设，单独评审 transport，不并行维护未经验证的备用实现。

### M1：Capability Renderer Runtime 门禁

M1a 历史候选已经在 build `26.825.6671.0` 验证第一方 GUI、刷新恢复和同 Browser Process 多窗口注入；它仍使用共享 isolated world，GUI 也仍直接持有 selector，因此不代表目标架构完成。`26.831.2377.0` 仅保留为 2026-09-02 的研究快照；2026-09-04 只读 `doctor` 检测到当前安装 build `26.901.2854.0`，该 build 必须重新通过真实门禁。

M1b 验收条件：

- structured `provides` / `requires`、精确 API version 和四种 scope 可严格解析；
- provider 冲突、缺失、版本不匹配、循环、确定性激活顺序和 unregister 后失效都有单元测试；
- capability kernel 保持 Codex-agnostic，不包含 selector、React、CDP method 或 App Server schema；
- generation/epoch 能阻止旧实例继续解析或调用 capability。

M1c 验收条件：

- 每插件独立 isolated world、bootstrap、binding namespace 和 generation；
- 第一方 `codex.ui.adapter` 真实提供 `codex.ui.titlebar.afterMenu@1`，第一方 GUI `codlet` 只消费该 capability，不再拥有 header selector；
- provider 到 consumer 顺序在初始窗口、刷新、DOM 重建和“在新窗口打开”中一致；
- consumer 到 provider 的反向停用能移除按钮、面板、mount token、style、listener 和 observer；
- 本地 registry、文件热重载、CLI 启停/重载与 GUI 自我禁用可用；
- `codlet doctor` 给出 build、target、capability provider、插件 generation 与可行动的错误原因。

### M2：L3 Host/CDP 与权限门禁

验收条件：

- 可选 host process、JSONL RPC 和按插件隔离的 Job Object 可用；
- `cdp.raw`、`host.fs`、`host.process`、`host.network`、`host.system` 使用独立 broker endpoint；
- 每项高风险权限在首次使用前显示并持久记录授权，撤销后立即使对应 endpoint 失效；
- 公开、版本化的 `runtime.manage` API 能支持第一方 GUI 查询、启停和重载插件；
- host crash、hang、malformed response、deadline 和越权调用都有确定结果，不拖垮其他插件；
- renderer/host RPC 的 request、response、notification、server-request、generation 和错误语义由 Core SDK 固化；
- 示例 host 插件完成获准目录读取和网络请求，并在撤销权限后停止。

### M3：L2 Main-World Adapter 门禁

验收条件：

- main-world 插件必须申请 `ui.mainWorld`，且与 isolated world 使用不同 binding/principal；
- `codex.ui.adapter` 对当前 build 探测页面 global、React/私有对象和 `window.electronBridge`，缺失时明确拒绝提供相应 capability；
- 不向第三方暴露原始 `ipcRenderer`、任意 Electron main IPC 或未声明的页面对象；
- pre-submit interceptor 在实际 `turn/start` 前按确定顺序运行，失败时阻止提交并标明插件来源；
- main-world patch 无法热卸载时明确要求 renderer reload，不伪造可逆性；
- Codex 更新后的 capability drift 可由自动探针和 `doctor` 定位。

### M4：L4 Backend Adapter 门禁

验收条件：

- 在当前 Desktop build 上通过 preload `connect-app-host` MessagePort 复用 Desktop 同一个 App Server connection，不启动第二个 backend；
- adapter 用官方 `Thread -> Turn -> Item` 语义提供 thread read/list、turn start/steer/interrupt、item stream、skill/model/provider read 和 approval/server-request 往返；
- 证明 Desktop 发起的 turn 与 Codlet 观察到的事件拥有相同 threadId/turnId/itemId，Codlet 写入也由当前 Desktop UI 和同一事件流观察到；
- 私有 app-host envelope、hostId、request id 和 manager object 不进入公开 SDK；
- input rewrite、context injection、presentation transform 和 authoritative history mutation 是不同 capability；未证实的 assistant item rewrite 不开放；
- build/schema/身份/事件流任一门禁失败时，L4 provider 不注册，且不回退到独立 App Server。

### M5：Private Alpha 门禁

验收条件：

- 用户级安装、升级和卸载可重复通过，发布产物带测试签名；
- 安装包不包含 Codex 文件，不修改官方包、官方入口、协议关联、配置或用户数据；
- 安装、升级和卸载期间不检测、关闭或重启 Codex；
- 关闭 `DEFECT-001`：官方入口与独立 Codlet 入口并存，官方入口连续启动均保持原版纯净行为；
- 日志、诊断包、safe mode 和故障恢复文档能定位所有已知启动与插件故障；
- 第 14.3 节实机门禁全部通过。

### M6：Public Beta 门禁

验收条件：

- 至少经历一次真实 Codex 更新并完成 UI/Backend adapter 适配；
- 安全评审、依赖许可证清单、SBOM 和发布签名流程完成；
- 插件开发文档、模板和三到五个覆盖不同权限层级的示例完成；
- 安装、升级、卸载、Runtime Host 异常退出及其协作式 pipe-disconnect 结果、插件崩溃和 Codex 更新路径全部通过发布门禁；`DEFECT-002` 必须关闭或明确阻断发布；
- 公开品牌、包命名空间、域名与商标风险完成核验并冻结。

## 16. 当前开发工作包

下一纵切按下列依赖关系推进：

1. **Capability Kernel**：结构化 manifest、provider registry、dependency graph、scope、generation 和纯 Rust 测试；
2. **Renderer Isolation**：每插件独立 world/binding、按 graph 激活和反向停用；
3. **Codex UI Adapter**：把 selector 与 mount 生命周期移出 GUI codlet，以 titlebar capability 完成真实 provider/consumer 闭环；
4. **Verification**：扩展 fake child 覆盖双 world、双插件、导航、销毁、多窗口，并在当前安装 build `26.901.2854.0` 重新执行实机门禁；
5. **Backend Research Gate**：只读固定上游源码与本机 `app.asar`，冻结 app-host envelope 探针和 L4 go/no-go 测试，不提前向第三方暴露私有 API。

Capability Kernel 是 2-4 的共同前置。Renderer Isolation 与 adapter source 可在文件边界明确时并行，但只有 UI Adapter 的真实 provider/consumer 测试通过后，manifest 中的 capability 才能被称为已实现。L4 研究不阻塞 M1/M2，也不允许以第二 App Server 路径提前伪造完成。

### 16.1 当前实现状态

截至 2026-09-04，工作树已包含 M1b capability kernel 候选，以及 M1c 的第一条 renderer 鉴权纵切：structured manifest、精确 API/scope、确定性依赖排序、每插件独立 isolated world、第一方 `codex.ui.adapter` mount token 和仅消费 token 的 `codlet` GUI。capability resolve 现在签发 opaque `CapabilityPrincipal`；provider id、consumer/provider registration epoch 和 scope epoch 只保存在 Core 内部，不通过 principal API 或错误暴露。Renderer Host 将 target/plugin/generation 对应的可信 principal 与注入 JS 的 plugin context 分开保存；每次 invoke 都在执行授权动作前重新核验 consumer/provider generation、registration 和 scope。插件换代、provider 注销或 scope 撤销后，旧 principal 均明确失败且不会执行动作，同一名称和 generation 的重新注册也不能复活旧 principal。

target controller 现在按顺序向 Runtime Host 暴露 `Attached`、`NavigatedAway` 和带 `targetId`/`sessionId` 的 `SessionEnded` 变化，并在遇到第一个有效变化时立即返回；因此即使 `targetDestroyed` 与同一 `targetId` 的 recreate 已连续到达，renderer 也会先撤销旧 target scope、移除旧 session 并按 consumer 到 provider 的顺序尝试清理，再 attach 新 CDP session。重建 target 获得新的 scope epoch，旧 target principal 在销毁后和重建后都保持失效；导航离开规范 URL 只移除持久脚本并精确 detach 当前旧 session，不向已死亡 session 发插件命令。fake-CDP 夹具使用不同的旧/新 CDP session id 验证了这些时序。

该状态仍是实现候选，不是完整 M1c 完成声明：renderer binding 与 host RPC 的第一条纵切已经接入。每个插件在目标/session/generation 命名空间中拥有独立 `Runtime.addBinding`，bootstrap 在其上实现版本化 request/response/notification；host 在转发到 provider context 或固定的 `codlet.runtime.ping@1` endpoint 前重新核验 consumer principal、lease、provider registration/generation、target scope 和单调 request ID，旧 generation、撤销 scope、错误 session、重复/乱序 ID、超限/畸形请求与未知 binding 均在 endpoint 动作前拒绝。bundled adapter/codlet 已通过 `codex.ui.titlebar.afterMenu@1` 完成 provider/consumer 闭环，codlet 同时用 `codlet.runtime.ping@1` 验证真正的 renderer-to-host 路径；fake-CDP 回归覆盖 host ping、成功 provider 调用、request ID 重放、stale generation、unknown binding、wrong session、停用撤销和新 session 重建。内置插件启用状态现已使用严格 schema 的本地 registry，缺省只读、写入原子替换；`plugin list/enable/disable` 的命令级测试证明它们不启动 Codex，`launch` 会在任何外部启动副作用发生前验证 registry 并按状态构造插件图。该 host endpoint 仍只返回固定无副作用的 ABI ping，不代表 `runtime.manage` 或 L3 文件、进程、网络、系统 broker 已完成。外部插件目录、文件热重载、运行中 CLI 启停/重载、GUI 自我禁用和完整 `doctor` 诊断也仍未实现。真实 Codex gate 保持 ignored，未在自动化中启动客户端；当前安装 build `26.901.2854.0` 的实机 M1 GUI 门禁仍必须补齐后才能关闭 M1。

## 17. 主要风险

| 风险 | 影响 | 对策 |
|---|---|---|
| MSIX 直接启动不接受 inherited handles | 项目核心路径不可行 | M0 首先验证；不先建设插件系统 |
| Runtime Host 提前退出或失去 pipe | 插件能力消失，Codex 可能作为未扩展的托盘进程继续存活 | 记为 `DEFECT-002`；启动前端与会话级 Runtime Host 分离；插件失败隔离；保留 crash harness，且不伪造硬退出保证 |
| 已有官方纯净 Codex 时再启动 Codlet | Electron 单实例导致扩展实例无法建立 | 仅在 Codlet 本次启动中报告冲突并退出；不触碰现有 Codex |
| Codlet 扩展实例存活时从官方入口启动 | 官方启动被 Electron 合并到已有扩展主实例，无法获得独立纯净实例 | 记为 `DEFECT-001`；M0-M4 保留限制且不增加备用路径；M5 前必须关闭或阻断发布 |
| Codex 更新改变 target/DOM/React/preload bridge | L1/L2/L4 adapter 失效 | Core 与 adapter 分离；按 build 探测；provider 不注册并明确失败 |
| 私有 app-host envelope 漂移 | L4 写入错误、事件丢失或 approval 卡死 | build-specific schema 门禁；同 thread/turn/item 身份测试；不提供 fallback |
| 启动第二 App Server 访问同一 thread | 双事实源、写锁、重复 turn 或 UI 分叉 | 明确禁止作为透明 L4；只复用 Desktop 同一 connection |
| provider/consumer 卸载顺序错误 | consumer 使用陈旧 endpoint 或残留 DOM | capability graph 决定激活与反向停用；generation/epoch 拒绝旧调用 |
| main-world/raw CDP 插件冲突 | 页面异常或数据暴露 | 分级授权、明确授信、插件级诊断、可停用启动 |
| Codlet 被安全软件视为注入工具 | 安装/运行受阻 | 不改二进制、不注入 DLL、使用 pipe、代码签名、公开源码 |
| 插件生态过早膨胀 | 重演 Codex++ 的复杂度 | 首版仅本地目录、无市场、无远程更新、无独立管理器 GUI |
| `Codlet` 品牌撞名 | 搜索、包名、域名和法律风险 | 仅作开发阶段暂定名；Public Beta 前完成更名或正式风险决策 |

## 18. 开源与许可证

- 推荐项目代码使用 `Apache-2.0 OR MIT` 双许可证；
- 明确声明项目与 OpenAI 无隶属或官方认可关系；
- Codex++ 为 AGPL 项目，不复制其源码、注入脚本、UI 资产或实现细节；
- CDP 和 Windows API 部分依据公开协议和官方文档独立实现；
- 保留设计来源与第三方依赖许可证清单；
- public beta 前生成 SBOM，并对发布产物进行代码签名。

## 19. 品牌决策

`Codlet` 能表达“小而专注的 Codex 扩展单元”，读写也很轻巧，因此开发阶段采用 Codlet。它尚不适合直接冻结为公开品牌：已有同名[开发者代码市场](https://codlet.vercel.app/)、活跃的 [crates.io 包](https://crates.io/crates/codlet) 和 [GitHub 组织](https://github.com/codlet)；`codlet.com` 与 `codlet.app` 也已注册，并容易与开发者产品 [Codelet](https://codelet.app/) 混淆。

产品决策：

1. 源码、内部构建和本方案暂用 Codlet，不为名称反复阻塞技术验证；
2. 在 M6 前设置独立命名门禁；若继续使用 Codlet，必须完成专业商标检索并接受包名、域名和搜索可发现性成本；
3. 名称冻结前不制作正式 Logo，不注册无法迁移的公共账号；
4. 最终候选必须核验 GitHub、npm、crates.io、PyPI、主要域名和目标市场商标库。

## 20. 当前 Go/No-Go 问题

inherited CDP pipe、同 Browser Process 多窗口注入和第一方 GUI 的可行性已经获得实机证据；`DEFECT-001`、`DEFECT-002` 继续开放，M0 仍不能宣称完整关闭。当前下一门禁是：

> 通用 capability kernel 能否在不理解 Codex 私有结构的前提下，严格解析 provider/consumer、确定激活与反向停用顺序、隔离每个插件 world/generation，并让 `codex.ui.adapter` 与 GUI `codlet` 完成第一个真实、可逆、跨刷新和多窗口的 capability 闭环。

该门禁通过后进入 L3。L4 另有独立条件门禁：

> 当前 Desktop build 的 app-host MessagePort 能否在不暴露私有 envelope、不启动第二 App Server 的前提下，被第一方 Backend Adapter 稳定映射为同一 thread/turn/item 事实源。

L4 门禁不阻塞 L1-L3，但失败时必须禁止注册 `codex.backend.*` provider，不能降低产品诚实度来换取表面功能。
