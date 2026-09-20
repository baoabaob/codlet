# 八项 Core 通用服务：公开契约与验收计划

状态：2026-09-20，设计与实施拆分依据，尚非交付证明。用户已要求八项全部实现；HTTP(S)/SSE 与 WS/WSS 基础同时保留。本文仅新增计划，不改产品、不运行客户端或测试、不执行 Git。平台为 Windows 和 macOS；Linux、安装包及发布不在范围。

## 统一接入

采用内建 Runtime capability `codlet.core.services@1`，复用现有 capability 声明、Core RPC、registry/grants、generation、调用者身份和 document epoch。Host 与 renderer 的 `context.services` 是同一版本契约的类型化包装，底层仍调用现有 `rpc.request`；插件无需添加空 Host 入口即可使用存储、文件、通知和其他获授服务。

内建 capability 的可调用性不授予所有服务权限。各方法独立检查 `manifest 声明 ∩ 当前 registry grants ∩ 方法 policy`，不借 `runtime.manage`，也不引入同等的总开关。旧 `host.fs` 只读授权不自动增加写入；旧 `host.process` 的 Host 执行授权不自动变成流式子进程授权；现有 `fetch` 的默认不继承代理行为保持兼容。

Core 内只保留一份 `SharedCoreServices`，注册在通用 RPC 分派处；Host 与 renderer 入口不能各建一份 KV、订阅或任务表。当前 [Host 服务装配](../src/host_runtime/services.rs) 已集中 OS broker 和调用失效；[renderer RPC 桥](../src/renderer/host_rpc.rs) 已具备调用者、租约、代次和文档检查。应在这些已有路径接入共同服务，而不是要求 renderer 绕经某个第三方 Host provider。

建议代码边界：中央层负责方法分派、权威 caller、权限 policy、全局资源预算、注册/退出；独立模块分别实现 `storage`、`credentials`、`files`、`events`、`tasks`、`processes`、`network`、`desktop`。共用 `resources` 和 `diagnostics` 是这些模块的基础，不能成为另一套插件管理器。中央 enum、dispatch 和授权结构由单一集成人维护，模块作者只输出模块接口、类型草案及自身验收。

### 统一身份和资源语义

| 对象 | 最小契约 |
| --- | --- |
| 权威调用者 | 由 Core 提供 registry scope、插件注册身份、源/授信记录、generation、entry、可选 Target/document epoch；业务 params 不允许替换身份 |
| 持久命名空间 | 同一受信任注册身份下 Host/renderer 共用；不跟 generation 改名，不以用户给出的 pluginId 任意访问另一插件。来源变化或重新授信不能静默继承旧秘密 |
| 瞬态资源句柄 | 不可猜测且不能自行构造，绑定 owner、generation、资源种类和 lifetime；即使序列化泄露也不能跨调用者复用。每次调用及结果交付重新检查授权 |
| lifetime | `document` 随原文档退休；`plugin` 随插件代次退休。renderer 可创建 Core 持有的 plugin 级存储观察/文件观察/进程资源，不能让页面 JS 回调在文档关闭后继续执行；观察者寿命与资源寿命分开 |
| 共享资源 | 同插件跨 entry 使用须通过 Core 签发的显式受限引用，绑定当前联合 generation；不开放任意字符串 handle 转交。跨插件通过已声明的 capability 提供业务服务，不传递自身权限 |
| 长资源 | `open/start` 短 RPC 返回 handle/operation ID；`read/write/query/cancel/close` 继续用有界短 RPC。保持普通 RPC 15 秒上限，不靠不断续父预算维持资源 |
| 取消与终态 | 区分取消已请求、执行已结束、OS 资源已回收、外部效果未知。终态只提交一次，晚到完成不能覆盖终态；取消不能证明已发生副作用回滚 |
| 重提防护 | 有副作用的方法接受作用域内 `operationKey`，Core 绑定输入摘要并先登记；同 key 同输入返回原 operation，同 key 异输入报冲突。超时后查询原 operation，不盲目再执行 |
| Core 崩溃恢复 | 持久存储提交有确定结果；文件替换保留可恢复 journal；通知、剪贴板、启动子进程等无法和 OS 原子提交的效果返回 `outcome_unknown`，不得伪造 exactly-once |
| 资源查询 | 默认只能看自己的资源/operation；管理端另走既有管理授权。列表分页、有数量上限、每项含状态/归属/创建时间/有界错误码，不默认返回秘密或业务正文 |

