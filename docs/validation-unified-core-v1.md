# 1.0.0-rc.1 本地候选验证

日期：2026-10-15（Asia/Shanghai）。本轮完成 Core SDK、权限边界、兼容在线更新与消费者迁移的实现，并完成下述 Windows 独立 Native 验证。交付只在本机生成，没有公开发布，也没有安装到日常 Native 环境；未覆盖的平台和输入场景在文末单列。

## 源码与交付身份

| 项目 | 实施提交 | 版本 |
| --- | --- | --- |
| Core 生产包 | `c7e68a32e89d9f4d166a914b1e2d8555a6d3cf6b` | `1.0.0-rc.1` |
| GUI 与完整功能测试插件 | `dcdf5166ba10acb54086f95ac28fefed556b560e` | `1.0.0-rc.1` |
| 分屏包 | `e08f66e92c8c2d1d3dba9ca9aa762bd7706a864b`（实现 `9ab77299cd5acb685f048ae859e57a939c7d1236`，其后仅更新验证文档/声明） | `1.0.0-rc.1` |

三个仓库均使用本地 `codex/unified-core-v1` 分支。接手时的 Core 与官方插件工作区先分别保存为 `520f581c81b2ad336a0aa45b0ad0cb4341ff5271`、`af7694d63e1ca391e0c924f6f3db9f718659e055`，之后才提交此次迁移；已有修改和旧验证记录均保留。

Windows 制品位于 `.codlet-artifacts/major-v1-delivery-20261015-c/`。Core 安装器、便携 ZIP 和运行时更新 ZIP 均从表中的干净 Core 提交构建。初始实现为 `9a405465b0308e004e3bd820c5e086452dc58a0f`；之后补入 CLI 来源分类、失败回执诊断、Native 会话输入区与跨代返回位置修复。后续只更新验收文档的提交不会改变已生成包的源码身份；最终交付清单分别列出工作区 HEAD、包的源码提交和各交付包、文档与收录证据的 SHA-256。前两轮制品与失败记录保留，不覆盖旧包。

## 自动检查

| 范围 | 结果 | 证据文件（相对 Core 仓库） |
| --- | --- | --- |
| 最终源码：仓库 CI 配置的 Rust 全目标、全功能 | 804 通过，0 失败，9 忽略 | `.codlet-artifacts/major-v1-rust-ci-g-verified.log` |
| 最终源码：默认功能下的 SDK 迁移、Host 插件、运行清单 | 12/12 | `.codlet-artifacts/major-v1-default-migration-g-verified.log` |
| 初始实现：默认生产库与七个重点集成 suite | 609 通过，0 失败，8 忽略 | `.codlet-artifacts/major-v1-rust-default-core-verified.log` |
| 初始实现：组合生命周期、GUI 别名、CLI、doctor 的两种模式 | 默认 21/21；全功能 21/21，顺序执行 | `.codlet-artifacts/major-v1-selected-cli-verification-20261015.md` |
| Core Node 测试 | 341/341 | `.codlet-artifacts/major-v1-core-node-g-final.log` |
| Core 内置 UI/Desktop 模块 | 354 通过，0 失败，2 跳过 | `.codlet-artifacts/major-v1-owned-node-g-verified.log` |
| 官方插件源仓 | 454 通过，0 失败，4 跳过 | `.codlet-artifacts/major-v1-plugins-final-verified.log` |
| 分屏消费者 | 147/147 | `.codlet-artifacts/major-v1-split-onboarding-full.log` |
| TypeScript | 通过 | `.codlet-artifacts/major-v1-typecheck-verified.log` |
| Rust 格式与严格 Clippy | 全目标、全功能、`-D warnings` 通过 | `.codlet-artifacts/major-v1-fmt-g-verified.log`、`.codlet-artifacts/major-v1-clippy-g-verified.log` |
| runtime skill 校验 | 通过 | `.codlet-artifacts/major-v1-skill-validation-verified.log` |
| macOS 打包逻辑的 Python 检查 | 6/6；在 Windows 执行 | `.codlet-artifacts/major-v1-macos-package-python.log` |

