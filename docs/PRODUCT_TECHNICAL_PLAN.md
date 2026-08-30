# Codlet（暂定名）产品与技术开发方案

> 状态：Draft 0.4；日期：2026-08-30；平台：Windows-first；产品名：开发阶段暂用 `Codlet`，公开发布名必须通过命名与商标门禁。

## 1. 执行摘要

Codlet 是一个面向 Codex Desktop 的轻量级原生界面扩展运行时。只有用户主动选择 Codlet 专用启动器时，启动前端才创建独立、会话级长驻的 Runtime Host；由 Runtime Host 启动官方 Codex、在整个 Codex 会话中持有继承式 CDP pipe，并将用户插件的 renderer 代码加载到 Codex 页面中。插件可选配独立 host 进程，用于文件、网络、工具和后台任务。

产品的核心价值不是内置大量增强功能，而是提供一个稳定、可诊断、可热更新的内核，让用户自行开发深层 UI 插件。

术语约定：底层产品称为 Codlet Runtime；每个插件称为一个 codlet。随运行时发布的第一个第一方 codlet 也显示为“Codlet”，负责在 Codex 内提供可关闭的管理 GUI。

一句话定义：

> 一个启动前端、一个会话级长驻内核、一个很薄的 renderer bridge，以及无限的用户插件。

## 2. 已确认的产品决策

1. 修改 Codex 原生界面是核心需求，不是可选附属功能。
2. Windows 是首发平台；macOS/Linux 不进入首版范围。
3. Codex 只有通过 Codlet 专用启动器才进入扩展模式；官方入口始终启动原版纯净 Codex。
4. Codlet 不监视、不提示、不接管通过官方入口启动的 Codex，也不在后台等待或劫持后续启动。
5. Codlet 安装、升级和卸载均不关闭或重启 Codex，不修改或捆绑官方安装包、快捷方式、协议关联、配置与用户数据。
6. 插件采用 host/renderer 双半模型。
7. renderer 插件允许分级获得 isolated DOM、main world 和 raw CDP 能力。
8. 首版只运行用户明确授信的本地插件；不宣称提供安全沙箱。
9. 不修改 `app.asar`，不修改官方安装目录，不复制或再分发 Codex，不做 DLL 注入。
10. Codex 内的管理 GUI 由第一方 Codlet 插件提供，不写死在 renderer bootstrap 中。
11. 第一方插件默认启用但可完全禁用；禁用后不留下按钮、面板或观察器，CLI 始终是可恢复的控制平面。
12. inherited CDP pipe 是 Codex 会话的生命周期所有权：Runtime Host 必须与其启动的 Codex 同寿命；pipe 断开会按 Electron 原生语义触发该 Codex 退出。

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

- Provider 切换和 API 协议转换；
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

- 用户从官方入口启动 Codex：Codlet 完全不运行、不观察、不提示，得到原版纯净体验。
- 用户主动启动 Codlet，且没有 Codex 实例：启动扩展实例。
- 用户主动启动 Codlet，且已有 Codlet 扩展实例：激活现有窗口。
- 用户主动启动 Codlet，但已有官方纯净实例：Codlet 仅在自己的启动结果中说明实例冲突并退出；不关闭、不重启、不向现有 Codex 注入，也不持续监视。用户可自行关闭 Codex 后重试。
- Codex build 未识别：进入诊断态，只加载满足已探测能力的插件。

上述行为是产品不变量：Codlet 不安装预先常驻的服务，不监视官方入口；只有 Codlet 启动器被主动调用时才检查运行环境，并且只创建和控制本次会话的 Runtime Host 与 Codex 子进程。Runtime Host 在该 Codex 会话期间长驻，Codex 退出后随即退出。

### 4.3 管理入口

CLI 是产品中始终可恢复的权威控制平面。当前 M0 只实现以下诊断和前台验收命令：

```text
codlet doctor
codlet m0-probe --launch-codex
codlet m0-runtime --launch-codex
```