通用错误至少包括 `permission_denied`、`policy_denied`、`stale_generation`、`scope_ended`、`resource_closed`、`resource_limit`、`revision_conflict`、`operation_conflict`、`request_timeout`、`cancel_requested`、`outcome_unknown`、`cleanup_incomplete`、`os_permission_denied` 和 `backend_unavailable`。正常用户取消原生对话框返回 `cancelled`，不是系统错误。

每个服务公开自己的可用性、限额和降级原因；这用于解释真实环境问题。Windows/macOS 已列入本轮的功能不能用常驻 `unsupported` 分支算完成。缺平台设备只能登记“未验收”，不能将承诺悄悄缩为只有方法名。

### 权限和 policy 的最小扩展

以下名称是实施建议，允许统一命名调整，授权边界不可合并。

| 服务 | 方法权限 | policy / 限定 |
| --- | --- | --- |
| 存储 | `core.storage.read` / `core.storage.write` | 自有命名空间、容量、单值大小；修改配置与数据分别可审计 |
| 凭据 | `core.credentials.use` / `core.credentials.write` | 自有记录、明确用途/目标 origin；导出明文若实现须单独权限，最小版不提供导出 |
| 文件 | 现有 `host.fs`；新增 `host.fs.write`、`host.fs.watch`、`core.files.dialog` | 保留 readRoots，新增 writeRoots/watchRoots；原生选择仅签发本次选择的受限资源授权 |
| 事件 | `core.events.publish` / `core.events.subscribe` | 自有 topic；跨插件还须现有 provides/requires 精确匹配，不是全局事件窥探权限 |
| 后台任务 | `core.tasks` | 自有任务和明确 capability handler；不授予 handler 所需的文件/网络/进程权限 |
| 流式子进程 | 新增 `host.process.spawn` | 既有 executable 范围，加明确 cwdRoots/envKeys；不隐式开放 shell、全环境继承或任意 cwd |
| 网络 | 现有 `host.network`；新增 `core.network.status`、`core.network.configure` | origin 范围；允许的 proxy profile、证书来源；不修改系统代理或系统证书库 |
| 桌面集成 | `core.notifications`、`core.clipboard.read`、`core.clipboard.write`、`core.shortcuts` | 明确通知内容；剪贴板方向独立；shortcuts 白名单逐个规范化 |
| 自有诊断/资源 | `core.resources.read`、`core.diagnostics.read` | 自有命名空间、有界分页/过滤；无其他插件正文、凭据和全局管理权 |

policy、权限和源路径继续作为现有完整授信记录原子比较；添加 writeRoots 等字段必须参与记录摘要、撤权、candidate/rollback 检查、GUI/CLI 展示和导入预览。撤销写权限清除写 policy，不能保留隐藏可恢复的旧授权。

## 1. 配置、数据目录与原子 KV

**公开方法。**

```ts
storage.info() -> { namespace, schemaVersion, quota, usage, dataRootRef }
storage.get({ area: 'config' | 'data', key }) -> { found, value?, revision }
storage.list({ area, prefix?, cursor?, limit? }) -> { entries, cursor }
storage.commit({ area, expectedRevision, changes, operationKey })
  -> { revision, operationId }
storage.changes({ after?, limit?, waitMs? }) -> EventBatch
storage.migrate({ expectedRevision, expectedSchema, nextSchema, changes, operationKey })
  -> { schemaVersion, revision, operationId }
```

`changes` 是一次原子 `set/delete` 列表；失败全部不生效。revision 是 Core 签发的不透明值，每次成功提交递增并持久化；删除后再创建不得复用旧 revision，避免 ABA。`expectedRevision` 必填；新 namespace 有可读取初始 revision。读、写和迁移均可由纯 renderer 发起，Host 使用同一数据；schema 内容与迁移计算归插件，Core 只原子验证和提交，不执行迁移脚本。

`dataRootRef` 是文件服务可消费的自有数据目录句柄，不必向 renderer 返回宿主绝对路径。Host 有相应权限时可解析为稳定数据路径；包目录与数据目录继续分开，不能将 data root 指向 package root。卸载默认保留数据，删除数据必须是既有管理流程里的显式选择；正常 reload/update 不更换 namespace。

