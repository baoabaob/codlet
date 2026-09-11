# M3 / M4 Desktop Adapter 开发说明

本次新增可选目录包 `bundled/codex-desktop-adapter`。它提供主世界提交拦截和当前 Desktop 会话的语义 API。现有 `codex.ui.adapter` 继续提供低权限的标题栏挂载点；GUI 不因此升级为主世界插件。

## 安装与权限

```powershell
& $codletExe plugin add "$repo/bundled/codex-desktop-adapter" --trust --grant ui.mainWorld
& $codletExe plugin enable codex.desktop.adapter
& $codletExe plugin add "$repo/examples/desktop-m3-m4" --trust --grant ui.dom --grant ui.mainWorld
& $codletExe plugin enable example.desktop.m3m4
```

测试客户端使用它自身的 `Test-Plugins.ps1`，不要把测试包注册到日常配置。这个第一方目录包与其他本地包使用相同的授权、依赖解析、重载和卸载流程；不会静默扩大既有 GUI 或 UI Adapter 的权限。

测试实例的诊断使用同目录的 `Test-Doctor.ps1 --json`。这是显式指向实验资料目录的只读入口，仍验证 Host 的程序路径身份；普通 `codlet.exe` 不会越过该校验去读取不同程序路径的测试 Host。

`renderer.world: "main"` 必须同时声明并获授 `ui.mainWorld`。每个插件仍有独立的 binding、principal、generation 和 RPC 生命周期；多个 main 插件共用页面的默认执行世界。主世界代码可以接触页面及其他主世界代码，这项权限不是隔离沙箱。isolated 插件继续使用自己的命名世界，不能通过主世界的 binding 冒用 isolated principal。

托管 ABI 是目录包的可选入口。只提供 Host 入口的插件仍可使用公开 `cdp.raw` 自行选择世界、脚本、binding、导航恢复和清理；不需要任何官方 Adapter 或 provider ID。

## 当前构建映射

适配器包含两个已审核的 x64 构建配置：包 `26.903.8094.0` 对应页面 `26.903.61454` / build `8378`；包 `26.903.9818.0` 对应页面 `26.903.71938` / build `8576`，App Server 均为 `0.153.4`。版本、入口资源、preload、已有 AppScope、已经存在的 local manager / request client、已有 app-host services 和可替换的提交方法都要匹配。初始化按需读取 live export，先检查 local 缓存成员再固定连接引用，不能用探测动作创建客户端。公共 build DTO 只包含三个版本字段。

新窗口的账号或 app-host 初始化可能持续二十多秒。Adapter 先发布诊断端点，在自己内部进行最多 30 秒的可取消探测；Core 及其他插件继续工作。成功后才发布语义端点，失败后不再轮询。`probe.initializing` 表示仍在等待；`waitReady` 可以等待最多十秒并返回最新诊断。Core 的插件激活状态与具体语义端点的可用性分别解释。

Adapter 复用页面已经建立的 `connect-app-host` 服务对象及 Native App Server request client。当前构建的普通 App Server 请求经原 request client、preload 和 Electron main 送入 Desktop 已有的 App Server connection；app-host 服务与页面状态继续使用原 MessagePort。没有再发送 `connect-app-host`、创建第二个 request client、重新 initialize 或启动第二个后端。该构建中重新连接 app-host 会替换原 view，所以不能用另开 MessagePort 的方式探测。

这些私有符号、React 查找和 envelope 映射全部留在可选包内。Core 的新增代码只处理默认 CDP context、world、binding、生命周期和通用失败隔离。

## 能力与调用

类型在 `types/codex-desktop.d.ts`，它独立于 Core 的 `types/renderer.d.ts` 和 `types/host.d.ts`。

