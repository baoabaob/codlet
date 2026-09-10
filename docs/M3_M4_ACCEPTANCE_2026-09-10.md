# M3 / M4 开发验收记录（2026-09-10）

本批交付 M3/M4 开发候选：可选托管主世界、提交拦截、复用当前 Desktop 连接的会话语义接口，以及独立消费者面板。实机证据来自专门的隔离测试客户端。现有 M0/M1 生产启动、重复运行和 Runtime Host crash 门禁仍未关闭；本记录不构成 Private Alpha 发布声明。

开发入口见 [Desktop Adapter 说明](DESKTOP_ADAPTER_DEVELOPMENT_2026-09-10.md)、[语义类型](../types/codex-desktop.d.ts) 和 [验收面板](../examples/desktop-m3-m4/README.md)。

## 交付内容

| 层 | 本批行为 |
| --- | --- |
| Core / 托管 ABI | 显式 `ui.mainWorld` 授信；按插件区分 binding、principal 和 generation；限定主 frame 的默认 context；导航恢复；同步 disposer；有来源的通用诊断；可撤下、再发布的 handler |
| 可选 `codex.desktop.adapter` | 当前构建及既有连接探测；确定顺序的 pre-submit 拦截；Thread/Turn/Item 读写、事件及审批映射；失效后拒绝相关调用 |
| 示例消费者 | 使用公开 capability 和回调凭据；任务/历史/模型/技能/provider 查询；发起、追加、中断回合；手动审批与问答 |
| 测试工具 | `Test-Doctor.ps1/.cmd` 对实验资料目录执行只读诊断，保留程序路径、注册表范围及目录身份校验 |

现有 `codex.ui.adapter` 和 Codlet GUI 继续使用 isolated world。新包作为普通本地目录注册，具有显式授信和声明依赖，没有 Core 内置的 provider ID 特权。

## 构建与连接事实

- 安装包：`26.903.8094.0`；页面版本：`26.903.61454` / build `8378`；App Server：`0.153.4`。
- 最后更新的测试客户端 SHA-256：`A591012C31C1073A755B70E93B6DDEC7C757930246E68FB2C2AF87817DB298EC`。
- 最终运行：Host `35472`，Desktop `65192`，实验后端 `28404`。启动记录 `1789054787007-38944` 证明原先已存在的进程保持不变。
- 更新前的上一轮 Host `28256` 正常退出，退出码 `0`；仅回收该轮实验 Desktop 及其拥有的后端。原测试登录资料继续使用。
- Adapter 验证页面已有的 AppScope、local manager、request client 和 app-host 服务对象，且每次操作重新检查身份。读取 family 前先确认 local 成员存在，避免探针创建客户端。

当前构建的普通 App Server 请求经原 Native request client、preload 和 Electron main 路由；app-host 服务继续使用页面原有 MessagePort。源码与实机检查都确认重新发送 `connect-app-host` 会替换原 view，因此本实现复用现有对象。没有打开第二个 MessagePort、另建 request client、再次 initialize 或为 Adapter 启动独立后端。实验客户端本身使用独立后端，这是已存在的测试隔离方式，不能与“Adapter 是否复用该 Desktop 的连接”混为一谈。

私有构建文件只读提取在仓库外用于核对，未修改官方安装包，也未将这些文件纳入交付源码。

## 实机语义验收

统一测试任务：`01a08b6f-48d2-7a52-9251-f04197868c65`，标题 **Codlet M3 M4 acceptance fixture**。所有新增测试回合均限定在这个任务。