建议限额起点：单 JSON 值 256 KiB、单事务 1 MiB/128 项、namespace 16 MiB、分页最多 128 项；公开查询实际限额。原子落盘并发锁、临时文件、同步及替换由 Core 负责，不能只用内存 Map 后定时保存。

**验收。** 无 Host 的设置插件写入后，另一窗口和 Host 读到同一 revision；并发 CAS 只有一个成功；进程在提交边界中断后读取到完整旧值或完整新值；重试同 operationKey 不产生第二次变更；升级保留数据；无写授权时新旧 API 均不能写。

## 2. 系统凭据引用

**公开方法。**

```ts
credentials.put({ name, secret, usage, replaceRevision?, operationKey }) -> SecretRef
credentials.list({ cursor?, limit? }) -> { entries: SecretMetadata[], cursor }
credentials.inspect({ ref }) -> SecretMetadata
credentials.delete({ ref, expectedRevision, operationKey }) -> { removed, operationId }
```

`SecretRef` 不含密文、明文或系统账户标识，绑定自有命名空间、记录 revision 和用途。`usage` 明确如 `http.authorization`、`proxy.authorization` 或获准子进程的某个 envKey，并按需要绑定 destination origins/executable。网络转发/进程 spawn 接受 `credentialRef`，由 Core 在最后派发点解引用，避免为了使用秘密先把明文返回 renderer。不同 origin 不继承认证；记录轮换后旧 revision 引用按明确规则失效，不默默切到另一个凭据。

Windows 使用用户级系统凭据存储，macOS 使用 Keychain；标识包含 registry scope 和受信任注册身份。put 的传入 secret 不进入日志、operation 持久正文或诊断；若需校验重复操作输入，使用不导出的本机密钥生成摘要，不持久化可离线猜测的裸 secret hash。系统交互失败或 Keychain 锁定如实报告。OS 授权与插件 grants 均需满足。

最小版必须能写入、列元数据、实际在获准网络/进程动作中使用、轮换和删除；只有一个空引用对象不算系统凭据功能。没有明文 get 不影响上述完整闭环。Host 是受信任 Node，不把系统凭据引用宣称为对恶意 Host 的隔离沙箱。

**验收。** 重启后仍能通过引用完成本机上游认证；renderer 结果、日志和导出中没有 secret；插件 A 不能使用 B 引用；撤权、换源、轮换后的旧引用被拒绝；macOS 锁定/拒绝与 Windows 存储错误可识别。

## 3. 文件写入、原子替换、watch、open/save

**公开方法。**

```ts
files.openDialog({ kind: 'file' | 'directory', multiple?, filters? }) -> { cancelled, entries? }
files.saveDialog({ suggestedName?, filters? }) -> { cancelled, file? }
files.open({ pathOrRef, mode: 'read' | 'write', expectedVersion? }) -> FileHandle
files.read({ handle, offset?, maxBytes }) -> { bytes, eof, version }
files.writeAtomic({ target, expectedVersion, source, operationKey }) -> { version, operationId }
files.watch({ target, recursive?: false }) -> { watch, cursor }
files.changes({ watch, after, limit?, waitMs? }) -> EventBatch
files.close({ handle }) -> { closed }
```

`open/save` 指原生文件选择/保存对话框，`files.open` 指受管文件句柄，不顺便执行可执行文件或脚本。二进制 `source` 使用有界块流资源，SDK 包装 Uint8Array，避免大文件堆进 JSON RPC。写入在目标同目录准备临时文件，检查版本后原子替换，失败不留下半成品；创建使用明确的 `expectedVersion: null` 且不得覆盖已有目标。已有文件 version 至少含足够的身份/修改证据，不能只靠低精度 mtime。

既有 readRoots 不授写；writeRoots/watchRoots 显式声明。对话框的用户选择签发狭窄的文件/目录引用，标注 read 或 write、插件归属和生命周期，不自动加入永久 registry policy。过滤器只控制选择体验，不是权限边界。链接/重解析、被替换的祖先、大小写与路径穿越继续沿用现有 broker 的防逃逸规则；watch 收到变动后再次验证目标，不仅检查注册时路径。

watch 是有界变化提示：create/change/remove/replace/overflow，允许合并重复 OS 事件，不承诺每次文件写入一条；overflow 返回 gap，消费者重新 stat/read。首版非递归也必须支持文件和已授权目录内的直接条目；需要递归时再显式扩展，不能假装监听全树。