M0 的仓库级 Windows 外部验收统一使用以下入口；`-CodletPath` 必须由操作者明确指向已经构建好的 `codlet.exe`，脚本不发现、安装或修改工具链：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath "C:\absolute\path\to\codlet.exe"
```

该脚本只有在用户主动执行时运行。它先只读快照精确命名的 `ChatGPT.exe`/`Codex.exe` 进程，发现任一冲突即明确失败，且不调用 Codlet；无冲突时仅执行一次 `codlet.exe m0-runtime --launch-codex` 并实时回显输出。当 Codlet 输出精确的 Runtime active 协议行时，脚本立即取一次运行中快照；命令返回后再取结束快照。它不终止进程、不重试、不启动官方入口、不持续监视，也不修改 Codex 或用户配置。

以下正式控制命令属于后续里程碑，当前尚未实现：

```text
codlet launch
codlet status
codlet plugin add <path>
codlet plugin list
codlet plugin enable <id>
codlet plugin disable <id>
codlet plugin reload <id>
```

第一方 `codlet` 插件默认启用。它使用普通 plugin manifest、生命周期和 renderer bridge，在 Codex 顶部应用栏的原生菜单之后增加一个紧凑按钮；点击后打开 Codlet 管理面板。按钮插槽由 adapter capability `codex.ui.titlebar.afterMenu` 提供，不允许插件散落硬编码 selector。

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
├── version capability adapter
├── plugin registry and lifecycle
├── renderer bridge and bundled first-party codlet
├── optional plugin-host supervisor
└── diagnostics and logs
          │
          ├── Codex renderer
          │   ├── isolated-world plugins
          │   └── main-world plugins
          │
          └── plugin host processes
```

M0 只交付可实机验收的前台 Runtime Host 路径；独立后台化、启动前端与 Runtime Host 的控制 IPC、未来 GUI 接入均记录为后续里程碑，不在本轮扩张实现。

### 5.1 核心与适配器分离

稳定内核负责：

- Windows 启动和 pipe 生命周期；
- CDP request/response/event 路由；
- 插件 ABI、注册表、状态机和错误模型；
- 权限确认、日志和诊断。

Codex 适配器负责：

- 识别 Codex build 和主 renderer target；
- 提供版本相关的 DOM anchor、React hook 和 `electronBridge` 能力描述；
- 对目标 build 执行兼容性探测。

用户插件依赖适配器能力，而不是直接依赖 Codlet 内核版本。选择 raw main-world/CDP 的插件自行承担 Codex 内部变化风险。

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
- Runtime Host 必须在整个 Codex 会话中保持存活。Electron 将 remote-debugging pipe disconnect 绑定到 `Browser::Quit()`，因此 Runtime Host 退出、崩溃或关闭 pipe 会使本次启动的 Codex 按协议退出；
- Codex 不加入 `KILL_ON_JOB_CLOSE` Job Object，也不调用 `TerminateProcess`；process handle 只用于观察退出状态。Codex 的退出由用户关闭窗口或上述 Electron pipe-disconnect 语义产生；
- 用户关闭 Codex 后，Runtime Host 观察 child exit/pipe EOF，在有限 deadline 内回收 CDP workers 并干净退出；
- 单个插件或插件 host 的失败不得结束 Runtime Host；仅插件 host 进程加入 Runtime Host 的 Job Object，保证插件资源可回收且 CDP pipe 继续存活；
- CDP worker 回收使用有限 deadline；显式 shutdown 超时会保留 worker ownership 供重试，而 `ClientInner::drop` 或半启动清理仍无法收回 worker 时，Runtime Host fail-fast 并 abort 自身，绝不静默遗留 detached thread。该路径不调用 Codex 终止 API，但进程退出造成的 pipe disconnect 会触发 Electron 退出。

### 6.4 最大可行性风险