| 检查 | 观察与结果 | 本地证据 |
| --- | --- | --- |
| Desktop 原生提交 → SDK 观察 | 在真实输入框发送 `[M3]` 消息；后端用户 Item 去掉前缀，回复 `M3_DESKTOP_OK`。原生乐观消息仍可显示原输入。通过。 | `sdk-probe/result-14.json`、`result-15.json` |
| SDK 写入 → 原生 UI / 同一事件流 | SDK 发起回合，返回 Turn ID 与后端历史、事件和实际 React 页面 Item 标识一致；回复来自追加上下文的校验标记。通过。 | `result-17.json`、`result-18.json` |
| 追加输入 | `turns.steer` 返回同一 Turn ID；相同回合的事件和 UI 收到追加输入。通过。 | `result-19.json` 至 `result-21.json` |
| 命令审批拒绝 | 专用消费者通过公开 API 回复拒绝，映射为本次 Desktop 提供的 `cancel`；后端回合中断，目标测试文件未创建。通过。 | `result-23.json`、`result-24.json` |
| 问答 server-request | 真实 `requestUserInput` 经 SDK 返回 `M4_INPUT_REPLY`；区分本地记录离开和后端实际 `serverRequest/resolved`，UI/回复可见答案。通过。 | `result-26.json`、`result-27.json` |
| 显式中断 | `turns.interrupt` 返回提交结果后，事件流在五秒内确认该回合 `interrupted`。通过。 | `result-28.json` |
| 拦截失败 | 在原生输入框发送 `[M3 BLOCK]`；UI 显示示例插件来源；历史仍为原七个 Turn ID，没有新的后端回合。通过。 | `result-29.json` 至 `result-31.json` |
| 读接口 | 当前连接返回任务、历史、模型、技能与 provider；provider 只输出名称和选择状态。通过。 | `sdk-final-read.json` 及上述历史证据 |

关键标识如下，用于交叉核对，不能仅以模型输出的文本作为成功依据：

| 路径 | Turn / Item |
| --- | --- |
| Desktop 提交 | Turn `01a08b77-369d-7392-952f-ccf539064215`；User Item `01a08b77-4ab2-7092-a8c5-121cab6e3c82`；Assistant Item `msg_0cd317c18c4e929f016aa2adefbcfc87d0b90515acc5d1f329` |
| SDK 上下文注入 | Turn `01a08b7d-7ceb-7a03-b9ea-2b579687187e`；追加校验标记 `M3_CONTEXT_7F2C9A` 未出现在请求的用户文本中，却出现在模型回复及 UI |
| SDK 命令拒绝 | Turn `01a08b86-d81a-7ec1-a166-8df0a01ddf7d`；Item `exec-047eacd7-37b5-4d70-a994-8556b03753bd` |
| SDK 问答回复 | Turn `01a08b93-09ba-7792-b636-752932e4c193`；Item `call_sqiCgXjI4eyDuw5Cbh5Hl41J` |
| SDK 中断 | Turn `01a08b96-8542-7243-8a4b-f6be5c23ca93` |

首轮命令审批被 Desktop 通知操作批准，不能算作 SDK 拒绝成功；该轮模型输出的 `APPROVAL_DECLINED` 也不是权限结果。上表采用重新执行的 SDK 拒绝回合，其文件缺失与后端中断证据一致。

## 窗口、卸载与独立性

真正的两个任务窗口分别为 `57E10CF8090CAE77F4E4FD08558F9639` 和 `05F5FDF4F1E9E3BE25A081003CCF2C2D`。额外的 avatar overlay 明确不计作第二个任务窗口。新窗口初始化、在第二窗口执行 `Page.reload` 后的 document 恢复、另一个窗口身份保持均通过；证据为 `result-1789051994620-g5.json`、`result-1789052165681-g6.json`、`result-1789052698657-g7.json`。

观察到新窗口的 app-host / 账号初始化可耗时二十多秒。Adapter 改为先发布兼容性诊断，再执行最多三十秒的可取消探测；就绪后才发布语义 handler。失败的可选 renderer 及其依赖者不会停掉无关 GUI；显式管理重载仍使用原有事务补偿。后续实机新窗口与导航恢复都验证了这个流程。

最终独立性检查短暂关闭了全部六个可选功能插件及 SDK 探针，只运行 Core 和 `dev.m3-m4.independent-l4`。该插件无 renderer entry、无 capability 依赖，仅获 `host.process` 与 `cdp.raw`；它自己查找页面已有连接，通过公开 CDP 读取同一测试任务和模型列表。结果同时确认主世界托管 ABI 已被移除、仍为同一个 Native request client。这验证了自带 L4 映射不依赖官方 Adapter 或托管 ABI。该检查验证跨层读取；写入和审批的实机证据来自上表的语义 SDK。

