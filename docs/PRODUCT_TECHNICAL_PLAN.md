# Codlet（暂定名）产品与技术开发方案

> 状态：Draft 0.33；日期：2026-09-11；平台：Windows-first，跨平台 P0 盘点已完成；产品名：开发阶段暂用 `Codlet`，公开发布名必须通过命名与商标门禁。

## 1. 执行摘要

Codlet 是一个面向 Codex Desktop 的轻量级运行时扩展内核。只有用户主动选择 Codlet 专用启动器时，启动前端才创建独立、会话级长驻的 Runtime Host；由 Runtime Host 启动官方 Codex、在整个 Codex 会话中持有继承式 CDP pipe，并通过通用 capability 基础设施装载、隔离和调度用户插件。

Codlet Core 不认识 Codex 的 DOM、React、task、turn、skill 或 provider 业务。已确认架构是开放 Core、可选托管运行时与可选 UI/backend adapter：Codex 私有知识可以由用户插件自行实现，也可以使用官方 adapter；管理 GUI 只是这些能力的普通消费者。产品提供可诊断、可热更新的运行时原语，让用户扩展 renderer、host 和 Codex backend；它不为插件安全或任意副作用的可逆性背书。

当前实现已交付运行中管理、watch、完整 M2 公开原语，以及 M3/M4 的托管主世界、可选 Desktop Adapter、同一 Desktop 会话读写/事件/审批和提交拦截。证据见 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)及 [M3/M4 验收记录](M3_M4_ACCEPTANCE_2026-09-10.md)。[2026-09-11 兼容补验](DESKTOP_COMPATIBILITY_2026-09-11.md)已修复测试客户端原生新建/冷恢复，并适配新构建；M0/M1 重复运行、官方入口与 crash 发布门禁仍保留。[P0 盘点](PLATFORM_P0_AUDIT_2026-09-11.md)已记录系统绑定与接口草案，尚未实现非 Windows 移植。

首批 [M3.1/M4.1 扩展](UI_HELPERS_AND_NAVIGATION_2026-09-11.md)已交付共享 UI helpers、语义外观、当前任务/运行回合事件、原生任务打开及拦截诊断。M5a 本地导入、授权预览、GUI 权限管理与移除已实现并完成自动回归，真实界面剩余流程按 [M5 手测指南](LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md)由用户验收。后续 M5b 扩展 GitHub 来源；独立 fileChange 审批继续按实机适用条件补验。Codlet 负责简单导入和管理，GitHub 与社区目录负责发现和维护信息，当前不建设独立 Codlet Market。具体工作包与完成标准见 [2026-09-11 后续开发计划](NEXT_DEVELOPMENT_PLAN_2026-09-11.md)。

术语约定：底层产品称为 Codlet Runtime；每个插件称为一个 codlet。随运行时发布的管理界面插件 ID 和列表名称均为 `codlet-gui`；工具栏入口与管理窗口标题为“Codlet”。旧 GUI ID `codlet` 保留为 CLI 别名与只读配置兼容名；显式新 ID 偏好优先，不因更名重新启用已禁用 GUI。

一句话定义：

> 一个启动前端、一个会话级长驻内核、一套通用 capability broker，以及无限的用户插件。

## 2. 已确认的产品决策

1. 修改 Codex 原生界面是核心需求，不是可选附属功能。
2. Windows 是当前首发基线；跨平台适配纳入后续计划，先检查平台边界，再按 OS/架构分别移植和验收，不把 Windows 通过记录扩写成其他平台已支持。
3. Codex 只有通过 Codlet 专用启动器才应进入扩展模式；官方入口启动原版纯净 Codex 是产品目标，但当前受 `DEFECT-001` 的 Electron 单主实例限制。
4. Codlet 不监视、不提示、不接管通过官方入口启动的 Codex，也不在后台等待或劫持后续启动。
5. Codlet 安装、升级和卸载均不关闭或重启 Codex，不修改或捆绑官方安装包、快捷方式、协议关联、配置与用户数据。
6. 插件目标模型允许 host、renderer 或其组合；纯 host 插件不必提供空 renderer 入口。同包双入口共享 generation/生命周期，Core RPC 支持 Host↔Host、Host↔renderer 的声明依赖、Runtime/Target scope 与取消。backend-session/thread 的业务映射由后续 adapter 提供，不进入 Core。
   两种入口属于统一的 JS/TS 目录包格式：`codlet.json`、构建后的 JS 入口、资源文件。TS 在构建时编译为 JS；host JS 在 Codlet 统一管理的 JS 进程执行，renderer JS 在页面执行。首版不接受任意 `.exe` 入口，不支持原生 Node 扩展，不提供运行时 TS 转译。
7. renderer 插件允许分级获得 isolated DOM、main world 和 raw CDP 能力。
8. 插件以用户明确授信的本地内容执行；M5 增加用户主动从 GitHub 发布包导入至本地的流程，不宣称提供安全沙箱。
9. 不修改 `app.asar`，不修改官方安装目录，不复制或再分发 Codex，不做 DLL 注入。
10. Codex 内的管理 GUI 由第一方 Codlet 插件提供，不写死在 renderer bootstrap 中。
11. 第一方插件默认启用但可完全禁用；禁用后不留下按钮、面板或观察器，CLI 始终是可恢复的控制平面。
12. inherited CDP pipe 是会话级 transport 与存活信号，Runtime Host 正常情况下必须与其启动的 Codex 同寿命；pipe 断开只会请求 Electron 执行协作式 `Browser::Quit()`，不是 Codex 进程必然退出的所有权保证。
13. Codlet Core 只提供通用插件 registry、lifecycle、capability graph、RPC transport、权限和诊断，不包含 Codex-specific selector、React 对象或 backend schema。
14. 托管 renderer 运行支持、Codex UI Adapter 和 Codex Backend Adapter 均是可选官方实现。第一方使用的底层接口同样向第三方开放；高权限来自显式 grant，不来自隐藏 provider ID 或特权加载路径。可选性不要求立即拆成独立进程、包或动态插件。
15. 插件能力分为四层：L1 `renderer.dom`、L2 `renderer.main-world`、L3 `cdp.*` / `host.*`、L4 `codex.backend.*`。层级描述语义和风险，不强制规定 adapter 的内部实现路径。
16. 官方 backend adapter 及任何声称操作当前 Desktop 会话的实现，必须证明同一连接与 thread/turn/item 事实源；独立 App Server 不能冒充透明 fallback。这是该语义承诺的正确性条件，Core 本身不依赖 App Server，也不把官方 adapter 作为用户插件的唯一 backend 通路。
17. Codlet 内置简单的插件导入与管理；GitHub 负责源码和版本发布，统一 Topic 与社区目录负责发现。当前不需要独立 Codlet Market。
18. 社区生态工作补充分发、发现、兼容性说明和维护规则，继续沿用现有内核、授权记录与生命周期设计。

## 3. 产品定位

### 3.1 目标用户

- 希望重塑 Codex Desktop 交互的高级用户；
- 希望发布界面增强、工作流和调试插件的开发者；
- 需要内部定制 Codex，但不想维护官方客户端 fork 的团队。

### 3.2 核心场景

1. 用户主动从 Codlet 入口启动 Codex，扩展自动加载。
2. 开发者将本地插件目录加入 Codlet，并可显式开启 watch；用户也可在后续 M5 中从 GitHub 发布包导入预览、授信和安装。
3. 插件增加侧栏、状态区、命令入口或修改现有交互。
4. 高级插件可在用户明确授权的底层原语范围内进入 main world，自行适配 React 或页面实际可达的 `electronBridge` 接口；不要求官方 adapter，也不构成 Electron main/Node 任意执行承诺。
5. 单个插件崩溃或启动失败时，Runtime Host 和 CDP pipe 保持运行，Codex 本身继续运行，Codlet 给出明确诊断。
6. Codex 更新导致适配能力缺失时，相关插件拒绝激活，不静默猜测兼容。

### 3.3 首版非目标

- 替换官方 provider 协议、把独立 App Server 冒充为当前 Desktop backend；
- 会话数据库、备份、导出和同步；
- 独立 Codlet Market、评分/交易系统、未经用户确认的远程安装或自动更新；
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
- 官方 adapter 未识别 Codex build：该 adapter 拒绝提供未验证的语义能力并给出诊断；只影响依赖它的插件，不阻断使用 Core 原语、自带适配的插件执行自己的探测与激活。

上述行为是产品不变量：Codlet 不安装预先常驻的服务，不监视官方入口；只有 Codlet 启动器被主动调用时才检查运行环境，并且只创建和控制本次会话的 Runtime Host 与 Codex 子进程。Runtime Host 在该 Codex 会话期间长驻，Codex 退出后随即退出。`DEFECT-001` 是已接受的当前缺陷，不改写这些产品不变量。

#### 4.2.1 已知缺陷：`DEFECT-001` 单主实例限制

当前 Codlet 约束的是独立 Electron Browser Process，不是 BrowserWindow 数量；Codex 仍可在同一主实例内创建多个窗口。在历史 build `26.825.6671.0` 中，对话右键“在新窗口打开”的实际路径是 `open-in-new-window -> createFreshWindow -> createPrimaryWindow -> new BrowserWindow`；它会创建新的 Windows 顶层窗口和 renderer，但不调用 `app.relaunch()`，也不创建第二个根 `ChatGPT.exe`。该缺陷只包含以下根级结果：

- 官方纯净实例先启动时，Codlet 拒绝再启动扩展实例；
- Codlet 扩展实例先启动时，后续官方启动会被 Electron 转交给该已有主实例，通常激活已有窗口；即使创建新窗口，它也不是独立纯净实例。