**验收。** renderer 原生选择并保存中文路径文件，写后真实内容正确；并发修改触发版本冲突；断电/崩溃边界不产生半写目标；同目录替换可观察；被监听目录换成 symlink/junction 后不越界；取消对话框不创建文件；卸载撤销观察并关闭句柄。

## 4. 现有 RPC 上的可靠事件订阅

**公开方法。**

```ts
events.createTopic({ name, capability, limits? }) -> TopicHandle
events.publish({ topic, event, operationKey? }) -> { cursor }
events.subscribe({ capability, topicName, after?: Cursor }) -> Subscription
events.read({ subscription, after?: Cursor, limit?, waitMs? }) -> EventBatch
events.ack({ subscription, cursor }) -> { acknowledged }
events.close({ subscriptionOrTopic }) -> { closed }
// EventBatch = { events: { cursor, value }[], cursor, gap, reset?, terminal? }
```

topic 的 provider 必须实际声明/提供相应版本 capability；consumer 必须有 matching requires，沿用现有 provider generation 解析。不同插件不能只凭 topicName 订阅。游标包含不透明 topic epoch/序列，不使用可溢出的 JS 浮点计数；只能用于同一 topic 和授权范围。

这里的“可靠”是有序、可重读、能检测缺口，不是永久日志或 exactly-once 消费。重复读可能返回同事件，consumer 按 cursor 去重；ack 只是消费水位，不证明业务副作用已发生。topic 有界保留，publish 达界可淘汰最旧数据并使慢消费者得到 gap；不得无限内存或假装每条都交付。read 的 credit/limit 和待处理请求数形成背压；对必须无损的文件/进程字节流使用流资源，不能拿可丢失事件日志承载它。

provider reload 时旧订阅收到 terminal/provider_retired，旧 cursor 不能自动读入新代；新订阅可报告 reset/gap，消费者显式重新取快照。需要一致快照的 provider 在自身业务更新与 publish 间建立 revision 对应，通过已有 RPC 返回 `snapshot + cursor`；Core 不根据事件猜业务状态。

建议起点：每 topic 256 事件/1 MiB、单事件 32 KiB、每订阅批次最多 64 条、wait≤10 秒；明确溢出码及资源配额。订阅、等待读和 topic 均受 scope/generation 结束约束。

**验收。** Host→renderer、renderer→Host 和纯 renderer 两窗口均经同一 topic 收到顺序一致事件；断开观察者再读能补齐；超出保留范围必有 gap；旧 cursor/跨插件 cursor 被拒；reload 有终止和重新快照；只读观察者不能发布；慢消费者不拖死 provider。

## 5. 通用后台任务：进度、取消、结果

**公开方法。**

```ts
tasks.start({ handler: { capability, method }, input, lifetime, timeoutMs, operationKey })
  -> { task, operationId }
tasks.get({ taskOrOperation }) -> TaskSnapshot
tasks.list({ cursor?, limit?, state? }) -> { tasks, cursor }
tasks.cancel({ task }) -> { requested, state }
tasks.events({ task, after?, limit?, waitMs? }) -> EventBatch
tasks.result({ taskOrOperation }) -> { state, result?, error?, outcomeKnown }
```

任务必须真正调用已声明的 provider handler，不只登记一条“运行中”元数据。Core 分派时固定 provider generation、caller 和 scope，创建独立且有最大期限的 task invocation lease；`tasks.start` 回执结束不取消已明确创建的任务。runner 收到 task-bound signal、remainingMs 和进度 reporter，嵌套 RPC/文件/网络/进程仍继承该任务的剩余预算和取消，不能使用 renderer 伪造的 parent token。

最小状态机：`queued → running → succeeded | failed | cancelled | interrupted`；`cancelRequested` 是独立字段。取消请求后只有 runner 确认且受管子资源结束，才进入 cancelled；先完成的真实成功不被之后到来的取消改写。超时或 owner 消失而外部效果无法确认时使用 interrupted/outcomeKnown=false，不能伪报取消成功。所有终态只提交一次。

renderer handler 的执行 lifetime 不能超过原文档；文档消失后任务 interrupted。Host handler 可持有 plugin lifetime，不依赖某个观察面板；插件停用/reload 仍取消。Core 执行自己的受管文件/进程作业也可使用同一任务记录，纯 renderer 因而能发起真正的后台 OS 任务，无需空 Host。任意 JS 超时不等于代码已被强行杀死，Core 只对自己的资源回收作确证。

