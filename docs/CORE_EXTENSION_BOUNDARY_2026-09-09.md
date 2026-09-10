# 已确认的 Core、可选托管运行时与 adapter 边界

状态：2026-09-09 用户已确认，并通过侧边讨论同步到主任务。本文约束 M2–M4 的设计与验收，不代表 L2–L4 已全部实现。2026-09-10 的完整 M2 候选与逐条证据见 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)；M0/M1 保留尚未关闭的正式门禁，M3/M4 私有适配仍属后续。现行开发流程见 [Host 开发说明](HOST_DEVELOPMENT_2026-09-10.md)。

## 已确认方向

已确认 Codlet 采用开放的运行时扩展内核：不为插件安全性背书，只在可控范围内支持生命周期、冲突处理与插件间隔离。Core 提供足以构建 L1–L4 扩展的底层能力；官方 renderer 运行支持、UI 和 backend adapter 是可选便利层，不构成独占入口。只安装 Core 和一个用户插件，也应能自行实现跨层能力，代价可以是更多代码和自行维护兼容性。

已确认方向：开放的 Core，加可选的托管运行时，再加可选的 UI/backend adapter。下述边界进入 M2–M4 的架构验收条件。

随后用户明确统一 JS/TS 开发与分发形式：目录包使用 `codlet.json`、JS 入口和资源，TS 在构建时编译为 JS。host JS 由 Core 管理的统一 JS 进程执行，renderer JS 在页面中执行；首版不接受任意 `.exe` 入口或原生 Node 扩展。开放性取决于公开原语，而非入口程序格式；通用 CDP/事件与自有适配路径继续开放，安全边界不变。现行实现见 [JS 运行时合约](JS_PLUGIN_RUNTIME_2026-09-09.md)。

## 与原始方案的关系

最早可追溯的方案提交 `dc14b5a`（Draft 0.4）已经包含 raw main-world/CDP 的开发路径、用户明确授信、无安全沙箱承诺，以及默认启用但可禁用的第一方 GUI。`a1b37df` 后续引入四层 capability 和通用 provider/consumer 模型，也没有撤销第三方 raw 路径。

因此，“官方 adapter 可选、第三方可直接使用底层能力、不保证插件安全”延续了原始定位。原方案同时把 renderer bridge、world/binding 管理和 target controller 放在 Runtime Host 内，manifest 假定 renderer 必填、host 可选，并未把“运行后端可替换”和“Core 加一个插件即可工作”写成明确门禁。用户本轮提出的是更强的开放性要求，需要调整后续拆分与验收。

本次修订前，文档中容易产生误读的句子包括“所有 Codex 私有知识由第一方 adapter 提供”“用户插件依赖 adapter capability”以及“build 未识别则拒绝提供 L4”。这些应分别限定为官方插件的职责、推荐开发方式和官方语义 adapter 的兼容性承诺，不能扩大成 Core 对第三方所有扩展的限制。

## 已确认的职责边界

| 层 | 负责什么 | 与其他层的关系 |
| --- | --- | --- |
| Core | 启动与持有会话 transport、通用 target/session 路由、原始请求和事件、插件入口与 host 通信、registry/lifecycle/generation、声明的 capability 冲突、可诊断的资源归属 | 不解释 DOM selector、React、thread/turn/approval 等 Codex 私有业务；对第一方和第三方暴露同一底层接口 |
| 可选 renderer 运行后端 | 方便的 world、bootstrap、binding、ready、导航恢复与清理 ABI | 作为可选官方运行支持；用户插件可以选择它，也可以通过 Core 原语自行注入和维护自己的 renderer 运行时 |
| 可选 UI/backend adapter | 稳定的挂载、样式或 thread/turn/item 能力，及其自己的 build 兼容性探测 | 任意插件均可实现、替代或绕过，不要求安装官方包 |
| 用户插件 | 用 JS/TS 目录包完成 UI、main-world、CDP、host 或同一 Desktop backend 的组合扩展；也可消费上述便利能力 | host 与 renderer 是同一格式的运行位置；只依赖实际选择的运行后端或 provider，纯 host 不提供空 renderer 入口 |

Core 必须保留足以启动插件、交付通用 transport 和建立资源归属的最小机制。把所有装载和通信机制也拿走，会产生“必须先运行插件才能装载第一个插件”的循环。这里的可选性针对 renderer 的高级运行 ABI 与 Codex 适配，不是要求 Core 没有任何执行原语。

可选和可替换首先是公开接口、依赖方向与运行时启用关系，不要求立即把每层拆成独立进程、安装包或动态插件。先用同一套公开原语实现第三方与官方实现都能工作的边界，再按实际需求决定部署拆分。

L4 在原方案中是 backend 业务语义层，不是 CDP 之外的另一种注入技术。Core 可以提供通用执行、连接和消息通道，让用户插件自行实现 L4；Core 本身仍不应该硬编码 `turn/start`、React 或 approval 规则。官方 backend adapter 承诺复用 Desktop 同一连接和事实源；独立 backend 的插件必须如实说明其独立性，不能把第二个 App Server 冒充成对当前 Desktop 会话的修改。