| Target capability @1 | 方法 | 语义 |
| --- | --- | --- |
| `codex.desktop.compatibility` | `probe`, `waitReady` | 当前连接身份、初始化进度、可用性与失效原因 |
| `codex.ui.preSubmit` | `getApi`, `interceptors.list` | 主世界回调凭据与有序拦截诊断 |
| `codex.backend.read` | `selection.get` | 当前本地任务、运行回合、加载状态和流归属 |
| `codex.backend.read` | `threads.list`, `threads.get` | 分页目录、线程元数据 |
| 同上 | `turns.list`, `items.list` | 分页 Turn / Item 历史，保留原标识 |
| 同上 | `models.list`, `skills.list`, `providers.list` | 模型、技能、provider 名称；不返回凭据或原配置 |
| 同上 | `approvals.list` | 当前 Desktop 缓存里的待回复请求 |
| `codex.backend.write` | `turns.start`, `turns.steer`, `turns.interrupt` | 在当前窗口已经加载的 owner 任务上操作 |
| 同上 | `approvals.respond` | 按不透明句柄回复当前待处理请求 |
| 同上 | `threads.open` | 校验已有任务并进入原生页面，由 Native 冷恢复 |
| `codex.backend.events` | `read`, `getApi` | 有界事件读取或主世界事件回调 |

插件依赖 capability 描述符，不依赖 `codex.desktop.adapter` 这个实现 ID。替代实现可以声明相同的版本化能力。

消费者应在自己的可取消后台初始化中等待 `waitReady`，不要延长 Core 的入口激活时限。返回 `available: true` 后再使用语义端点；示例面板演示了这个流程。

```js
const read = { name: 'codex.backend.read', api: 1, scope: 'target' };
const page = await ctx.rpc.request(read, 'threads.list', { limit: 20 });
const items = await ctx.rpc.request(read, 'items.list', { threadId, limit: 20 });
```

Host 使用相同方法，通过自己的 raw attachment 调用 `ctx.rpc.target({ sessionId })` 获得 Target scope 后传入 `scope`。这个 scope 仍由 Core 在导航、卸载或旧 generation 退役时撤销。

不接受任意 backend method、hostId、request id、Electron IPC 或 manager object。回合写入支持文本输入，并要求任务已在当前 Desktop 窗口加载且该窗口拥有事件流。`threads.open` 只打开当前窗口的原生任务页面；返回 opening 后应观察 selection.changed，不能据导航回执断言任务已可写。跨 host、无界面预热、任务创建以及任意历史修改不属于 v1 接口。

新增导航仅审核页面 `26.903.71938 / 8576`，在兼容诊断的 navigation 字段单独报告；旧构建、头像浮层或路由不匹配不影响其余后端 API。完整契约与实机记录见 [M3.1/M4.1 说明](UI_HELPERS_AND_NAVIGATION_2026-09-11.md)。

## 提交拦截

```js
const capability = { name: 'codex.ui.preSubmit', api: 1, scope: 'target' };
const access = await ctx.rpc.request(capability, 'getApi');
const dispose = globalThis[Symbol.for(access.symbol)].registerPreSubmit(
  ctx, access.ticket, { id: 'context', priority: 10, timeoutMs: 1000 },
  async (draft, { signal }) => ({
    text: draft.text,
    context: [{ text: '附加资料', kind: 'untrusted' }]
  })
);
```

凭据由 Core 已认证的调用者取得，15 秒内可使用一次，绑定插件 generation 和具体 capability。页面上的稳定对象只提供回调注册；数据读写走 Core RPC。注册自动绑定 `ctx.onDeactivate`，插件也可提前调用返回的 disposer。

返回值同时是 InterceptorHandle，可 `setEnabled(false)` 取消捕获此处理器但尚未发出的提交，再用 `setEnabled(true)` 恢复。`inspect()` 只读取该句柄的统计；`interceptors.list` 通过声明过的 RPC capability 读取完整有序清单。诊断保存有限失败代码，不保存草稿、上下文或插件错误文字。

执行顺序为 priority 升序、插件 ID 字典序、同插件注册顺序。单个处理器最多两秒，整条流水线最多五秒且不能超过 Desktop 原提交时限；最多 32 个处理器和 16 条待提交流水线。空流水线保持同步转发。

处理器在原 `turn/start` 真正转发之前运行。异常、超时或相关插件退役会阻止转发，并通过 Desktop 原请求的失败通路标明插件与处理器来源。迟到的结果不能恢复提交。线程 ID、请求 ID、模型设置、附件和 Desktop 原上下文保持原有归属；改写文本时重新生成文本片段，避免保留错误的富文本偏移。