进度是最新快照加有界事件，可合并高频更新；结果限制大小，大结果用文件/数据引用。持久化最小 operation/终态记录，Core 重启后把未确认任务标为 interrupted；不自动重跑。定时规则、业务重试、队列优先级策略和 Codex 模型任务调度不内建。

**验收。** 一个耗时超过 15 秒的真实 handler 可报告进度并返回结果，控制 RPC 不长期占位；start 超时重查得到同一个任务；取消传播到真实文件/子进程动作；面板关闭不取消明确归 plugin 的 OS 作业；renderer handler 文档退出必终止；Core 重启不重放未知任务。

## 6. 流式子进程 stdin/stdout/stderr 与退出回收

**公开方法。**

```ts
processes.spawn({ executable, args, cwd?, env?, stdin: 'pipe' | 'closed', operationKey })
  -> { process, operationId, pid }
processes.write({ process, bytes }) -> { acceptedBytes }
processes.endInput({ process }) -> { closed }
processes.read({ process, stream: 'stdout' | 'stderr', maxBytes, waitMs? })
  -> { bytes, eof }
processes.status({ processOrOperation }) -> ProcessSnapshot
processes.terminate({ process, graceMs? }) -> { requested }
processes.wait({ process, waitMs? }) -> { state, exit?, cleanup? }
processes.close({ process }) -> { closed, cleanup }
```

bytes 是二进制，stdout/stderr 保留各自顺序，不声称两管道之间有完全可靠的时序；单流只允许一个消费 owner，UI 状态观察通过独立事件。stdin 写入只能按实际接受量推进，关闭 stdin 后仍继续读输出。采用固定数量异步 I/O/worker、有界队列与背压；进程输出不能无限堆积，退出时不能因尚未读完任一管道死锁。

要求新增 spawn 授权与明确 executable。args 为字符串数组，无 shell command 拼接；cwd 在新 policy 范围，env 只允许明确的 keys/value 或 SecretRef，默认仍为最小环境。不可从 `host.process` 自动继承无限命令执行策略。二进制无效 UTF-8 仍可读，由插件决定编码。

Windows 复用 Job Object，macOS 复用/完善进程组；在子进程可运行前建立所有权，结束主进程不等于后代/管道已回收。进程树逃逸、POSIX 子进程自行脱离组等无法绝对保证的情形必须说明实际 scope，不能把 process-group 的能力称为任意进程树沙箱。status 分别呈现主进程退出、受管组回收和 pipe EOF；失败返回 cleanup_incomplete。

**验收。** 真实辅助进程边接收 stdin 边写 stdout/stderr，两方向数据均可提前读取；关闭 stdin 后收到最终输出及 exit code；慢读受背压且能取消；含二进制输出；主进程退出留子进程的用例中受管组被清理；renderer 无 Host 入口亦能在获授权限后完成 spawn/read/terminate；撤权后不能继续写入。

## 7. 网络代理、状态与证书来源

**公开方法。**

```ts
network.profiles() -> { proxySources, trustSources, capabilities }
network.resolve({ url, proxy: 'direct' | 'system' | ProxyRef }) -> { route, revision }
network.status({ channelOrRequest?, cursor?, limit? }) -> NetworkStatus
network.createProfile({ proxy, trust, operationKey }) -> NetworkProfileRef
network.closeProfile({ profile }) -> { closed }
// fetch / traffic.openChannel / exchange.forward 消费 networkProfileRef
```

proxy 支持 direct、系统配置解析、显式 HTTP(S) 代理；本轮声明支持的代理类型在 API 和文档准确列举。HTTP(S)/SSE 与 WS/WSS 使用相同 profile、origin 检查及凭据引用，不允许 HTTP 走代理而 WSS 偷走直连。HTTPS/WSS 经需要的代理 CONNECT 隧道属于**出站代理实现**，不能与对外提供任意 CONNECT 转发服务混淆。

系统模式按每个目标 URL 解析 Windows/macOS 的代理、bypass 和 PAC/自动配置，并记录版本/来源；环境变量模式如提供必须显式选择，不能自动继承改变旧 fetch。代理授权目标与最终目的 origin 分开验证；Proxy-Authorization 不传给 origin，origin Authorization 不用于代理。解析失败无静默 direct fallback，插件可显式作决定。