“完整”指 Core 不人为把可达底层原语限定在官方插件清单之内，不等于承诺任意 Codex 版本的所有私有对象都可达，也不代表任意 Electron main 执行、ASAR 修改、DLL 注入或原生内存修改已经纳入范围。这些是另外的技术与产品选择，不能从 L3/L4 名称推导出来。

## 隔离的承诺必须有边界

Core 可以检查自己的 RPC 来源、scope/generation、已声明的 provider 冲突和资源状态，并尽力回收自己持有的连接、脚本与插件进程。它不能证明插件没有恶意，不能发现所有直接 DOM/JS patch 冲突，也不能保证任意插件副作用可回滚。

每插件 isolated world 提供 JS 全局的分离，但共享 DOM。main-world 和 raw CDP 插件可以主动触及更广的上下文；具有普通用户权限的 host 进程也不因此变成 OS 沙箱。授权记录表达用户授信和经 Core 路由的访问选择，不是插件行为安全的证明。

因此应保留“错误不会被静默吞掉、旧消息不会被错误投递、声明的依赖按顺序管理”等可验证保证；避免承诺“任意插件都无法干扰其他插件或 Codex”“任何修改都能完整撤销”。

## 当前实现与目标的距离

当前 capability 名称没有官方 provider 白名单；第三方可发布合法 capability，已有夹具在禁用两个官方插件后运行自有 provider/consumer。它不是一个只能装官方 adapter 消费者的系统。

讨论前的 M1 是 renderer 优先的实现：manifest 要求 renderer 入口，实际只支持 isolated world 和 target 路由，Rust 内部 CDP 能力没有作为插件 API 开放。M2a 现已允许无 renderer 的本地 host JS 入口，经独立 JSONL 连接使用通用 CDP 请求和事件；纯 host 启动跳过官方 renderer target 筛选。M2b 在同一插件包与 CLI receipt 上增加 host 在线启停/重载和受当前授信约束的换代补偿。示例与原生夹具证明这些路径无需官方插件，尚不代表真实 Codex 中所有层级、导航恢复或完整 M2 验收完成。进程热管理也不意味着任意 raw 注入副作用都能自动撤回。

后续 [组合包](COMBINED_PACKAGES_2026-09-10.md)把 Host 与 renderer 纳入同一代次和生命周期事务。完整 M2 的 [Core RPC](CORE_RPC_2026-09-10.md)提供 Host 主动调用、双向 server-request/notification、Runtime/Target scope 与取消链；[OS broker](OS_BROKER_2026-09-10.md)按目录、origin 与 executable 明确范围授权。完整记录变化或显式撤销均使旧 generation 与受管理 endpoint 失效。

[raw-m2](../examples/raw-m2/README.md)用单一 Host 和公开 CDP 自行实现 binding、注入、新文档恢复与消息通路；其真实 JS 夹具不构造 RendererRuntime/TargetController，也不装载官方功能插件。正常清理由示例归还自身页面资源，Core 另行退休跟踪的 raw session；故障清理不会被描述为任意页面副作用回滚。backend adapter 与其私有业务映射仍未交付。

## M2–M4 的架构验收条目

1. 禁用全部可选官方插件，只安装一个第三方插件；它不声明 `codex.ui.adapter` 或 `codex.backend.adapter` 依赖，也能用公开的底层原语完成其需要的跨层功能。
2. 纯 host 入口可独立装载。renderer 便利 ABI 可以选择或替换；选择 raw 路径的插件自行承担注入、恢复、兼容性与清理代码。
3. 第一方 adapter 的高权限只来自相同的公开请求与授权机制，没有隐藏 provider ID、私有命令或编译期特批。
4. 官方 UI/backend adapter 不兼容或未安装时，依赖它们的插件有明确失败；不依赖它们的 raw/自带适配插件仍可进入自己的探测与激活流程。
5. capability graph 只管理声明的依赖与冲突。SDK 清楚区分 Core 可撤销的资源和插件自行产生的副作用，不声称全面隔离或安全沙箱。

已确认开发顺序：M2 先提供通用 host 入口、原始 CDP/事件与生命周期边界，并用无官方功能依赖的单一 host 插件验证；M3 再由同一套公开接口交付可选 main-world/UI 便利能力；M4 再交付可选 backend 语义 adapter。每层都保留直接路径与便利路径的独立验收，避免先实现官方 adapter 再反推一个只够它使用的 Core API。保留现有通用 capability kernel，调整 renderer 优先、renderer 入口必填的装载模型；不因这项未来设计共识降低本轮 M0/M1 的既有标准。

参考：[产品与技术方案](PRODUCT_TECHNICAL_PLAN.md)、[本地插件](LOCAL_PLUGINS.md)、[capability kernel](../src/capabilities.rs)、[manifest](../src/plugins.rs)、[renderer runtime](../src/renderer.rs)。