独立性证据在 `independent-l4/result.json`、`doctor.json` 及启停 receipts。检查后已恢复 UI Adapter、GUI、隐藏额度提示、M2 示例、Desktop Adapter 与 M3/M4 面板。保留用户草稿和当时的面板开关。所有临时探针已禁用并移除注册，其目录作为本地验收证据保留。

## 自动检查与诊断

- JavaScript：44 项通过，覆盖 bootstrap、idle、Adapter 拦截顺序/异常/超时、旧凭据、实例退役、审批映射、事件游标、schema/identity drift、延迟发布和取消初始化。
- Native：主世界授权与本地加载 30 项、默认 context 身份/清理 1 项通过。实际 Node VM / CDP / 双向 RPC / 组合包回归 17 项，以及 RPC 状态测试 4 项通过。
- Doctor / 实验入口：`doctor_cli` 6、`doctor_model` 13、`doctor_runtime` 7、`lab_harness` 2 项通过；覆盖无标记目录拒绝、只读行为和认证范围。
- 严格 TypeScript 类型检查、`cargo check --locked --all-targets`、Clippy 全 target / feature、格式检查、diff 检查及 locked release 构建通过。

末轮并发回归两次暴露组合包导航失败，单项运行能通过。补充诊断后定位到共享 RPC 状态与 renderer lifecycle 重复消费导航通知：迟到的通知撤销了新文档刚建立的租约。现由托管文档的生命周期 owner 推进共享 scope，raw-only 目标继续由 raw 事件通路负责；失去 managed session 后归还导航责任。新增确定性测试覆盖迟到的 managed/raw 通知、旧租约失效和 owner 退出。修复后的并发 17 项全部通过，原失败日志与 `native-vm-fixed.log` 一并保留，未延长超时或跳过失败用例。更新二进制后又在真实页面执行一次重载，`navigation-final.json` 确认 Adapter 与示例恢复就绪。

便携包的 7 组检查通过，新增 Adapter、类型、示例及开发文档进入显式文件清单，并通过内容哈希、文档链接与只读候选检查。机器相关原始验收产物保留在仓库本地；便携包不复制测试资料目录。打包报告为 `distribution-verified/packaging-acceptance.json`。

最终 `Test-Doctor.ps1 --json` 退出码为 `0`，`runtime.status=inspected` 且 `failedChecks=[]`。报告含带 target / plugin / generation 来源的 `desktop_adapter_ready` 观察。Core 的激活事实与 Adapter 的语义就绪分开解释；doctor 不通过执行私有探针推断兼容性。普通程序路径访问测试 Host 被拒绝的负向记录也保留，未绕过身份校验。

本地证据根目录为仓库下的 `.codlet-artifacts/m3-m4-2026-09-10`。主要汇总是 `sdk-final-read.json`、`doctor-final.json` 和 `independent-l4/result.json`。这些机器相关原始产物留在本地，不随源码提交或进入便携包。

## 范围与限制

当前原生新建任务及冷恢复可能携带 `features.thread_tools`，同包后端以 `-32600` 拒绝该字段。验收通过已有 Desktop request client 的最小创建/恢复请求准备专用任务，再由原 manager 加载。最后一次恢复已确认 `resumeState=resumed`、stream role 为 `owner`。没有修改原生请求或配置，原生入口问题仍存在。

v1 写接口仅支持当前窗口已经加载的 local owner 任务及文本输入。跨 host、SDK 创建/打开任务、任意 MCP elicitation、任意历史修改及 assistant item rewrite 未开放。主世界权限不是隔离沙箱；已送出的操作不能因调用取消而保证撤回。具体权限和事件语义以开发说明为准。

卸载时若 patch 已被外部替换或不能撤回，会明确要求 renderer reload。构建、schema 或连接身份漂移后停止相关语义调用，保留诊断，不转接独立后端。文件修改与权限审批映射有自动检查，本批实机 server-request 往返覆盖命令拒绝和用户问答；没有把未执行的实机分支记作通过。