| 操作 | 本版行为 |
| --- | --- |
| input rewrite | 替换本次尚未提交的文本；后端保存改写后的输入 |
| context injection | 通过当前 schema 的 `additionalContext` 追加带插件来源的上下文；默认 `untrusted` |
| presentation transform | 不提供。Desktop 的乐观消息可继续显示用户原输入 |
| authoritative history mutation | 不提供，不声称能够改写已保存的助手 Item |

UI 输入本身可能经过 Desktop 的 Markdown 序列化；API 返回实际提交的文本。不要把视觉显示和保存的文本当作同一字符串。

## 事件与审批

事件保留 threadId / turnId / itemId；不透明 cursor 属于当前 Adapter 实例。缓冲区上限为 256 条且不超过约 1 MiB。`read` 可以等待最多十秒；同一实例最多 16 个等待者。`gap: true` 表示需要用分页历史补齐，旧实例的 cursor 明确拒绝。主世界回调也会随拥有它的插件卸载而注销。

审批句柄与当前 request 的身份绑定。通过 Desktop 回复、请求结束、插件实例更换后，旧句柄不能再次回复。返回 `submitted` 只表示回复已送出；`approval.retired` 表示 Desktop 本地待处理记录离开，不能据此推断后端接受了回复；只有实际收到 `serverRequest/resolved` 才发出 `approval.resolved`。命令批准只映射一次性允许，不扩展为会话批准或 execpolicy 修改；拒绝按照 Desktop 本次提供的选择映射为 decline 或 cancel。

支持命令、文件修改、可识别权限请求，以及 `item/tool/requestUserInput` 问答。不能完整表示的新权限路径仍可拒绝，批准须使用 Desktop；不提供任意 MCP elicitation 或动态工具结果注入。Core 不包含这些业务字段。

已发送的写操作无法因 RPC 超时、调用者卸载或取消而保证撤销。应先读取事件与历史再决定是否重试，示例不会自动重试写入。

## 失效与清理

构建或初始化探针失败时，不发布该实例的语义端点。启动和导航恢复只清理失败的 renderer 及其依赖者；无关插件继续运行。显式启用、重载、组合包操作仍保留原有事务补偿规则。

运行中发现连接身份、事件标识或已知响应结构不匹配后，数据操作拒绝继续执行；兼容性诊断和已缓冲的失效事件仍可读取。不会转连独立后端。`codlet doctor --json` 能显示 provider 的目标可用性和激活失败原因，它不会把内核注册清单当作端点兼容性证明；`probe` 提供 Adapter 的当前诊断。

主世界正常卸载会还原仍由自己拥有的提交方法，移除 API、事件监听器、回调、等待者、bootstrap script 和 binding。最后一个主世界插件离开时释放共享 ABI 页面属性。外部代码已替换 patch、清理失败或不可逆时，返回 `renderer reload required`，不覆盖其他 patch，也不报告成功撤回。

`ctx.onDeactivate` 最多注册 64 个同步 disposer；正常卸载、失败激活和强制退役都调用一次。异步 disposer 明确报错；需要等待的清理应写在插件的 `deactivate` 中。

通用 `ctx.rpc.unavailable(capability, reason)` 撤下本实例的对应 handler，后续 `provide` 可以重新发布；它不改变 manifest 的静态声明。`ctx.reportDiagnostic` 每个 renderer 实例 generation 最多报告 32 条有来源的观察，Core 校验 binding、context 和 generation 后将其放入运行时诊断；`doctor` 无须执行插件即可查看这些探测结果。

## 当前 Desktop 的任务创建与恢复差异

2026-09-11 的对照测试将此前错误定位到测试协调器：额外的 `--strict-config` 拒绝前向兼容字段；专用 WS 后端还缺少官方的禁用 app-tools transport。修复协调器后，原生输入框新建及完整重启后的侧边栏冷恢复均通过，不再使用最小参数预热。详见[兼容修复与补验](DESKTOP_COMPATIBILITY_2026-09-11.md)。

权限请求支持 local 环境的旧 read/write 路径及 `entries` 中普通 `path` 的 read/write 项；DTO 展示其去重并集，批准回复保持 Native 原权限快照。glob、special、deny、未知结构与其他环境不支持 SDK 批准，返回 `canApprove=false`；可以拒绝或使用原生审批 UI。

验收结果与限制记录在 [M3/M4 验收记录](M3_M4_ACCEPTANCE_2026-09-10.md)。