2026-08-30 的只读 `doctor` 检测到安装 build `26.825.6671.0`，用户确认其最新外部 M0 运行使用了该 build。该记录只证明这次外部运行的版本覆盖，不构成对后续 Codex build 的兼容承诺。M0 尚需以明确记录验证会话级 Runtime Host 的完整生命周期、重复性、官方入口零行为、孤儿进程与端口基线；Shell/URI 激活不能替代这些验证。

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
  "requires": ["codex.shell.main"]
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

首版没有插件依赖图、包解析、远程来源或 semver 求解。

### 7.3 权限层级

| 权限 | 能力 | 风险等级 |
|---|---|---:|
| `ui.dom` | isolated world 中读写 DOM、CSS 和事件 | 中 |
| `ui.mainWorld` | 访问页面全局、patch 函数、观察 React、调用公开 bridge | 高 |
| `cdp.raw` | 直接发送 CDP 方法 | 极高 |
| `host.process` | 启动拥有当前用户权限的 host 进程 | 极高 |
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
- 顶栏按钮只依赖 adapter 提供的 `codex.ui.titlebar.afterMenu` capability；
- 管理面板通过公开、版本化的 `runtime.manage` API 工作，不调用隐藏 IPC；
- 发布清单记录该第一方插件的内容摘要与权限授予，第三方插件请求同一权限时仍需用户明确授权；
- 自我禁用前明确说明“禁用后只能通过 CLI 重新启用”；确认后先提交配置，再执行 deactivate；
- deactivate 必须移除按钮、面板、样式、listener 和 observer，不能残留不可见后台逻辑。

第一版面板只承担运行时状态、插件列表、启用/禁用、重载、权限查看和诊断入口，不演变为独立应用商店。

## 8. Renderer bridge

### 8.1 注入顺序

1. `Target.getTargets`；
2. 选择并验证 `app://-/index.html` 主 target；
3. `Target.attachToTarget(flatten=true)`；
4. `Runtime.enable` 和 `Page.enable`；
5. 安装 Codlet bootstrap；
6. 为每个插件创建 generation/epoch；
7. 注入 renderer entry；
8. 等待插件 `ready` 握手后才标记 active。

### 8.2 world 策略

- 默认 `isolated`：共享 DOM，不共享页面 JS 全局；
- `main`：仅对明确授信插件开放；
- `Page.addScriptToEvaluateOnNewDocument` 负责导航后的自动恢复；
- `Runtime.addBinding` 只接受字符串载荷，Codlet 在其上实现版本化 RPC；
- binding 按插件命名，且绑定到指定 execution context/world。

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
3. 检查权限授权和 adapter capabilities；
4. 如有 host，启动并完成握手；
5. 注入新 renderer generation；
6. renderer 返回 ready；
7. 原子切换为 active；
8. 再停用旧 generation。

新 generation 失败时保留旧 generation；不自动重试。文件变化 debounce 后重新扫描整个插件目录，避免读到编辑器临时文件和半完成 rename。

调度规则：

- 插件激活按用户配置顺序串行；
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

### 10.2 TypeScript SDK

提供一个很薄的开发包：

```text
packages/codlet-sdk/
├── definePlugin
├── RendererContext types
├── Host RPC types
└── build template
```

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
- capability 匹配和冲突处理。

### 14.2 集成测试

- fake CDP child process；
- Windows inherited handle 白名单；
- parent 持有 pipe 时 child 保持运行，parent 显式关闭/EOF 后 child 退出；
- child 自行退出后前台 Runtime Host 回收全部 CDP workers；
- 插件 host crash、hang 和 malformed response；
- renderer navigation、reload 和 target replacement；
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

- 连续冷启动至少 100 次，无孤儿 Runtime Host/plugin-host 进程；
- 同一 Codex build 注入成功率至少 99%；
- 从官方入口启动 Codex 时，无 Codlet 进程、日志、提示或界面变化；
- 已有官方纯净 Codex 时主动启动 Codlet，现有进程继续运行且不被注入，Codlet 报告冲突后退出；
- Runtime Host 存活并持有 pipe 时，由它启动的 Codex 持续可见、可交互；
- 用户关闭 Codex 后，Runtime Host 干净退出且无遗留 worker；Runtime Host 强制崩溃时，该 Codex 按 pipe-disconnect 契约退出且不产生孤儿进程；
- 端口扫描确认没有 Codlet CDP listener；
- 一个故障插件不影响其他插件和 Codex。