上述范围有重叠，不能把各行相加作为独立测试总量。Rust 的完整合成集成测试使用仓库规定的 `test-fixtures` 功能；默认生产检查单独列明范围。早期同时构建两种功能组合的诊断轮次可能覆盖共享 CLI 输出，未计作最终通过证据；最终 CI 和重点双模式检查均顺序执行。Core 内置模块使用维护入口 `node codex/test.mjs`；直接展开所有上游保留测试会包含外部发布仓依赖，其失败诊断未计入最终结果。跳过项不计为通过。Windows 增量编译缓存曾报告无法完成缓存目录；对应编译、测试与严格 Clippy 均正常 exit 0。

关键回归包含：旧 Adapter 注册、授权与文件保留；固定 Core 提供者不与旧注册竞争；普通 SDK 不借用 Core 的原始权限；原始 Host、CDP、主世界及指定程序边界；跨代状态恢复；已接受调用与流的清理；迟到回执只查询、不重放；并发模块更新和未知结果保留所有权。

实际前台协调器测试使用 VM Renderer、真实 Node Host 与真实鉴权桥接传输，验证 Applied/NextStart、丢失首个 source/release 回执、Host 计数状态恢复、唯一接管与各层写入门禁释放；在全局门禁保持期间，Renderer 恢复仍可调用真实 Host RPC。候选与回滚都激活失败时，原始阶段错误有界保留在回执中，所有权保持，不执行 source 接管或释放。它属于组件集成证据，不能替代 Electron Native 的实际会话验收。

## 制品检查

- Core 以生产功能构建 release 可执行文件；没有打入合成测试插件或独立验收入口。
- MSI 只读结构检查通过：Core、GUI、开始菜单、桌面快捷方式、PATH 五个选项；没有单独 Adapter、Node 或插件载荷；不自动关闭正在运行的应用。没有执行 MSI 安装。
- 便携包 CLI 在独立 `CODLET_HOME` 中显示两个 `owner: core` 的内置提供者和空普通插件列表。GUI 包预览与离线注册通过，只声明 `ui.dom`、`runtime.manage`。
- GUI 生成发布目录绑定干净的官方插件源仓提交，重新编译的字节与包中 bundle 一致。完整测试插件 ZIP 排除测试凭据、服务器数据和报告。
- GUI 离线来源切换另以生产候选 B 的 CLI 验证：真实旧 GUI 0.1.9 的启用/禁用两种状态、原授权、broker policy、历史和文件均保留。恢复旧包为本地来源，不冒充恢复 GitHub 管理关系。候选 C 包含同一 CLI 修复；操作与原始回执在 `.codlet-artifacts/major-v1-gui-offline-upgrade-audit-20261015-e/`，交付目录附 `OFFLINE-GUI.md`。
- 运行时 ZIP 为未发布的 preview/portable 首次迁移包，不带在线组件元数据，下载 URL 为空。它不能冒充已上线的更新通道。
- 五个 ZIP 的 CRC、路径安全、清单文件摘要及 SDK 能力声明对齐检查全部通过；分屏包与实机装载的 renderer 摘要相同，最终展开包另经生产 CLI 预览通过。各交付包、文档和收录证据由 `manifest.json` 与 `SHA256SUMS.txt` 固定身份。

## 独立 Native：已完成的功能验证与失败定位

Windows Native 包为 `26.1007.9446.0`，前端 `26.1007.71326` / build `20398`，独立后端 `0.162.0-alpha.17.2`。每个测试 run 均使用独立 profile、项目、合成服务和精确 PID/创建时间核验；没有向日常会话发送测试输入。

每轮使用不可变的私有 `desktop-acceptance` 程序，并核验构建前后源码清单一致；生产安装包不包含这个入口。最后一轮 G 从干净 `c7e68a3` 构建，程序 SHA-256 为 `9457f0a7fbead511ae80d17975222786f2c57be00c19bcc9d936a5abc58ea026`，源码清单 SHA-256 为 `6ab27146c374f781026893e425cc4937d8899b774bae42152a23e8dfb581db80`。私有验收使用固定 bundled Node pin；生产包仍采用固定摘要校验的 managed Node。

早期 C run `230705d5-0a10-4821-94f4-1b9a883b21a4` 的 Host 10 项通过，Renderer 7 项通过、3 项失败、1 项人工待验；分屏导入超时。探测与 DOM 证据表明它停留在 `/welcome`，没有 Native 导航栏、主工作区或输入器，不能算 UI 已就绪。修复后的分屏初始化允许欢迎页上的导航准备继续异步完成，进入分屏仍检查真实能力；相关两项真实消费者控制器回归通过。原始失败与回执均保留在该 run 目录，不把后端 ready 当作工作区 ready。