trust 支持系统信任来源与用户明确选择的附加 CA 资源；CA 来自受管文件/配置、验证内容和大小，记录证书指纹及版本。保持 hostname/有效期/证书链验证，无 `insecureSkipVerify` 捷径；不安装系统根证书、不修改系统代理。自定义 CA profile 只影响显式选用它的调用和连接，既有连接不会因 profile 修改神奇换证书或路由。

状态包含已确定的 DNS/connect/proxy/TLS/headers/stream 阶段、选用配置 revision、传输类别与错误码；只能报告真正观测到的指标。不默认探测网络、不自动健康检查、选供应商、重连或重试。状态查询不泄露代理密码、origin key 或请求正文。

**验收。** direct、显式代理和实际系统配置下分别完成 HTTP/SSE 与 WS/WSS；代理认证和源认证隔离；系统 bypass/PAC 的两目标走向正确；不可信证书失败，受限附加 CA 后成功且未影响另一个 profile；profile 切换只影响明确的新请求/连接；Windows/macOS 有真实 native resolver/trust 路径，不用 unsupported 占位。

## 8. 系统通知、剪贴板、指定全局快捷键，以及资源/诊断查询

**公开方法。**

```ts
desktop.notify({ title, body, tag?, actions?, operationKey }) -> { notification, state }
desktop.notifications({ after?, limit?, waitMs? }) -> EventBatch
desktop.dismissNotification({ notification }) -> { dismissed }
desktop.clipboardRead({ format: 'text' }) -> { text, version? }
desktop.clipboardWrite({ text, operationKey }) -> { operationId, version? }
desktop.registerShortcut({ shortcut, actionId }) -> { registration, normalized }
desktop.shortcutEvents({ after?, limit?, waitMs? }) -> EventBatch
desktop.unregisterShortcut({ registration }) -> { removed }
resources.list({ kind?, cursor?, limit? }) -> { resources, cursor }
resources.get({ resource }) -> ResourceSnapshot
diagnostics.read({ after?, codes?, level?, limit? }) -> DiagnosticBatch
```

通知由 Windows/macOS 原生后端真实发出，系统拒绝、勿扰、通知已提交和用户实际点击分开表述；Core 不声称 delivered 回执证明用户看见。动作只触发已登记 actionId 的受管事件，不执行外部命令或打开任意 URL。运行环境需通知身份/注册时，开发启动也要有可运行路径，不把“以后打包再做”当本轮实现。诊断不得默认保留通知 body。

剪贴板最小版实现真实 text 读写，read/write 分权限且无后台轮询。若系统无法提供可靠版本，返回未知，不伪造 CAS；不在插件退出时恢复旧剪贴板覆盖用户后来复制的内容。write 超时结果未知时不能自动重放。

快捷键按 manifest/policy 中的指定组合授权，规范化 modifiers/key；支持 Windows 与 macOS 的映射和冲突报告。只注册指定组合，不安装全键盘记录器；Core 单例仲裁相同组合，OS 保留键或别的程序已占用时返回明确冲突。触发事件绑定注册 generation，插件停用/撤权/崩溃即注销，迟到按键不能调用新代。

资源列表覆盖这八项服务和已接入的 traffic 资源，使用自有 scope 和统一状态。诊断有界环形缓冲、递增 cursor、gap、来源、代码和时间；任意插件自由文本不直接加入默认导出。查询不要求 runtime.manage，也不能借“诊断”读另一插件凭据、文件路径或业务数据。

**验收。** Windows/macOS 真实发通知并收到可支持的点击动作；renderer 读写系统剪贴板；指定全局组合在窗口失焦时触发一次，冲突可见，卸载后归还；同插件的 Host/renderer 查询一致资源状态；越权查询失败；大量诊断有界并返回 gap。

## Adapter 与普通插件如何接入

| 场景 | Core 提供 | 官方 Adapter / 普通插件负责 |
| --- | --- | --- |
| 当前任务切换 API | 存储版本、SecretRef、统一 traffic/profile、资源生命周期和诊断 | Adapter 将真实任务/连接与通道绑定并说明生效点；插件选服务、制作 UI、决定重试 |
| 任务完成通知 | 通用事件、原生通知、operation 去重 | Adapter 提供真实 turn/item 状态；插件决定何时通知，不能把 socket 关闭当任务完成 |
| 会话看板与批处理 | 通用作业、进度、订阅和可查询结果 | Adapter 提供经核验的创建/恢复/提交/取消语义；插件制定排队和自动化策略 |
| 导入资料/结果导出 | 文件选择、read/write/watch、数据目录和大块传输 | Adapter 映射附件/文本输入；插件做格式解析、摘要和来源说明 |
| 外部工具调用 | 可取消流式进程、stdout/stderr、受管组退出 | 插件选择工具与参数、解析输出；Adapter 如需参与原生工具流，保留 call/item 身份和审批 |
| 快捷操作 | 注册指定快捷键、事件、剪贴板和通知 | UI Adapter 提供当前任务/输入框等经核验上下文；插件定义命令和界面 |