这是为保持当前内核简单而暂时接受的缺陷，不是 Codlet 的特性或长期产品语义。M0-M4 不为此增加多 profile、配置复制、已有实例附着或其他备用路径；进入 M5 前必须重新验收、修复或明确阻断发布。

2026-09-07 用户另外授权一次隔离客户端实验：复用官方程序，通过独立测试入口与全新数据目录验证并行实例，不复制生产配置、凭据或会话。该实验不改变普通 `codlet launch` 的冲突拒绝，不作为已支持的生产多 profile 功能，也不凭一次启动结果关闭 `DEFECT-001`。实际测试前核对当前包的启动、存储和 IPC 边界；测试控制只面向本次创建并持有身份的子进程。测试方案及结果单独记录，需要用户登录或工具拒绝界面操作时明确报告。

首次[实测结果](ISOLATED_CLIENT_RESULTS_2026-09-07.md)记录了官方 build `26.901.6511.0` 独立 Dev/WebSocket 实例的 Shell 超时和关窗后进程驻留。用户授权继续后的[修复复测](ISOLATED_CLIENT_REPAIR_2026-09-08.md)定位到启动时同步复制包内 Node 运行时阻塞主线程；实验入口现在先将这些静态文件准备到全新测试缓存，自动核验本次 PID 的启动日志后才加载插件，并通过本次客户端的原生 `quit-app` 入口退出。两个全新目录的 Shell 就绪分别为 942／950 ms，完整启动检查为 1875／1909 ms，正常退出为 1011／1112 ms。两个内置插件均确认激活，本轮全部测试进程和端口已清理，未使用强制终止；原客户端与原后台身份、Chrome native-host 注册前后相同。

本轮未登录、未发送模型任务，也未再使用 Computer Use 输入。GUI 挂载、交互、主题和窄窗布局仍未验收。上述结果只覆盖固定 Dev/WebSocket 实验条件，不关闭 M0/M1、`DEFECT-001` 或 Runtime Host 崩溃契约 `DEFECT-002`。

随后用户授权[登录后 GUI 验收](GUI_ACCEPTANCE_2026-09-08.md)，亲自完成登录与 Windows UAC。独立后台重启并重新读取已写入的配置后，Windows 设置循环解除；Codlet 入口和面板可见、Escape 可关闭，但插件列表持续加载，原生窗口刷新后入口消失。本轮 GUI 判定未通过。下一修复优先处理页面切换后的 renderer 上下文与真实就绪恢复，以及 RPC 无响应时的有界失败，再复验管理操作和布局。测试实例已正常退出；这次用户确认的系统级沙箱设置不构成“全部共享 OS 状态未变化”的证据。

上述段落记录修复前的 GUI 验收失败。随后 2026-09-08 的[GUI 根因修复与复测](GUI_REPAIR_2026-09-08.md)已完成其中的导航恢复、真实激活确认和 RPC 有界失败：主 frame 所有权不再被同名子 frame 覆盖，主文档导航按 provider → consumer 执行新的激活握手，隔离客户端中的插件列表、刷新、两次原生重载、明暗主题、窄窗、第二窗口和跨窗口自我停用均通过。该证据仍不关闭普通 `codlet launch` 的生产 M0/M1 门禁，也不关闭 `DEFECT-001` 或 `DEFECT-002`。

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

该命令启动前台 Runtime Host，在每个匹配 renderer 中为每个已启用插件创建独立的 isolated world，按统一 catalog 加载内置与授信本地插件，并为当前文档与后续导航安装同一 generation。插件启用状态与本地授权记录由 `%LOCALAPPDATA%/Codlet/config.json` 原子持久化；GUI 自我禁用已通过鉴权事务实现。运行中 CLI `enable` / `disable` / `reload` 通过独立的 authenticated control IPC 以 receipt 执行，离线只允许在证明无 Host 时保存 `enable` / `disable` 的下一次启动偏好；`codlet launch --watch` 仅监听已加载的本地插件源。手动 lifecycle 隔离实测、IPC native fixtures 与 watcher 候选回归已通过，但普通 `codlet launch` 的生产 M0/M1、GUI 和 launch+watch 实机门禁仍开放。

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

以下插件注册、离线偏好和运行中控制命令已经实现；它们不发现、启动、附着、关闭或重启 Codex：

```text
codlet plugin list
codlet plugin enable <id>
codlet plugin disable <id>
codlet plugin reload <id>
codlet plugin operation <receipt>
codlet plugin add <path>
codlet plugin add <path> --trust [--grant <permission>]...
codlet plugin remove <id>
```

`list` 在状态文件不存在时只显示内置默认值，不创建文件。在线 `enable` / `disable` / `reload` 先由 Host 准备 opaque receipt，再只提交一次并通过 `operation` 或结果查询读取状态；`enable` 不隐式开启未加载依赖，已加载 root 的恢复可在授权 guard 下重启其当前传递 dependents，`disable` 拒绝仍启用或运行的 dependents，`reload` 更新目标及其传递 dependents 并保留无关插件。只有证明该 registry 没有 Host 时，`enable` / `disable` 才可原子保存并注明只对下一次 `codlet launch` 生效；`reload` 无 Host 即拒绝。GUI 自我禁用另由已实现的鉴权管理事务完成。

`add` 缺少 `--trust` 时仅检查目录、显示权限并非零退出，不写配置。明确授信并显式授予所有请求权限后，保存 canonical 本地路径、固定插件 id 与 grants。`remove` 只忘记外部注册，保留源文件与启用偏好；无法移除内置插件。完整格式、边界与示例见 [LOCAL_PLUGINS.md](LOCAL_PLUGINS.md)。

以下命令已提供运行中只读查询，使用与 Host 相同路径的 Codlet 可执行文件：

```text
codlet status
codlet status --json
```

状态来自 Host 中的目标/插件采样，包含采样时间、generation、context 与激活确认；不通过 CDP 再次探测、不读插件配置，也不把 `ready` 当作 GUI 挂载或实机兼容性通过。Windows named pipe 限定当前用户和本地连接，区分未运行、忙、超时、版本不兼容及服务端身份拒绝。主文档导航会撤销旧作用域并按 provider → consumer 完成新的激活握手；恢复进行中或失败时保持未确认，成功后才将实际激活报告为 `active`。协议、限制与恢复语义见 [RUNTIME_STATUS.md](RUNTIME_STATUS.md)。

运行中控制使用 opaque receipt；提交后只允许查询，不自动重试或从 uncertain 在线结果降级为离线编辑。完整 CLI、receipt、scope、授权、回滚和 watcher 边界见 [RUNTIME_CONTROL.md](RUNTIME_CONTROL.md)。

```text
codlet plugin operation <receipt> [--json]
```

第一方 `codlet-gui` 插件默认启用。它使用普通 plugin manifest、生命周期和 renderer bridge，在 Codex 顶部应用栏的原生菜单之后增加一个紧凑按钮；点击后打开 Codlet 管理面板。按钮插槽由 adapter capability `codex.ui.titlebar.afterMenu` 提供，不允许插件散落硬编码 selector。当前面板通过 `codlet.runtime.manage@1` 的 `list` / `disableSelf` 最小事务显示内置与授信本地插件并禁用自身；该 capability 仍是 M2 完整 `runtime.manage` API 的先行纵切，不代表任意插件管理均已完成。

2026-09-07 明确 GUI 设计约束：第一方 Codlet 的入口、配色、字号、间距、悬停、焦点和关闭行为尽量遵循原生 Codex 客户端。入口应在顶部菜单的“帮助”之后，以普通同栏菜单文字呈现；管理面板采用紧凑设置界面。独立窗口是后续可选形式，不是本轮必需。GUI 仅消费 adapter 提供的挂载标记与 `--codlet-ui-*` 主题变量，原生 DOM 与主题令牌映射集中在 adapter；不复制官方素材。窗口变窄、主题切换、工具栏延迟创建或重建、列表失败与插件卸载都必须有明确且可恢复的行为。

仅对齐菜单与颜色不能视为原生风格完成。用户检查首版预览后要求进一步参考真实设置页、行、按钮、开关和弹层；同一组执行任务继续逐项对齐。更丰富的 UI adapter 能力规划见 [UI_ADAPTER_CAPABILITIES.md](UI_ADAPTER_CAPABILITIES.md)：挂载、主题/语义样式与通用控件交互分别维护，先以第一方 GUI 验证，再收敛可供本地插件复用的版本化接口；当前不宣称已实现完整组件库。

当前 build `26.901.6511.0` 的只读源码证据确认顶部菜单是 renderer DOM；Windows 主窗口移除了 Electron 原生菜单。adapter 在根标记 `data-codex-window-chrome="application-menu"` 下，验证 File/Edit/View/Help 四个 menuitem 的精确 ID、直属关系和顺序，将 mount 放在 menubar 的同排后继位置，不加入 Radix 私有键盘集合。历史 `header[data-app-shell-header-layout] [data-testid="app-shell-header-context-menu-surface"]` 仅保留为明确标识的 `legacy-header` fallback；它位于另一行，不等同“帮助”之后。`getMount` 返回稳定 token 和可选 placement；暂时无锚点时 GUI 等待 adapter 后续挂载。详见 [CODEX_UI_ADAPTER_EVIDENCE.md](CODEX_UI_ADAPTER_EVIDENCE.md)。2026-09-08 的隔离客户端 GUI 修复复测已通过；普通 `codlet launch` 的生产 M0/M1 GUI 门禁仍开放。

用户可在 GUI 中确认后禁用该插件；对应 CLI 已提供：

```text
codlet plugin disable codlet-gui
codlet plugin enable codlet-gui
```