D run `49ccb623-caab-42ca-98cd-9e2e46dc0aca` 通过正常欢迎流程进入主工作区后，完整测试插件的 Host **10/10**、Renderer **10/10** 自动检查通过；包括存储冲突、事件、任务取消、文件、进程、网络凭据、HTTP/SSE/WS、自有流量拦截、Desktop 读取、原生页面/工具栏/控件及未发送草稿。单独的模型操作仍标为人工待验。GUI 与最新分屏导入均 `applied`、无 target failure；GUI 页面实际显示普通插件，未把 Core 提供者当作可管理插件。此时没有合成会话正文，尚不能据此认定分屏会话进入/选择已验收。D 于 2026-10-15 02:30:54（Asia/Shanghai）正常关闭，Core exit 0，五个已核验根进程身份全部不存在。

D 的合成流量 source 描述因私有工具将 Windows 普通路径与 verbatim 路径作字符串比较而被拒绝；原输入已消费，不重放。修复位于 `b2695c35bab435fa50641eaa630822824c38f4ae`，仅在 `desktop-acceptance` 下编译。路径、身份、终端拒绝回执与防重放八项补充回归通过，E 起注册成功。

E run `7d6c6a94-606b-446a-b3dd-f8c7f082e82d` 验证真实 owned model turn、流事件、历史、打断、审批、working 状态和两会话分屏进入/选择/退出。旧 Native 会话输入区的工具按钮定位失败，Renderer 为 13 通过、1 失败；Core 在 `59f4777` 修复并加入回归，G 已实际确认按钮、回调与清理且只有一个输入器。E 的完整模块更新结果为 `unknown`；240 秒请求仍收到顺序完整的 480 段 SSE，后端最终正文也含同样序列，Native 与后端原 TCP 连接保留。这只证明失败路径下流继续，不能算更新成功。E 于 02:50:34 正常关闭，五个记录根身份均不存在。

F run `6b6fb3e2-80d9-427a-9a2f-81273e63432f` 的有界诊断明确指出：分屏候选及回滚激活均拒绝返回位置，错误为 `Captured location belongs to another Native host`。Core 把同一 Native router 在不同模块代际中的新包装对象误判为换了宿主。`c7e68a3` 改用真实 Native document/root/router 或原始函数的身份，位置票据仅保留数据和来源，不保留旧 Core wrapper；不同真实宿主仍拒绝，30 项相关回归通过。内部数据记录升为 v2，不通过宽松兼容采用早期未发布 v1 票据。G 因此从新文档建立基线。F 的流同样完整，但更新仍是失败记录；正常关闭后五个根身份和十个同期归属子进程身份均不存在。

## G 最终 Native 验收

run `c98d388a-28cb-4d86-92d1-db081b81e519` 的正常欢迎流程、实际工作区和会话输入区已确认。首次功能轮次为 13 通过、1 失败：新线程配置为 `openai`、直接访问合成上游，因此请求/响应 transform 未生效。它只证明了 source 注册，没有证明线程使用 Core 路由；该原报告保留。通过标准 `threads.reconfigure` 显式配置精确 owned 线程，取得 `applied`，随后 `threads.configuration` 回读确认 `owned-core-fixture`。此前已开始的上游直连测试明确打断，其结果不作为 Core 连续性证据。

配置确认后发起一个新的持续流意图，再单次提交候选 `9ef4d0438e70ac23002fd0c9495f00cdf2d70793a00ee3e269d419a0e3ec4935`。操作 `core-online-45452-1792007477482` 于 03:51:34 返回 `onlineApplied`。候选是专用于独立验收的 `1.0.0-rc.2`，为每个模块加入唯一运行标记，不作为发布包。原始回执、候选与构建清单均保留。