Core 不增加 threadId、turnId、toolCallId、模型字段或 DOM selector。Adapter 不以“等通用服务完成”为由返回永久 unsupported；每个必要接法要接到真实已有 Desktop 连接和已验证 UI surface。新的 Codex 私有语义若无证据，列为明确的 Adapter 实施/验收项，不虚构已支持。

## 验收矩阵与实施顺序

八项全部进入交付，顺序只为减少交叉改动，不代表后面的项可省略。先固定共同 owner/auth/资源/operation 类型；存储与事件作基础；文件、凭据、任务、进程并行实现；网络配置和桌面集成接入；最终做跨 entry、跨平台和故障恢复集成。

| 验收组 | Windows | macOS | 必须证明的跨层结果 |
| --- | --- | --- | --- |
| 统一入口/权限 | 原生 | 原生 | 纯 renderer 与 Host 调用同一服务；无 Host 空壳；不同方法不靠管理权限；撤权对待交付结果同样有效 |
| 存储 | 实际磁盘/并发/崩溃夹具 | 实际磁盘/并发/崩溃夹具 | config/data 同 namespace、CAS/迁移原子、更新保留、源身份变化不串数据 |
| 凭据 | 系统凭据后端 | Keychain | 实際保存并用于获准调用、重启可用、轮换失效、跨插件隔离、无明文泄漏 |
| 文件 | 原生对话框/文件系统/watch | 原生对话框/文件系统/watch | writeRoots 不继承 readRoots；取消、原子替换、路径替换、溢出恢复 |
| 事件 | 实际两 entry/两窗口 | 实际两 entry/两窗口 | 有序补读、gap、provider reload、跨插件依赖校验、内存有界 |
| 后台任务 | 真实长 handler/OS 作业 | 真实长 handler/OS 作业 | start 快返、进度、取消、终态、重复 key、页面退出与Core重启真实性 |
| 流式子进程 | Job + 双管道 + stdin | 进程组 + 双管道 + stdin | 二进制/背压/半关闭、主进程及受管后代回收、无超时重启 |
| 网络配置 | 系统 proxy/PAC/trust | 系统 proxy/PAC/trust | HTTP(S)/SSE 与 WS/WSS 一致 profile、认证分离、CA 范围、真实状态 |
| 桌面集成 | 通知/剪贴板/全局热键 | 通知/剪贴板/全局热键 | 原生效果、OS拒绝、冲突、卸载归还；自有诊断可用且不越权 |
| 兼容回归 | 已有功能 | 已有功能 | 原 GET/HEAD、process.run、Core RPC、preSubmit、traffic、管理启停/更新/撤权不退化 |

每组同时覆盖：未声明、未授予、policy 越界、并发撤权、generation 退休、renderer 导航、Host 异常退出、Core 关闭、超限、超时和晚到结果。fixture 验证状态机，真实 OS 验证资源效果，真实客户端验证 Adapter；三种证据分开登记。只通过类型检查/编译或单平台测试不能宣布八项跨平台完成。

**首批集成用例。** 做一个无 Host 的设置/资料插件，完成 CAS 保存、原生选择导出、watch、剪贴板和通知；再做一个 Host + renderer 的外部工具插件，用事件看进度、流式输入输出、取消和结果查询；最后让 API 路由示例复用同一存储、SecretRef、HTTP/SSE/WS/WSS profile 和诊断。示例的业务留在示例里，用它们证明公共契约可组合。

**最重要的两项审查。** 一是权威 principal 与数据 namespace 必须在 Core 解析，renderer 存储不得偷偷绕经具有更大权限的 Host 身份；二是 start 回执、资源终态与 OS 效果分开，operationKey 不能把无法原子确认的外部效果包装成成功。它们决定这八项能否沿用现有可靠性，而不是仅增加一批方法名。