GUI 自我禁用按固定事务执行：验证 `runtime.manage` grant 与依赖关系，原子写入 registry，尝试向调用 renderer 回包，然后从全部当前 target 卸载 GUI 并撤销其 capability principal；清理失败或 renderer 销毁造成的回包失败进入 Runtime Host 诊断，不结束 Host，已持久化的禁用状态继续生效。禁用后只保留 CLI；CLI 可通过匹配 Host 的在线 receipt 事务重新启用，也可在证明无 Host 时保存为下一次 `codlet launch` 的偏好。升级不得擅自重新启用用户已禁用的 GUI。若 Codex 更新导致所有已知顶栏锚点失效，GUI 保持未挂载，只在 adapter 再次找到精确锚点后恢复；持续不匹配需要适配更新。Host 的插件生命周期不等同 DOM 已挂载；2026-09-08 隔离客户端复测已确认列表、刷新、原生重载、主题、窄窗、第二窗口和跨窗口自我停用均可恢复，但普通 `codlet launch` 的生产 M0/M1 门禁仍开放。

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
├── optional plugin-host supervisor
└── diagnostics and logs
          │
          ├── optional managed renderer runtime
          │   └── worlds / bootstrap / binding / ready / recovery / cleanup
          ├── optional first-party adapter codlets
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

M0 只交付可实机验收的前台 Runtime Host 路径。M1 候选现已提供应用内第一方 GUI 与只读状态 IPC；独立后台化、具写权限的 Launcher/Runtime Host 控制命令和独立启动前端 GUI 仍是后续里程碑。

### 5.1 核心与适配器分离

2026-09-09 用户已确认底层原语开放、托管 renderer 运行支持与 UI/backend adapter 可选、插件隔离不构成安全保证，以及保留最小 Core 原语并避免过早拆包。历史依据、当前实现缺口和确认后的验收条件见 [Core 扩展边界](CORE_EXTENSION_BOUNDARY_2026-09-09.md)。该方向约束 M2–M4，不改写 M0/M1 的已有验收条件；首个 host/raw 请求与事件接口已在 M2a 落地，完整运行后端与便利 API 继续后续交付。

稳定内核负责：

- Windows 启动和 pipe 生命周期；
- CDP request/response/event 路由；
- 插件 ABI、注册表、状态机、generation 和错误模型；
- capability provider/consumer 注册、精确版本匹配、依赖排序和循环拒绝；
- scoped RPC transport、权限确认、日志和诊断。
- 最小插件装载、host 进程通信及原始 CDP 请求/事件接口，允许不依赖任何官方功能插件的单一用户插件工作。

可选托管 renderer 运行支持负责高级 world/bootstrap/binding ABI、导航恢复、ready 握手与清理便利。用户可采用它，也可用 Core 原语自行实现相同职责；Core 保留启动第一个插件所需的最小机制，不形成自举循环。

可选 Codex adapter codlet 负责：

- 识别 Codex build 和同一 Browser Process 内的全部 renderer target；
- 提供版本相关的 DOM anchor、React hook、preload bridge 和 App Server 语义；
- 对目标 build 执行兼容性探测。

用户插件可选择依赖 adapter capability 来减少适配代码，也可直接使用 Core 原语，自行处理 main-world/CDP、导航恢复和 backend 接入。Core 不要求官方 adapter 或 provider ID，也不为第一方提供 Codex-specific 特权分支；选择 raw 路径的插件自行维护兼容性与副作用清理。

### 5.2 四层 capability 模型

| 层级 | capability namespace | 面向插件的语义 | 典型实现 | 稳定性 |
|---|---|---|---|---|
| L1 | `renderer.dom.*` | DOM mount、CSS、事件、可逆 UI 资源 | isolated world + 共享 DOM | build adapter 稳定 |
| L2 | `renderer.main-world.*` | 页面全局、React state、私有对象、preload bridge | main world adapter | build-specific、高漂移 |
| L3 | `cdp.*` / `host.*` | raw CDP、文件、进程、网络、系统能力 | Runtime Host broker / plugin host | Codlet 自有契约 |
| L4 | `codex.backend.*` | thread、turn、item、skill、model、provider、approval | Desktop 同一 App Server connection 的 adapter | 官方语义 + 私有接入 |

层级不是插件继承关系。插件只声明自己实际需要的 capability；例如纯 UI 插件不因依赖 L1 而自动获得 L2-L4。L3 区分两类授权与路由接口，它们不构成插件安全沙箱：

- `cdp.raw`：直接向目标 session 发送 CDP method；
- `host.fs`、`host.process`、`host.network`、`host.system`：由 Runtime Host 在授权后提供的系统能力。

官方 L4 adapter 使用 App Server 的 `Thread -> Turn -> Item` 语义；产品 UI 中 task/conversation 的映射不进入 Core。L4 是业务语义层，不是另一种注入技术：用户插件可基于通用原语自行实现，或选用经 L2 private bridge 等路径实现的官方 backend capability。

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

官方 pre-submit interceptor 是可选 adapter capability，不是 Core 内建业务钩子。该接口中的多个 interceptor 按用户明确配置顺序串行执行，每个接收上一个的结构化结果；拒绝、超时或异常必须阻止提交并给出来源，不允许绕过失败插件继续发送未经确认的输入。用户自带实现不必依赖这套官方接口，其行为与承诺由自身定义。

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

### 6.5 跨平台准备