- 十一项 JavaScript 模块及 Native source 共 **12 项实际执行标记**均为正，包含 UI/Desktop 激活、Host 工厂，以及 Native `install`、`restore`、`ready`、`confirmTakeover`；没有用单纯解析或预检标记替代运行证据。最终 Native epoch 为 1，写入门禁已释放，无 pending/uncertain/waiting 写入。
- 持久化清单中的 11 个模块、Native source 和 4 个常驻文件全部逐文件摘要匹配（16/16）。这是组件持久化证据；运行中的 Rust/Node/桥接仍是原来的常驻组件。
- 唯一持续流请求 9、turn `01a13bf6-8186-7bd2-9542-cbcb0429184e` 收到完整 **1→480** 段，设定间隔 500 ms，观测最大间隔 516 ms。任务实际持续 245.591 秒；后端 assistant 正文与 `task_complete` 的 25,920 字节完全一致，SHA-256 为 `59a32f0c6d8baf62301c2ada426bdf43322e5146d41005db8a86459577680404`。该结论来自合成服务 JSONL 与实际后端落盘记录的独立只读核对，不依赖更新后的插件报告。
- 更新前后 Native PID/创建身份、后端 PID/创建身份、连接地址 `127.0.0.1:63595→50461` 及连接创建时间完全一致；没有新增 AppServer 连接。分屏在更新后仍为两个成员、grid/seamless、原选中会话，主输入器为一个；退出后恢复进入分屏前的第二个会话。GUI 更新后可渲染，GUI 页面没有额外输入器。
- 完整测试插件 Renderer 从 generation 1 升至 2，保存的 14 项结果逐项一致，包括先前的 13 通过、1 失败，以及其中缓存的 Host 10/10 报告。没有把恢复的旧结果当成新测试通过。Host 新实例的工厂执行和协调器恢复回执另有记录；缓存报告的 generation 1 是历史数据，不能用它替代新 Host 的回读。组件集成测试独立覆盖真实 Host 状态值和跨恢复 RPC。

在线接管之后，最终完整功能复测在新建的空历史 owned 会话上执行，先显式配置并回读 `owned-core-fixture`。Renderer **14/14**、Host **10/10** 通过；包含实际请求/响应拦截回调、修改后的模型响应进入 Native 历史、提交 hook、流事件、steer/interrupt、审批读取、Core 存储/事件/任务/文件/进程/网络/HTTP/SSE/WS，以及页面/工具栏/会话输入区控件。它们是新的执行结果，报告 generation 2；没有继承旧失败报告为通过。

测试探针在读取状态时曾达到自身 200,000 字节报告上限；原错误与查询保留，上述恢复状态从修复前的原查询中归档核对。随后一次复测的已有历史包含长流标记，合成服务据整段历史误选长流路径，探针又误将等待会话阶段视为终态；这两项夹具前提均保留记录，最终使用明确配置的空历史会话完成新检查。修复仅限忽略的验收工具；后续普通 probe 重载和新的功能复测不作为 whole-Core 状态恢复的证据。

G 于 04:08:02 正常退出，Core exit 0，后端随已归属客户端退出而停止。04:09:12 的创建身份核对确认五个根进程及三次同期父链采样合并的 **25 个不同身份全部不存在**；这不是 Chromium 全历史进程普查。结构化摘要为该 run 的 `native-evidence-summary.json`，交付目录收录为 `evidence/native-g-summary.json`。A 的启动失败、C 的欢迎页前置条件失败和 E/F 的更新失败均保留原记录，相关独立实例已退出；没有操作日常客户端。

## 更新与兼容边界

Windows 兼容更新可替换十一项声明的 JavaScript 模块及 Native source，并恢复显式插件 JSON 状态。Rust 可执行程序、Node、固定桥接/注入与转发层仍属于 Core；这些常驻组件的变化，以及首次从旧架构升级，需在下一次自然启动生效。存在活动的插件自有 Host 流量资源时会延后，保留原调用与资源。macOS 的整包更新采用 next-start，当前没有在线组件包契约。

真实 Native 流量验收使用明确标为 `fixture-explicit-source` 的本地合成源。它不能证明自动 backend-spawn 适配、真实 OAuth 服务或任意外部后端的迁移。普通插件仍是可信代码模型，Node `vm`、共享 DOM 与权限标签均不是恶意代码沙箱。返回 Native 函数、React 上下文和本地 DOM 句柄的 Workspace API 仍需要主世界权限；一般数据、页面和标准服务接口不因此继承该权限。

没有本轮 macOS 桌面、Windows ARM64、全新设备安装/升级/卸载或签名验收。附件、IME、系统快捷键冲突及真实剪贴板交互也必须按实际场景单独记录，不能从 jsdom、IPC、旧版记录或 Native 只读探测推断通过。