## 15. 阶段性验收里程碑

不使用日历排期衡量开发进度。每个阶段必须同时具备可重复的自动化证据和该阶段明确列出的外部实机门禁，二者全部通过才判定完成；实现、测试、文档和兼容性探测可由多个 agent 并行推进，但任何并行产物都必须通过同一集成门禁。

### M0：Transport 可行性门禁

验收条件：

- 能从当前用户安装的 Codex MSIX 定位可执行文件，全程不修改官方包；
- 能使用 `CreateProcessW` 和精确 inherited handles 启动 Codex；
- CDP NUL framing、request/event 路由和 target discovery 均通过自动化测试；
- 能向主 renderer 注入并完整移除一个 Codlet 标记；
- 前台 Runtime Host 在 marker 探针完成后继续持有 CDP pipes，期间 Codex 可见且可正常使用；
- 用户关闭 Codex 后 Runtime Host 观察退出、回收 CDP workers 并正常返回；Runtime Host 异常退出时 Codex 按 Electron pipe-disconnect 契约退出；
- 官方入口启动的 Codex 不产生任何 Codlet 行为；已有官方实例时主动启动 Codlet，Codlet 只报告冲突并退出；
- 上述完整链路可连续重复通过，无孤儿进程和开放的 CDP TCP 端口。

M0 验收矩阵：

| 门禁 | 自动化证据 | 必需的外部实机判定 |
|---|---|---|
| inherited pipe、路由、target、marker | fake child 全量测试；ignored + env opt-in 的一次性 real smoke | 当前安装 build 能完成真实 attach 与 marker；smoke 结束后 Electron 随 pipe disconnect 退出是预期结果 |
| 会话级 Runtime Host 生命周期 | fake child 验证持 pipe 存活、EOF 退出、child exit 后 worker 回收 | `m0-runtime --launch-codex` 运行期间 Codex 可见可用；用户关闭 Codex 后 Runtime Host 正常返回 |
| 官方入口与实例冲突边界 | 包实例冲突自动化测试 | 官方入口零 Codlet 行为；既有官方实例不被注入、不被关闭或重启 |
| 稳定性与外部副作用 | 静态检查和 fake child 回归 | 连续重复、孤儿进程、端口扫描与异常退出契约全部通过 |

决策：全部通过才进入 M1。若 inherited pipe 不成立，停止插件内核建设，单独评审 transport，不并行维护未经验证的备用实现。

### M1：Renderer Runtime 门禁

验收条件：

- plugin manifest、本地 registry、isolated/main world 与 activate/deactivate 状态机可用；
- generation/epoch 能阻止旧实例继续发消息；
- 文件保存触发原子热重载，失败的新 generation 不替换仍可用的旧 generation；
- 第一方 `codlet` 插件通过普通 manifest 在 adapter 插槽中挂载顶栏按钮并开关管理面板；
- 该插件能由 CLI 启停、重载并完全清理按钮、面板及其他可逆资源；
- 另一个最小状态角标示例插件验证第一方与第三方走同一加载路径；
- 单个 renderer 插件的语法错误、激活异常或超时不影响 Codex 和其他插件；
- `codlet doctor` 能给出 build、target、capability、插件状态与可行动的错误原因。

### M2：Host Half 与权限门禁

验收条件：