P0 立即盘点客户端发现、进程/pipe、authenticated 本地 IPC、Host 资源回收、路径/锁/原子写入、Node 产物与打包中的系统依赖。通用契约与生命周期保持共享，现有 Windows 行为作为平台接口的第一份实现。P1 按官方客户端可用性、启动机制与测试环境逐个平台完成纵切和验收；具体范围见 [跨平台工作包](NEXT_DEVELOPMENT_PLAN_2026-09-11.md#p0--p1跨操作系统适配)。

## 7. 插件模型

### 7.1 目录结构

```text
example-plugin/
├── codlet.json
├── dist/
│   └── host.js 或 renderer.js
└── assets/               # 可选资源
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

M2a 的 schema 1 manifest 已支持独立 host JS 入口，不需要 renderer 空壳；必须申请并获授 `host.process`，使用 CDP 还须 `cdp.raw`。`host.entry` 是插件根目录内的 `.js`/`.cjs` 路径，导出与 renderer 一致的 CommonJS `activate(context)` / `deactivate()`。Codlet 持有统一 Node 可执行文件、bootstrap、stdio 与生命周期，插件不选择可执行程序、运行参数或传输协议。当前也可声明组合入口：顶层 capability 属于 renderer，host.provides 属于 Host；完整示例见第 16.13 节。Host-only 格式如下：

```json
{
  "host": {
    "entry": "dist/host.js"
  }
}
```

当前实现已有 capability dependency graph，本地 loader 不处理远程来源，也没有包依赖或 semver 求解。M5 的 GitHub 导入解析具体发布资产并落为本地安装内容；capability 依赖模型继续沿用。插件包版本与 capability API 版本分别记录，不因新增来源引入另一套依赖求解器。

JS/TS 的统一限定不缩小公开 CDP 请求与事件原语。host JS 可以自行注入、恢复、适配或建设便利层；不要求官方 adapter。语言的图灵完备性与执行器实际开放的系统接口是两个问题，Core 仍需提供可达原语。Node host 的普通用户权限和可直接文件/网络/进程访问不构成安全沙箱；禁用原生 Node 扩展也不是任意副作用可回滚的证明。分发、TS 构建与旧格式迁移见 [统一 JS 运行时合约](JS_PLUGIN_RUNTIME_2026-09-09.md)。

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

权限不是 OS 沙箱。用户明确授信表达允许执行，不是代码安全的证明。Core 可验证自身管理的消息、generation 撤销、声明的依赖/冲突与资源归属；共享 DOM、main-world patch、raw CDP 和普通用户权限 host 程序的所有副作用或相互干扰不在安全与完整回滚保证内。

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

第一方 GUI 的插件 ID 与列表名称为 `codlet-gui`。它随 Runtime 发布并默认启用，在内核看来仍是普通插件；旧 ID `codlet` 的偏好仅作兼容读取，显式更新 GUI 偏好时才在 registry 合并锁内保存新 key 并移除旧 key：

- 使用相同的 manifest、activate/deactivate、generation、权限和错误模型；
- 顶栏位置消费 `codex.ui.titlebar.afterMenu@1`，共享控件消费 `codex.ui.appearance@1` 与可选 `context.ui`；私有主题和布局映射仍由 UI Adapter 提供；
- 管理面板通过公开、版本化的 `runtime.manage` API 工作，不调用隐藏 IPC；
- 发布清单记录该第一方插件的内容摘要与权限授予，第三方插件请求同一权限时仍需用户明确授权；
- 自我禁用前明确说明“禁用后只能通过 CLI 重新启用”；确认后先提交配置，再执行 deactivate；
- deactivate 必须移除按钮、面板、样式、listener 和 observer，不能残留不可见后台逻辑。

现有面板承担运行时状态、插件列表、启用/禁用、重载和诊断。M5 在同一第一方 GUI 内提供“插件”页面，补齐本地/GitHub 导入、权限查看/撤销、移除与浏览社区入口。所有动作复用公开管理接口和既有生命周期，保持 CLI 可恢复。

### 7.6 第一方 adapter codlets

`codex.ui.adapter`：

- 持有 L1 的 build-specific DOM selector、挂载与原生外观映射；M3.1 扩展语义外观与经过验证的挂载位置；
- L1 纵切只提供共享 DOM mount token，不向消费者传递 DOM node 或 JS function；
- adapter 在共享 DOM 中创建 target/document-local mount marker，consumer 在自己的 isolated world 中按 token 解析；
- Codex 重建 header 时 adapter 重建 marker，consumer 重新挂载自身 UI；
- consumer 先停用，adapter 后停用，确保资源回收顺序与 capability graph 一致。

`codex.desktop.adapter`（当前承载 L2 / L4 的可选目录包）：

- 复用已有 app-host 服务与 Native request client；当前构建的普通 App Server 请求经原 client、preload 和 Electron main 进入同一个 Desktop connection；
- 将私有 envelope 映射为版本化的 `codex.backend.read/write/events` 方法，以及 `codex.ui.preSubmit` 和兼容性诊断；
- 官方语义 API 不把 `window.electronBridge`、内部 manager、request id 或 host routing object 当成稳定公开类型；用户仍可经公开底层原语自行适配，不由 Core 设置官方独占通路；
- Desktop build 未通过 schema、身份、事件流和写入门禁时，该 adapter 拒绝注册相应 L4 provider；不阻断不依赖它的 raw 插件；
- 不启动独立 App Server 作为静默 fallback。

### 7.7 插件导入、发现与维护

| 部分 | 职责 |
| --- | --- |
| Codlet | 导入、显示来源/版本/权限/兼容性、启停、重载、移除及显式更新/回退 |
| GitHub | 作者维护源码、发布构建包与变更记录，通过统一 Topic 帮助发现 |
| 社区目录 | 插件介绍、分类、推荐、已测兼容性、维护状态，以及导入链接或 CLI 指令 |

“插件”页面提供“从本地文件夹导入”“从 GitHub 链接导入”“浏览社区插件”。GitHub 来源先定位具体 release/资产，再展示来源、版本、兼容性和权限，确认后导入本地目录，按用户选择进入现有启用流程。社区入口使用同一导入通路；具体 CLI 语法及深链接协议在实施阶段冻结，不把尚未实现的命令当作现有能力。

开发目录引用原路径，移除注册时保留作者文件；托管安装目录独立记录来源、版本、内容摘要与所有权。更新候选准备完成后，沿用授信检查、generation 替换、receipt 查询和失败补偿。发布包规范、兼容性元数据、维护/失效/移交规则见 [后续开发计划](NEXT_DEVELOPMENT_PLAN_2026-09-11.md)。

## 8. 可选托管 Renderer bridge

本节描述官方托管运行支持的便利 ABI。当前 M1 尚将它实现在 RendererRuntime 内；M2 起先解除通用装载与 renderer 必填的耦合，再明确可选/可替换接口，不要求立即拆独立部署单元。直接使用 Core 原语的插件可自行实现注入、world、通信和恢复，不必采用本节全部约定。

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
4. 官方托管 renderer bridge 不把 Node、原始 `ipcRenderer` 或任意 Electron main IPC 封装为默认便利能力；raw 路径按已授予原语工作，不隐含新增原生注入或 Electron main 任意执行承诺。
5. raw CDP、main world 和 host process 必须逐项显示高风险授权。
6. 插件来源和入口路径在激活前 canonicalize；越出插件根目录即拒绝。
7. 通用协议、资源归属或已声明依赖无效时 Core 给出失败；Codex target/build 的语义兼容性由选用的 adapter 或用户实现判断。官方 adapter 失败不形成其他 raw 插件的全局禁令。
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
- 第一方 `codlet-gui` 插件的按钮挂载、面板开关、自我禁用和 CLI 重新启用。

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
- 第一方 `codex.ui.adapter` 真实提供 `codex.ui.titlebar.afterMenu@1`，第一方 GUI `codlet-gui` 只消费该 capability，不再拥有 header selector；
- provider 到 consumer 顺序在初始窗口、刷新、DOM 重建、主文档导航恢复和“在新窗口打开”中一致，并由真实 ready handshake 确认；
- consumer 到 provider 的反向停用能移除按钮、面板、mount token、style、listener 和 observer；
- 本地 registry、文件热重载、CLI 启停/重载与 GUI 自我禁用可用；
- `codlet doctor` 给出 build、target、capability provider、插件 generation 与可行动的错误原因。

### M2：L3 Host/CDP 与权限门禁

先交付并验收开放 Core 原语，再用相同公开接口建设官方便利层。保留现有通用 capability kernel，解除通用插件装载/lifecycle 与 RendererRuntime、renderer 必填入口的耦合。可选性先通过接口、依赖方向和可停用/可替换关系落实，不要求逐层拆包或增加进程。

M2a/M2b 交付独立 JS host、公开 CDP 请求/事件、同一 CLI receipt 的在线生命周期，以及 watch、有限清理、执行诊断和组合包。本次完整 M2 候选补齐 Host 主动 RPC、Runtime/Target scope、目录/网络/进程/系统独立 broker、完整授信记录与撤销、公开 `runtime.manage@1` 和第一方 GUI 的启停/重载。单一 `raw-m2` Host 示例通过自己的 binding 与新文档脚本维护多窗口消息通路；Core 在旧代退役时归还跟踪的 raw session。逐条证据与验证边界见 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)，现行流程见 [Host 开发说明](HOST_DEVELOPMENT_2026-09-10.md)。早期阶段记录保留其当时的范围。

验收条件：

- 禁用全部可选官方功能插件后，Core 加一个自带实现的第三方 host 插件能够启动；不要求 renderer 空入口、官方 adapter、官方 provider ID 或隐藏特权；
- 该插件能通过公开 CDP 请求/事件与 host 通信原语自行注入 renderer、处理导航恢复并建立所需消息通路；跨层扩展不依赖官方托管 ABI，后续 L4 的 Codex 私有映射留在插件中；
- 第一方将使用的底层接口也向第三方开放，官方 adapter 的缺失或不兼容只影响它的声明依赖者，不阻断自带适配的 raw 路径；
- 可选 host process、JSONL RPC 和按插件隔离的 Job Object 可用；
- `cdp.raw`、`host.fs`、`host.process`、`host.network`、`host.system` 使用独立 broker endpoint；
- 每项高风险权限在首次使用前显示并持久记录授权，撤销后使受管理 endpoint 与对应旧 generation 失效；明确授权不是安全证明，无法据此保证已执行程序的任意副作用撤回；
- 公开、版本化的 `runtime.manage` API 能支持第一方 GUI 查询、启停和重载插件；
- host crash、hang、malformed response、deadline 和越权的受管理调用都有确定结果，清理 Core 所持有的资源；不承诺任意恶意程序无法干扰其他插件或 Codex；
- 通用插件 RPC 的 request、response、notification、server-request、generation 和错误语义由 Core SDK 固化，可选托管 renderer ABI 复用这些语义；raw 插件不必使用官方 binding/bootstrap 实现；
- 示例 host 插件完成获准目录读取和网络请求，撤销后拒绝对应受管理调用；单独记录普通用户权限进程仍不是 OS 沙箱。

### M3：可选托管运行时与 L2/UI Adapter 门禁

M3 官方实现消费 M2 已向第三方公开的同一组原语；其兼容性承诺不成为 Core 的全局白名单。

2026-09-10 已实现 M3/M4 开发候选，定向自动检查及隔离实机验收通过，见 [验收记录](M3_M4_ACCEPTANCE_2026-09-10.md) 和 [开发说明](DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md)。主世界与会话语义集中在新的可选目录包 `codex.desktop.adapter`，现有低权限 `codex.ui.adapter` 与 GUI 继续使用 isolated world。

验收条件：

- 官方托管 renderer ABI 的 world、bootstrap、binding、导航恢复、ready 与清理支持可选择、停用或替换；不选它的插件仍可自行实现这些机制；
- 选择托管 main-world ABI 的插件必须申请 `ui.mainWorld`，且与 isolated world 使用不同 binding/principal；自行使用 raw CDP 的插件按其底层授权与资源归属处理；
- 可选 Desktop Adapter 对当前 build 探测页面 global、React/私有对象和 `window.electronBridge`，缺失时仅拒绝自己的相应 capability；
- 官方稳定 API 不暴露原始 `ipcRenderer`、任意 Electron main IPC 或未声明页面对象；这不禁止第三方在既定 raw 原语范围内自行适配，也不新增任意 Electron main/原生注入承诺；
- 官方 pre-submit interceptor 在实际 `turn/start` 前按确定顺序运行，失败时阻止提交并标明插件来源；该业务规则不进入 Core；
- main-world patch 无法热卸载时明确要求 renderer reload，不伪造可逆性；
- Codex 更新后的官方 capability drift 可由自动探针和 `doctor` 定位；同时验收关闭官方 UI adapter 后，自带实现的单一用户插件仍可通过底层原语工作。

### M4：可选 L4 Backend Adapter 门禁

L4 由用户插件或可选 adapter 基于 Core 原语实现，Core 不引入 thread/turn/approval 私有业务。以下连接/语义兼容性条件约束官方 backend adapter 及其对当前 Desktop 会话的承诺，不是所有插件访问底层连接的前置条件。

当前候选的 v1 写接口限定于本窗口已经加载且拥有事件流的任务。已验证真实 Desktop 发起回合、SDK 写入、相同 Thread/Turn/Item 标识、steer、interrupt、命令拒绝和问答回复。2026-09-11 已将此前 `features.thread_tools` 拒绝定位到测试协调器的严格配置模式，并补齐专用 WS 后端的禁用 app-tools transport；当前已审核构建的原生新建和完整重启后的冷恢复均通过，不再依赖最小请求预热。

验收条件：

- 禁用全部可选官方功能插件后，Core 加一个自带实现的用户插件仍能完成所需跨层功能；其 L4 适配不能依赖官方 provider ID、隐藏特权或未向第三方公开的接口；
- 官方 adapter 复用 Desktop 同一个 App Server connection。当前构建复用已存在的 app-host MessagePort 服务和原 Native request client；普通 App Server 请求由原 client 经 preload / Electron main 路由。不会再次发送 `connect-app-host`、替换原 view 连接或将第二个 backend 冒充透明替代；
- 官方 adapter 用 `Thread -> Turn -> Item` 语义提供 thread read/list、turn start/steer/interrupt、item stream、skill/model/provider read 和 approval/server-request 往返；
- 证明 Desktop 发起的 turn 与 Codlet 观察到的事件拥有相同 threadId/turnId/itemId，Codlet 写入也由当前 Desktop UI 和同一事件流观察到；
- 私有 app-host envelope、hostId、request id 和 manager object 不进入 Core SDK；官方语义 SDK 只承诺自己的稳定类型，不阻断用户插件自行维护私有映射；
- 官方 adapter 区分 input rewrite、context injection、presentation transform 和 authoritative history mutation；未证实的 assistant item rewrite 不作为已支持能力开放；
- build/schema/身份/事件流任一门禁失败时，该 adapter 的相关 L4 provider 不注册且不回退到独立 App Server；不依赖它的 raw 插件仍可执行自己的探测与激活。

### M3.1 / M4.1：插件 UI 与 Desktop API 扩展

这是 M3/M4 候选后的功能迭代。2026-09-11 首批已实现：M3.1 提供按钮、开关、设置行、状态、设置/确认弹窗、焦点与资源清理，管理 GUI 和普通 UI 示例复用；M4.1 提供 selection.get/selection.changed、threads.open 原生冷恢复，以及拦截器启停、顺序与耗时/失败代码诊断。新增导航仅在页面 26.903.71938 / 8576 验证，不替旧构建宣称支持。更多宿主挂载位置、展示变换和 richer input/server-request 继续按证据扩展。

验收采用管理 GUI 和一个独立用户插件，验证相同公开 API、多窗口、主题/缩放/键盘、卸载/重载和缺失能力。私有映射继续留在可选 Adapter；接口扩展不改变既有内核与生命周期。首批范围完成后即可支持 M5 管理页，完整 UI 框架不作为 M5 的前置条件。

### M5：Private Alpha 门禁

交付顺序分为 M5a 本地插件导入与管理、M5b GitHub 导入与社区发布规范、M5c 安装交付与发布验收；M3.1 的 UI helpers 可与 M5a 的管理页需求交替推进。

验收条件：

- 用户级安装、升级和卸载可重复通过，发布产物带测试签名；
- “插件”页面的本地/GitHub 导入、来源/版本/权限预览、启停/重载/移除与 CLI 共用现有管理机制；
- GitHub 发布包、兼容性元数据与社区维护规则可供独立作者使用，社区入口只导向相同的导入流程；
- 安装包不包含 Codex 文件，不修改官方包、官方入口、协议关联、配置或用户数据；
- Codlet 运行时安装、升级和卸载期间不检测、关闭或重启 Codex；插件更新仍由当前会话的管理 receipt 与生命周期协调；
- 关闭 `DEFECT-001`：官方入口与独立 Codlet 入口并存，官方入口连续启动均保持原版纯净行为；
- 日志、诊断包、safe mode 和故障恢复文档能定位所有已知启动与插件故障；
- 第 14.3 节实机门禁全部通过。

### 跨平台准备与移植：P0 / P1

P0 与当前开发同步，建立 Windows x64/arm64、macOS、Linux 的平台差异和验收矩阵。P1 在 P0 证据和 Windows M5 交付基础上逐个平台打通启动、Host/renderer、导入/管理、Desktop 语义与退出/回收。支持状态按 OS/架构/官方构建分别发布，未验证的平台不标为已支持；具体先后取决于官方客户端与可用测试环境。

### M6：Public Beta 门禁

验收条件：

- 至少经历一次真实 Codex 更新并完成 UI/Backend adapter 适配；
- 安全评审、依赖许可证清单、SBOM 和发布签名流程完成；
- 插件开发文档、模板和三到五个覆盖不同权限层级的示例完成；
- 安装、升级、卸载、Runtime Host 异常退出及其协作式 pipe-disconnect 结果、插件崩溃和 Codex 更新路径全部通过发布门禁；`DEFECT-002` 必须关闭或明确阻断发布；
- 公开品牌、包命名空间、域名与商标风险完成核验并冻结。

## 16. 当前开发工作包

当前执行队列以 [2026-09-11 后续开发计划](NEXT_DEVELOPMENT_PLAN_2026-09-11.md) 为准；下文保留此前各轮工作包与实现历史。

2026-09-07 的审查与任务拆分见 [REVIEW_AND_EXECUTION_2026-09-07.md](REVIEW_AND_EXECUTION_2026-09-07.md)。保留既有 capability kernel 与 adapter 边界，按以下依赖关系继续推进：

1. **内核可靠性与诊断**：集成可重入 lifecycle/provider RPC、跨进程 registry 合并事务和只读 `doctor --json`，通过统一自动化门禁。`doctor` 在有匹配 Host 时通过 authenticated scoped `Inspect` 增加一份 owner/kernel runtime sample；无 Host、其他 registry 或不支持 Inspect 的 legacy Host 仍报告 unavailable，不因这些情况单独退出 1。实际 target/generation/provider readiness 来自同一次 owner publication，status v1 保持独立。详见 [DOCTOR_RUNTIME.md](DOCTOR_RUNTIME.md)。
2. **本地插件目录（候选已实现）**：显式加载用户授信目录，严格校验 manifest、entry 路径和 grant，复用内置插件的 registry、catalog 与依赖图。新增权限需显式授权，目录损坏时仍能禁用或忘记注册。
3. **原生 GUI 与运行状态（候选已实现）**：入口移到当前 build 的菜单行 Help 之后，主题/私有 DOM 集中在 adapter，补齐列表重试、确认、焦点和挂载恢复。Windows 只读 IPC 支持 `status [--json]`，不扩大现有生命周期管理权限。2026-09-08 隔离客户端 GUI 修复复测已通过列表、刷新、原生重载、主题、窄窗、新窗口和自我停用；普通 `codlet launch` 的生产 M0/M1 门禁仍未关闭。
4. **运行中控制（M1c 候选已实现）**：CLI `enable` / `disable` / `reload` 通过独立 authenticated control IPC 使用 prepare/submit/result receipt，由 GUI 与 CLI 共用前台 lifecycle executor；手动控制、依赖拒绝、generation 换代、授权 guard、失败回滚和多 target 回归已通过。
5. **文件热重载（已实现）**：`codlet launch --watch` 观察已加载 local 的 `codlet.json` 与声明的 renderer/host 主入口。renderer 沿依赖闭包换代，host 固定加载时 root 和完整 grants；两者共享有界扫描与 CLI 优先调度。失败源不会因补偿代数变化循环重启，未尝试的排队守卫拒绝可以重新稳定观察。host watch 的真实 Codex 验收仍待后续。
6. **当前 build 实机门禁**：在专门启动的 Codlet 会话中验证 GUI、导航、DOM 重建、多窗口和正常退出。2026-09-07 只读检测到 `26.901.6511.0`；2026-09-08 隔离客户端 GUI 修复复测已通过，但该结果仍不构成普通 `codlet launch` 的生产兼容性通过证据。

第 1 项是后续加载与控制工作的前置；第 2-5 项涉及相同生命周期文件，运行控制与 watcher 候选已完成本批集成和回归。真实生产门禁全部满足前，M0/M1 仍保持未关闭。L4 只读研究不阻塞 M1/M2，也不允许以第二 App Server 路径提前伪造完成。

### 16.1 第一轮审查前的实现基线

截至 2026-09-04，工作树已包含 M1b capability kernel 候选，以及 M1c 的第一条 renderer 鉴权纵切：structured manifest、精确 API/scope、确定性依赖排序、每插件独立 isolated world、第一方 `codex.ui.adapter` mount token 和仅消费 token 的 `codlet` GUI。capability resolve 现在签发 opaque `CapabilityPrincipal`；provider id、consumer/provider registration epoch 和 scope epoch 只保存在 Core 内部，不通过 principal API 或错误暴露。Renderer Host 将 target/plugin/generation 对应的可信 principal 与注入 JS 的 plugin context 分开保存；每次 invoke 都在执行授权动作前重新核验 consumer/provider generation、registration 和 scope。插件换代、provider 注销或 scope 撤销后，旧 principal 均明确失败且不会执行动作，同一名称和 generation 的重新注册也不能复活旧 principal。

target controller 现在按顺序向 Runtime Host 暴露 `Attached`、`NavigatedAway` 和带 `targetId`/`sessionId` 的 `SessionEnded` 变化，并在遇到第一个有效变化时立即返回；因此即使 `targetDestroyed` 与同一 `targetId` 的 recreate 已连续到达，renderer 也会先撤销旧 target scope、移除旧 session 并按 consumer 到 provider 的顺序尝试清理，再 attach 新 CDP session。重建 target 获得新的 scope epoch，旧 target principal 在销毁后和重建后都保持失效；导航离开规范 URL 只移除持久脚本并精确 detach 当前旧 session，不向已死亡 session 发插件命令。fake-CDP 夹具使用不同的旧/新 CDP session id 验证了这些时序。

该状态仍是实现候选，不是完整 M1c 完成声明：renderer binding 与 host RPC 的第一条纵切已经接入。每个插件在目标/session/generation 命名空间中拥有独立 `Runtime.addBinding`，bootstrap 在其上实现版本化 request/response/notification；host 在转发到 provider context、固定的 `codlet.runtime.ping@1` endpoint 或 `codlet.runtime.manage@1` endpoint 前重新核验 consumer principal、lease、provider registration/generation、target scope、grant 和单调 request ID，旧 generation、撤销 scope、错误 session、重复/乱序 ID、超限/畸形请求与未知 binding 均在 endpoint 动作前拒绝。activation ready handshake 已接入：CDP pending request 的 response 与 event 共用 activity epoch/condition variable 和原始 deadline；Host 等待 activation `Runtime.evaluate` 时持续处理同 session binding；bootstrap 的 activating candidate 只可接收自身回包，不进入 `status` 或 provider dispatch；ready 成功且持久脚本安装后 Host 才标记 active。fake-CDP 在扣住 activation response 的条件下依次完成 ping、manage list 和跨 world adapter provider 请求，并验证 activation 内管理动作在落盘前以 `plugin_not_active` 拒绝及反向回滚；另一个无回包场景验证 candidate 在原 request deadline 到期后确定失败、反向回滚且 Host 继续接受命令。bundled adapter/codlet 已通过 `codex.ui.titlebar.afterMenu@1` 完成 provider/consumer 闭环，codlet 用 manage 的 `list` / `disableSelf` 完成首个持久化管理事务。内置插件启用状态使用严格 schema 的本地 registry，缺省只读、写入原子替换；`plugin list/enable/disable` 的命令级测试证明它们不启动 Codex，`launch` 会在任何外部启动副作用发生前验证 registry 并按状态构造插件图。自动化回归证明 self-disable 在 grant 拒绝时不落盘，成功时先持久化、再尝试向 caller 回包、最后从当前 target 清理并撤销；清理错误和已持久化后的回包错误只进入可读取诊断，Host 仍接受后续 target/命令。完整 `runtime.manage`、外部插件目录、文件热重载、运行中 CLI IPC、任意插件启停/重载和完整 `doctor` 诊断仍未实现；2026-09-07 已补齐 deactivate 内主动 RPC 与 awaited renderer-provider handler 的通用可重入等待：嵌套调用继承同一个绝对 deadline，并限制为最多八层；主动停用保留清理回包路由，真实 target 销毁则先撤销 session liveness，普通回包失败只进入诊断。该 deadline 限制 Host 等待，不承诺硬中断已经执行的插件 JavaScript 或回滚不可逆副作用。真实 Codex gate 保持 ignored，未在自动化中启动客户端；当前安装 build `26.901.2854.0` 的实机 M1 GUI 门禁仍必须补齐后才能关闭 M1。

### 16.2 2026-09-07 审查推进

三个独立 Astra xhigh 执行任务分别完成了生命周期、配置事务与只读诊断；前两项在独立 worktree 开发，主任务负责审查、整合和组合验证。

- lifecycle、provider handler 和 deactivate 共用有界的 binding pump；清理中插件可收回包，但不能作为 active provider 被新调用。真实 target 销毁会使原 session clone 失效，旧请求不可向重建 target 派发。合法的 provider `null` 返回值与缺失 `value` 字段分别处理。
- registry 使用持久 sidecar 文件上的 OS 锁，在锁内重读、严格校验并只合并明确修改项。不同插件的并发修改不会丢失，同一插件以最后成功提交的值为准；争锁最多等待两秒，进程退出会释放锁。成功刷新内存快照，失败保留待提交项供显式重试。
- `codlet doctor` 与 `codlet doctor --json` 汇总包、路径、进程快照、registry、内置 catalog 和静态依赖结果。JSON schema 为 `codlet.doctor/v1`，检查失败返回退出码 1；已运行 Codex 仅阻塞未来 launch，不导致只读 doctor 失败。没有 Runtime Host IPC 时，target、generation、provider-ready 和兼容性均明确标为未探测。

这些是 M1 候选实现的推进，不替代外部实机门禁，也不关闭 `DEFECT-001` 或 `DEFECT-002`。全部验证结果及后续状态由本轮 review 文档记录。

### 16.3 本地插件目录纵切

本轮在两个独立 Astra xhigh worktree 实现本地注册持久化与目录加载器，并复用诊断任务整合 catalog、运行时和管理 GUI；主任务完成 CLI、示例、系统 API 绑定整合与组合验收。

- Registry schema 2 新增 `localPlugins`；schema 1 保持只读兼容，只有显式成功保存才原子迁移。启用偏好按字段合并，注册/权限修改在锁内对完整原记录做比较，冲突不部分提交，也不因无关启停重放旧授权。
- `plugin add` 采用显式 `--trust` 与逐项 `--grant`，当前仅支持 isolated renderer 的 `ui.dom` / `runtime.manage`。正常启用还核验被验证的授权记录在提交时未被改变；禁用与移除不依赖插件文件可读取。
- 目录加载器复用 manifest/capability 解析，限制 manifest 128 KiB、source 1 MiB。规范化显式本地 root，拒绝 UNC/设备根、目录内链接、junction、硬链接、路径别名、越界和非 UTF-8 文本。通过打开的文件句柄校验最终路径与 link count，使用已有 `windows-sys` FileSystem 绑定；不执行或分析 JavaScript，不宣称 OS 沙箱或跨文件原子快照。
- 启动前构造统一 catalog 并验证启用项；已禁用坏目录只保留逐项诊断。通用 capability kernel 仍识别四种 scope，但目前 renderer RPC 只路由 target-scoped requirements；外部插件不可路由的依赖在启动前失败。
- `doctor` / GUI 可识别本地来源、路径、grants、请求权限与验证结果。运行中管理列表使用启动快照，`active` 来自调用 target 的真实 Active 状态；面板打开时重新查询，避免 activation 期间的快照永久隐藏自禁用开关。
- `examples/local-echo` 保持既有 `module.exports` ABI，通过 awaited Host ping 后提供 `example.echo@1`；Node 测试使用真实 bootstrap 验证准备、调用和卸载。

本轮历史记录没有启动、附着或结束真实 Codex，也没有修改真实用户插件配置；当时运行中 CLI IPC、文件 watcher、手动 reload 与当前 build 的实机门禁仍是后续工作。本批随后完成了运行控制与 watcher 候选的集成回归，真实生产门禁仍另行开放。

### 16.4 原生 GUI 与只读 Host 状态

三个独立 Astra xhigh worktree 完成 GUI、适配器与 Windows 状态 IPC，主任务审查并集成；用户反馈首版只匹配菜单与主题后，复用 GUI/adapter 两个执行任务继续依据真实组件修正。

- 菜单定位以当前包的 DOM menubar 和 Windows `removeMenu()` 双重源码证据为准，入口紧跟 Help；不接入 Radix 私有导航集合，不修改官方菜单内容。
- GUI 使用原生 wide 600px 弹层变体与 compact 420px 确认态，设置行、开关、字体和按钮按实际消费组件映射。原生 `dialog` 提供模态基础，插件负责局部关闭、确认、焦点和异步清理。adapter 的语义变量由原有 27 个别名和 2026-09-08 外观跟进新增的 8 个别名组成，共 35 个；私有 token 不进入 GUI，完整可复用控件接口仍按专门规划推进。详见 [官方外观动态适配核对](APPEARANCE_FOLLOWUP_2026-09-08.md)。
- 预览相对加载真实 adapter 和 GUI，宿主结构/主题种子/RPC 是明确标识的模拟值，初始显示管理界面、测试控制折叠。2026-09-08 隔离客户端 GUI 修复复测已完成列表、刷新、两次原生重载、明暗主题、窄窗和新窗口验证；完整 Tab/Shift-Tab 遍历未单独实测，普通 `codlet launch` 的生产门禁仍未关闭。
- `status [--json]` 使用当前用户限定的本地 named pipe，提供 Host/子进程身份和真实 owner 生命周期采样；请求、响应、等待和工作线程均有界，退出回收。没有 Host、忙、超时、版本或身份拒绝互不混淆。主文档导航会撤销旧作用域并重新执行 provider → consumer 激活握手；恢复进行中或失败时保持未确认，成功后才报告实际 active。状态命令不扩大插件管理权限。
- 228 项 Rust 测试、58 项 Node 测试、四组 PowerShell 数据夹具、格式/Clippy 和 release 构建通过；最后 GUI/诊断文案整合后再次通过对应 53 项 Rust 回归。实机门禁保持未关闭，完整证据与构建摘要见本轮 review 记录。
- 2026-09-08 GUI 修复复测新增的验证中，Windows Rust 测试为 255 项通过、1 项外部真机 gate ignored，Node VM 测试为 63 项通过；隔离客户端 GUI 复测通过，普通 `codlet launch` 的生产 M0/M1 门禁以及 `DEFECT-001`、`DEFECT-002` 仍开放。
- 最终批次 `cargo test --locked --all-targets --all-features` 为 289 项通过，另有 1 项显式真实生产启动 gate 保持默认 ignored；`node --test tests/*.test.mjs` 为 63 项通过，Clippy、fmt、diffcheck 和 release build 均通过。watch 相关 12 项回归（7 时钟/文件状态机、1 执行路径 guard、1 双 target 端到端、2 解析调度、1 registry 限额）已纳入该批次；这些结果不关闭普通生产 launch、GUI、launch+watch、M0/M1 或 `DEFECT-001/002` 门禁。

### 16.5 运行控制与文件监听候选收尾

本批把 M1c 的运行控制和文件监听候选收敛到同一前台职责边界：DTO 只承载 typed request/report，authenticated IPC mailbox 管理 receipt，lifecycle plan 计算依赖闭包和 generation，renderer executor 执行 detach/activate/rollback，watch observer 只观察已加载 local 源，foreground orchestrator 优先消费 CLI 并把 watcher 请求交给同一 executor。完整边界见 [RUNTIME_CONTROL.md](RUNTIME_CONTROL.md)。

- 手动控制隔离实测和 owned 证据见 [RUNTIME_CONTROL_ACCEPTANCE_2026-09-08.md](RUNTIME_CONTROL_ACCEPTANCE_2026-09-08.md)，其源 commit 为 `5a0be1e`；该报告中的 GUI 与 lifecycle 观察不等同普通生产 GUI 验收。
- watcher、统一 registry 安全读写上限和 GUI 提示清理的最终源码提交为 `851395a`；最终汇总证据位于 `.codlet-artifacts/runtime-watch-2026-09-08/verification.json`。本批 watch 12 项回归与 289/63 总体验证已通过，release build 已通过，但不作发布完成声明。
- 本节之前的 doctor static-only 描述属于该阶段的历史状态；本批新增的 scoped Inspect 合约见 16.6。本节仍不宣称完整 M1c 或完整 doctor 已完成。
- 本批完成的是 M1c 运行控制与文件监听候选；M2 host/broker/permission API 尚未启动。普通 `codlet launch`、`codlet launch --watch` 的真实生产验收，M0/M1、`DEFECT-001` 和 `DEFECT-002` 仍开放。

### 16.6 Doctor runtime Inspect 契约

本批新增的 doctor runtime 合约保持 `codlet.doctor/v1` additive：在当前
registry 有匹配且支持 Inspect 的 Host 时，doctor 通过 scoped authenticated
control pipe 读取一份只读 owner publication；无 Host、其他 registry 或
不支持 Inspect 的 legacy Host 仍为 unavailable，不能仅因这些状态新增
exit 1。身份、传输、畸形或过大响应导致的 runtime issue 会进入
`failedChecks`；只有 fresh、complete、quiet publication 中观察到实际
generation mismatch、inactive 或 not-observed plugin 时，才形成 activation
runtime failure。

Inspect 不改变 status v1 wire，不读磁盘 `provides` 冒充 loaded provider，
不执行 CDP、不 prepare/submit、不启动或停止进程、不写 registry。provider
来自实际 kernel registrations，target/plugin generation/lifecycle/active
来自同一次 owner publication；recent events 只是历史上下文。Starting、
Terminated、stale、future/clock-skew、busy、incomplete、recovery/transition
等观察状态不单独判插件失败；兼容性和 endpoint health 始终 unprobed。

Native Inspect DTO 保持 snake_case target 字段，doctor 聚合字段使用
camelCase；provider 上限、每 provider capability 上限、总 capability 上限、
target/plugin 采样上限和 256 KiB response bound 均按
[DOCTOR_RUNTIME.md](DOCTOR_RUNTIME.md) 的契约执行。

最终验证已在源码提交 `0802046e8ce6227547b248ddbe073d37f73ded13` 上完成：
`cargo test --locked --all-targets --all-features` 共 307 项通过、0 项失败，
另有 1 项既有生产 M0 启动 gate 按约定保持 ignored。分组计数为：lib 166、
doctor CLI 6、doctor model 13、doctor runtime 7、fake child 46、lab 2、
local-plugin CLI 7、local-plugin registry 16、local plugins 30、plugin CLI 6、
plugin registry 6、status CLI 2。Clippy（all targets/features，`-D warnings`）、
fmt（all，`--check`）和 locked release bins 均通过，release 构建耗时 12.54 秒。
本批未改 JavaScript，未重跑既有 Node 63 项结果，不能将其记为本批通过。

使用 release 二进制执行本机只读 `codlet doctor --json`：进程退出码为 0，
runtime 为 `not_running`，安装包版本为 `26.901.6511.0`，已有原版 Codex
使 `launchPreflight` 为 `blocked`；`config.json` 前后均不存在，doctor 未创建
registry，原 Desktop PID 13460 与 backend PID 27176 的 PID/CreationDate 前后
保持不变。实时 Inspect 已由 native pipe 与双 target fake-child 验证；本轮没有
启动真实 Codex 或 lab，也不据此宣称真实 GUI 验收。证据位于
`.codlet-artifacts/doctor-runtime-2026-09-08/` 下的
`verification.json`、`cargo-test.log`、`doctor-local.json`、
`doctor-local-verification.json`、`codlet.exe` 和 `codlet-lab.exe`。

这些结果只覆盖本次 runtime Inspect 与本地只读 doctor 验证；生产 M0/M1、
`DEFECT-001`、`DEFECT-002` 仍开放，M2 尚未开始，不构成完整 M1c、完整 doctor
或 release 发布完成声明。

### 16.7 2026-09-09 M0/M1 验收推进

当前安装 build 已更新为 `26.903.8094.0`。本轮验证原版实例存在时，普通 `launch` 与 `launch --watch` 均明确拒绝，doctor/status 只读报告无 Host，用户 registry 未被创建；该结果覆盖冲突边界，不是一次成功的扩展会话运行。

验收发现并修复 control response ACK 后重复查询已断开 pipe 身份的竞态。确定性 native pipe 回归先复现 Win32 error 233 / `UntrustedServer`，修复后保留 ACK 前身份校验、ACK 后同一 Host process handle 存活检查；未扩大 deadline 或重试 submit。Rust 最终 308 项通过、1 项生产启动 gate 保持 ignored；Node 63 项、正常与 crash PowerShell harness 夹具、Clippy/fmt 和 release 构建通过。

正常验收脚本新增显式 M1/M1-watch 模式，复用前中后快照与正常退出证据，M1 报告独立标识为 `codlet.m1-acceptance/v1`。当前原版 Codex 承载验收任务，M0 与 M1-watch 的真实脚本均在 preflight 留证拒绝、没有调用 Codlet。正式启动、当前 build GUI/控制/watch/Inspect 组合、100 次冷启动和 crash 实测仍待在原版实例退出后从独立控制台完成，M0/M1 未关闭。完整记录与可执行步骤见 [M0/M1 验收](M0_M1_ACCEPTANCE_2026-09-09.md)。

### 16.8 正式实测反馈、列表同步修复与 GUI 更名

用户在 build `26.903.8094.0` 报告完成无需重启的本地注册/启用/重载/禁用/重新启用、watch 两次 requested/applied、adapter 依赖拒绝与连带换代、status/doctor ready/inspected，并明确确认 GUI 视觉检查符合预期。例外是 disable+remove 后刷新仍残留 disabled 条目。该人工确认与诊断生命周期字段分别留证。

三份原始 harness：M0 Host 63976 / Codex 11692 正常退出 0，marker/active/stopped 完整；M1 Host 19844 / Codex 55168 退出 1、缺少 stopped，用户不记得原因，保留待核验；M1-watch Host 29692 / Codex 36240 正常退出 0、active/stopped 完整。三次 after 均无相关进程，前中后快照的相关 TCP listener 均为空。原始 pending/decision 不改写，详情见 [GUI 注册列表修复与实测记录](GUI_REGISTRY_REPAIR_2026-09-09.md)。

源码 `202d89b` 将管理 list 改为合并最新 registry、实际 loaded 集合与标明来源的缓存元数据。已停用并移除注册的 local 消失；仍 loaded 者保留并提示注册已移除。新注册仅展示元数据，不通过刷新读取/执行源码；registry 读取失败直接返回错误，不回退陈旧列表。GUI ID/列表名称改为 `codlet-gui`，旧 CLI ID 在准备 receipt 前归一化，旧配置兼容读取；显式 GUI 偏好写入才在已有合并锁内迁移 key。产品标题、Core namespace 与旧 Host receipt 保持其原身份。

315 项 Rust、64 项 Node、Clippy/fmt 和 release 构建通过。随后本机只读 list/doctor 仅列出 adapter 与 `codlet-gui`，确认 marker 注册已移除、GUI 启用偏好恢复，registry SHA-256 前后一致，当前无 Runtime Host。这是当前配置清理证据，不是旧 Host 关闭前的最终采样。本轮没有再次启动真实 Codex；新构建与结果位于 `.codlet-artifacts/gui-registry-repair-2026-09-09/`，完整 M0/M1 仍未关闭。

### 16.9 正常退出补证与 M2a 开发

用户复测修复构建的 `launch --watch`：Host `41432` / Codex `20540`，exit `0`，active/stopped 完整，worker 已回收，after 无相关进程、三个阶段无相关 listener。旧普通 M1 exit `1` 保留原因未定；用户认为可能直接关闭了 cmd。本次不改写原始报告，不因该历史疑点或尚未完成的重复/crash 门禁暂停日常开发。

按用户要求，小修复使用针对性检查并继续推进，完整 M0/M1 不作为每个小包的默认重复任务。M2a 首批已实现纯 host 装载和独立 Core RPC owner；原生示例可自行选择任意 CDP target/session、执行 JavaScript 与订阅事件，无官方 adapter 或托管 renderer ABI 依赖。进程启动与回收、严格 JSONL、权限拒绝、队列/帧上限与失败隔离采用专项夹具验证；未启动真实 Codex。范围、用法及剩余项见 [M2a 记录](M2A_HOST_RUNTIME_2026-09-09.md)。

### 16.10 JS/TS 统一格式

第 16.9 节的可执行 host 示例是过渡历史；用户随后要求首版统一 JS/TS。当前实现已将其替换为目录内 JS 示例及 Codlet 固定的 JS 执行环境，复用既有进程监督、JSONL、CDP 与资源回收，不维护任意可执行文件插件分支。后续 hot lifecycle 和跨执行器工作均基于这套统一形式。

### 16.11 M2b JS host 在线生命周期

2026-09-10：在统一目录包上接入 `enable` / `disable` / `reload` 的 host 执行路径。前台协调器持有单个 pending receipt，进程 owner 异步处理启动/停止，等待期间继续 renderer 事件和其他 host CDP；不因 CLI 等待超时重提 mutation。新注册 host 按本次请求读取最新 registration，已分配 ID 在本次 runtime 固定执行器。验证失败不退休旧代；换代失败只在原目录仍注册、当前权限仍覆盖旧 manifest 且仍 enabled 时用旧源码快照和新代数恢复。disable 不读取源码，可清理损坏或已移除注册的实际 host。

本包验收使用真实固定 Node 子进程、假 CDP、协调器和同一 control broker receipt，覆盖在线闭环、故障补偿、撤权/停用并发与前台可响应性；未重复全量 M0/M1 或启动真实 Codex。host Inspect/watch、组合入口及跨执行器 capability 继续保留；shutdown 不接收新的 Core 清理请求，不能把进程退休等同于撤回任意页面效果。专项结果见 [M2b 记录](M2B_HOST_CONTROL_2026-09-10.md)。

### 16.12 Host 开发、清理、诊断与便携分发

2026-09-10：本轮按完整工作包持续整合以下路径，不以单个小功能通过作为交付终点：

- **协作清理**：`deactivate(cleanup)` 在普通请求/事件退场后获得同代、同授信的显式 CDP 清理通路；全部请求共享 Core 的 1500 ms 绝对预算。初始化未完成仍可清理；在线 stop 与全局 shutdown 重叠保持既有清理请求和 deadline，故障、超时和阻塞 JS 继续走 Job/IO 退休门禁。
- **自动重载**：host 与 renderer 共用有界稳定检测；host watch 经原 broker receipt 与事务执行，固定 root、完整 grants、稳定内容和所选代数。候选失败补偿保留失败签名；排队时尚未真正尝试的选择被守卫拒绝后，可重新采样，避免有效文件版本被永久吞掉。
- **执行诊断**：显式新增 `inspect_execution`，旧 Inspect/status 和控制回执字段保持。doctor 提供 host PID、generation、请求/订阅/队列、清理阶段和确认退出事实；保留独立源采样时间与终态历史，不虚构 renderer target/provider，不把旧失败记录当作当前配置故障。
- **可使用的开发分发**：白名单便携构建脚本把固定 Node/许可证、JS 示例、TS 声明和现行文档放入同一目录，生成逐文件 SHA256 manifest，可输出 ZIP。实际 cleanup-host 示例参与组合验收：enable、watch 换代前清理、Inspect/doctor、候选 attach 后失败补偿，以及 disable 资源归零。

接口和定向验证分别见 [Host cleanup](HOST_CLEANUP_2026-09-10.md)、[Host watch](HOST_WATCH_2026-09-10.md)、[Host inspection](HOST_INSPECTION_2026-09-10.md)、[开发使用流程](HOST_DEVELOPMENT_2026-09-10.md)和[分发构建](DISTRIBUTION.md)。本轮共通过 59 个不同的 Rust 场景、9 个 Node 场景与五类包装检查；相关复核按测试名运行，不重复计数。最终 fmt、定向 Clippy（warnings 视为错误）、diffcheck 和 locked release 构建通过。包装流程先用既有开发 exe 验证，新交付包使用本轮重新构建的 exe。

本轮保持真实 Codex/用户 registry 不受影响，未重跑全量 M0/M1；正式生产门禁与剩余 M2 能力分别保留。有限清理和进程退休不证明任意页面或 OS 副作用可逆。

### 16.13 组合目录包与 renderer→Host capability

2026-09-10：同一个 `codlet.json` 可以拥有两种 JS 入口。顶层 provides/requires 归
renderer，Host 通过 `host.provides` 声明；Host-only 顶层 provides 保持兼容。内部以
`包ID:host` 区分 Host owner，保留真实自循环与重复 provider 检查。

- 双入口共享代次、注册/授信与一张控制 receipt。Host Ready 之后才激活 renderer，先清理
  renderer 再退休 Host。依赖闭包覆盖跨执行器消费者；失败时两份原源码快照一起以新代次
  恢复，并再次核对当前授信。watch 同时观察 manifest 和两个 JS 主入口。
- renderer 可通过现有 SDK 调用 Host Target endpoint。前台验证真实 binding、context、
  principal、lease、target/document 和精确 provider generation；调用与异步回复共享
  原始预算，导航/停用取消旧结果。Host 子 CDP 使用 Core 验证的 invocation token，不能
  靠 JS 自报剩余时间延长父调用。
- 双侧均使用有界队列与现有 owner，不增加每调用线程。Host 完成本地唤醒前台，renderer
  在 activate 内等待自身 Host 时仍可推进。GUI 自停用进入同一包协调器，已保存动作在
  broker 暂满时保留待清理。
- 独立 VM peer 实际执行 production renderer bootstrap 与组合示例，同时运行固定 Node
  Host。4 项验收覆盖双窗口调用、共享重载、文档替换、挂起 evaluation 退休、两侧候选
  分别失败后的真实 cleanup 与快照恢复。它不模拟完整 DOM/Chromium，也不替代真实 Codex
  界面兼容性验收。

现行开发入口见 [组合示例](../examples/local-host-renderer-capability/README.md)，实现
边界见 [组合包契约](COMBINED_PACKAGES_2026-09-10.md)、
[Host capability](HOST_CAPABILITY_2026-09-10.md)与
[实际 JS 验收](HOST_RENDERER_VM_ACCEPTANCE_2026-09-10.md)。便携分发携带示例、契约、
固定 Node 与类型声明。Host 发起的 capability 调用、其他 scope、专门 OS broker、
backend adapter 与完整 M2 仍为后续工作。

本轮通过 114 个不同的 Rust 定向场景、14 个 Node 场景与五类包装检查；补测与重跑不
重复计数。最终定向 Clippy、fmt、diffcheck 和 locked release 构建通过。最后的 native
复核覆盖调用取消、cleanup 与执行样本；原 renderer 的重入 RPC、绝对预算、销毁撤权及
只读注册样本继续通过。没有重跑全量 M0/M1、启动真实 Codex 或修改默认用户 registry。

### 16.14 完整 M2 的公开原语与撤销

本次实现闭合第 15 节列出的 M2 条件，整合验收状态以 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)为准：

- Core SDK 固定 request/response/notification/server-request、错误、generation、scope、绝对父 deadline 和取消链。Host handler 自动继承调用上下文；renderer handler 用 `invocation.rpc` 显式保留上下文。Target handle 由 Core 根据当前 Host 所持有的 raw attach session 签发，插件不能自行拼出 principal。
- 初始装载与替换按 Host/renderer entry 的真实依赖图协调。先登记全部目标，再按依赖启动，允许 Host 在激活时等待第二个窗口的独立 renderer provider；旧 handle、已退出目标、导航、卸载与授权变化不会被新代接管。
- `host.fs` 提供获准目录内的 UTF-8 读取、列表和 stat；`host.network` 提供获准 exact origin 的 GET/HEAD；`host.process` 执行获准的具体 `.exe`；`host.system` 提供有限平台信息。各 endpoint 独立检查 declared/granted permission、范围、数据上限、deadline 与撤销。
- `plugin add` 展示并保存显式授权及范围，`plugin permissions` 只读查询；`plugin revoke` 和公开管理 API 使用同一 receipt。撤销先持久化，再退休依赖闭包，保留 enabled 偏好；外部完整登记变化同样使旧代失效。
- 第一方 GUI 使用公开 `codlet.runtime.manage@1` 查询、启用、停用和重载。提交回复丢失后只查询原 receipt，面板关闭/卸载清理轮询与晚到回调。
- `raw-m2` 只使用自身 Host JS 与公开 CDP，不构造托管 renderer、官方 target 筛选或 provider。真实 Node VM 验收覆盖双窗口、导航、动态目标、旧请求、正常停用与故障清理；不把该 peer 的结果扩写成 Chromium/Codex build 兼容保证。

这些结果不关闭仍保留的 M0/M1 正式门禁，也不代表 M3/M4 的私有 UI/backend adapter 已实现。后续便利层继续使用相同公开原语。

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
| 插件生态过早膨胀 | 运行时承担不必要的社区平台职责 | Codlet 负责显式导入与管理，GitHub/社区负责发现和维护信息；沿用现有内核，当前不建独立 Market 或自动更新服务 |
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

inherited CDP pipe、同 Browser Process 多窗口注入和第一方 GUI 已有实机证据；当前 build 的正常 launch/watch、在线热管理与用户视觉确认已留证，完整生产 M0/M1、重复性、`DEFECT-001`、`DEFECT-002` 仍保留原门禁。按用户最新指示，日常开发继续进入 M2，使用与改动相称的针对性验证；这些门禁用于正式收口，不再作为每个开发小包的重复前置任务。

进入 M2 后，第一条架构门禁是：

> 关闭全部可选官方功能插件后，Core 能否装载一个无 renderer 空入口、无官方 adapter 依赖的第三方 host 插件，让它通过公开底层原语自行完成注入、通信、恢复与所需跨层功能。

M3/M4 的官方便利层使用同一套公开接口。可选官方 L4 adapter 另有独立条件门禁：

> 当前 Desktop build 的 app-host MessagePort 能否在不暴露私有 envelope、不启动第二 App Server 的前提下，被第一方 Backend Adapter 稳定映射为同一 thread/turn/item 事实源。

官方 L4 adapter 的兼容性门禁不阻塞 L1-L3；失败时仅禁止该 adapter 注册相应 provider，不阻止不依赖它的用户插件经 Core 原语执行自己的探测、适配和能力注册。独立 backend 必须如实标识，不得冒充当前 Desktop 同一会话；Core 不内建这些私有业务规则。