- 可选 host process、JSONL RPC 和按插件隔离的 Job Object 可用；
- `ui.dom`、`ui.mainWorld`、`cdp.raw`、`host.process` 均在首次使用前显示并记录独立授权；
- 公开、版本化的 `runtime.manage` API 能支持第一方 GUI 查询、启停和重载插件；
- host crash、hang、malformed response 和越权调用都有确定的失败结果，不拖垮其他插件；
- renderer 与 host 的 RPC schema、deadline、generation 和错误语义由 TypeScript SDK 固化；
- 示例 host 插件完成文件读取与网络请求，并能在撤销权限后立即停止相关能力。
- 第一方 `codlet` 插件自我禁用后 GUI 完全消失，且 `codlet plugin enable codlet` 能恢复；升级保持用户的禁用选择。

### M3：Private Alpha 门禁

验收条件：

- 用户级安装、升级和卸载可重复通过，发布产物带测试签名；
- 安装包不包含 Codex 文件，不修改官方包、官方入口、协议关联、配置或用户数据；
- 安装、升级和卸载期间不检测、关闭或重启 Codex；
- 官方入口与独立 Codlet 入口并存，官方入口连续启动均保持原版纯净行为；
- 日志、诊断包、safe mode 和故障恢复文档能定位所有已知启动与插件故障；
- 第 14.3 节实机门禁全部通过。

### M4：Public Beta 门禁

验收条件：

- 至少经历一次真实 Codex 更新并完成 adapter 适配；
- 安全评审、依赖许可证清单、SBOM 和发布签名流程完成；
- 插件开发文档、模板和三到五个覆盖不同权限层级的示例完成；
- 安装、升级、卸载、Runtime Host 异常退出及其 pipe-disconnect 结果、插件崩溃和 Codex 更新路径全部通过发布门禁；
- 公开品牌、包命名空间、域名与商标风险完成核验并冻结。

## 16. 第一批并行开发工作包

M0 拆为四条可并行工作流，由一个集成分支收口：

1. **Launcher**：Rust binary、Package Family discovery、现有实例冲突报告、`CreateProcessW` 与 handle 白名单；
2. **Transport**：以 fake child 为目标实现 pipe、NUL reader/writer、request/event router 和 EOF teardown；
3. **Renderer Probe**：target 识别、execution context 选择、可移除视觉标记和最小 bootstrap；
4. **Verification**：官方纯净启动基线、进程/端口观测、重复启动、Runtime Host 持 pipe/child exit/worker 回收测试。

Launcher 与 Transport 接通后立即合并 Renderer Probe；Verification 持续运行。M0 验收报告作 go/no-go 决策，未通过前不创建 plugin registry 或 SDK。

## 17. 主要风险

| 风险 | 影响 | 对策 |
|---|---|---|
| MSIX 直接启动不接受 inherited handles | 项目核心路径不可行 | M0 首先验证；不先建设插件系统 |
| Runtime Host 提前退出或失去 pipe | 本次扩展 Codex 按 Electron 契约退出 | 启动前端与会话级 Runtime Host 分离；插件失败隔离；生命周期与 worker 回收门禁 |
| 已有官方纯净 Codex 时再启动 Codlet | Electron 单实例导致扩展实例无法建立 | 仅在 Codlet 本次启动中报告冲突并退出；不触碰现有 Codex |
| Codex 更新改变 target/DOM/React | 深层插件失效 | 稳定内核与版本 adapter 分离；能力探测；明确失败 |
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
2. 在 M4 前设置独立命名门禁；若继续使用 Codlet，必须完成专业商标检索并接受包名、域名和搜索可发现性成本；
3. 名称冻结前不制作正式 Logo，不注册无法迁移的公共账号；
4. 最终候选必须核验 GitHub、npm、crates.io、PyPI、主要域名和目标市场商标库。

## 20. 当前唯一 Go/No-Go 问题

现在不应该先写插件管理器，也不应该先画管理 UI。唯一正确的第一步是证明：

> 当前 Windows Store Codex 能否由会话级 Runtime Host 使用 inherited CDP pipe 稳定启动并控制 renderer，在 Runtime Host 存活时持续正常工作、由用户关闭后让 Runtime Host 干净退出，同时让官方入口和既有原版进程完全不受影响。

这个结论决定整个项目是否成立。
