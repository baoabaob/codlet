# Desktop 兼容修复与 M3/M4 补验

日期：2026-09-11。范围：Windows x64 独立测试客户端；原生任务新建、冷恢复、版本适配和审批。常规生产启动的 M0/M1 发布门禁继续保留。

## 结论与根因更正

原生新建与冷恢复已经通过。2026-09-10 记录中把 `features.thread_tools` 的 `-32600` 归为上游问题并不准确：受控对照表明，测试协调器额外传入的 `--strict-config` 才使该前向兼容字段被拒绝。

移除严格模式后，完整原生请求还暴露出第二项测试配置缺失：前端会设置 `mcp_servers.codex_app.enabled_tools`，专用 WS 后端却没有对应的基础 transport。协调器现使用当前官方 Desktop 在 app-tools 不可用时采用的 `mcp_servers.codex_app={command="",enabled=false}`。该工具桥保持禁用，原生请求不删字段，也不连接日常 Desktop 的固定 IPC router。

两组真实 CLI 对照均使用新建的无登录资料目录、ephemeral thread，无模型回合：

| 对照 | 原配置 | 修复配置 |
| --- | --- | --- |
| `features.thread_tools=true` | strict 模式拒绝 `-32600` | 默认解析接受 |
| 原生 app-tools 过滤字段 | 缺少 transport 时拒绝 `-32600` | 官方禁用 transport 接受 |

四个受控后端均通过 stdin EOF 退出 0，未强制终止。日志位于本地 `.codlet-artifacts/desktop-compatibility-2026-09-11/` 中的 `strict-config-comparison.json` 和 `app-tools-config-comparison.json`。

## 已审核构建与实现

| 安装包 / 架构 | 页面版本 / build | App Server | 状态 |
| --- | --- | --- | --- |
| `26.903.8094.0` / x64 | `26.903.61454` / `8378` | `0.153.4` | 保留原适配配置及回归 |
| `26.903.9818.0` / x64 | `26.903.71938` / `8576` | `0.153.4` | 本轮源码审核与实机验证 |

新包审核覆盖：显式 user-data 在单实例锁前设置；专用 WS 不创建固定 stdio IPC client；Dev/禁用更新标志；26 项受限 feature override；shell 环境与 SQLite guard；固定 `quit-app`；Windows 提前退出协议注册分支。当前 CLI 的 Authenticode 签名有效，SHA-256 为 `3D6CA7085C932B62EF4EE4877E92F15B050FB94B2EB8E6C10A346A06248C6004`。

编译资源仅作为数据读取到本机研究目录，没有修改官方安装或复制官方资产进入分发。当前 Native main SHA-256 为 `471f06dfcda15de10196f701504244c6f412d7ed401c155efc56a427a89a3195`；前端 app-initial 为 `364622097d1440b55bcd85b1068245a773f5821f4fd6c1e2de73e5789487c75a`。

Adapter 把各构建的资源与私有导出映射保存在不可变 profile 中，连接持有自己验证通过的 profile。状态仅返回 appVersion、buildNumber、appServerVersion；私有模块地址与导出名称不进入公共 DTO。后续操作复查构建、AppScope、缓存成员、manager、request client、services 和 postbox。

实际首次启动发现 lazy bootstrap 的导出可能尚未赋值。探测现在每次就绪检查读取 live export，在 Native local 缓存已存在后才固定引用；不提前创建 manager/client，也未加长 30 秒等待预算。修复后的两次完整启动均自动就绪，无需管理重载。

协调器另修复了 Windows 路径分隔符比较，以及旧 PID 不存在时 PowerShell 查询意外返回非零的问题。每次启动继续读取实际生效配置：独立 file credential store、只读 backend、禁用 app-tools、sandbox readiness、无 Chrome 插件和 foreign Origin 403。

## 中断的测试资料恢复

旧测试记录保留了已经退出的进程，却没有 `child_exited` / `cdp_workers_reaped` 关闭事件。本轮没有把它改写为正常关闭，也没有归因为系统重启。

默认 resume 仍要求最新的完整关闭记录。额外的 `--recover-interrupted` 必须显式选择：独占原 root lease，核对原始最新 report 与匹配的 coordinator receipt，确认旧 Desktop 身份退出，并逐一检查 Host、coordinator、backend 和日志里出现的 Host plugin PID。活动、复用或无法检查的 PID 均拒绝恢复；已报告插件清理失败、记录截断/错配仍拒绝。

本轮记录的九个旧 PID 均已退出。新日志写入 `previous_lifecycle_closed=false`、`previous_cleanup=not_recorded` 和检查过的 PID 列表。恢复没有读取认证字节、复制账号、抹除历史、修改旧日志或操作日常进程。新包运行时只新增自己的版本缓存。

## 原生任务实机证据

1. 通过原生输入框和发送按钮新建独立验收任务 `01a08e51-2001-71a1-98b9-f96d98359e9e`，未调用最小参数预热或 SDK 创建任务。
2. 回合 `01a08e51-222a-70c2-9f6a-571ae1cd4873` 完成，Native UI 显示 `CODLET_NATIVE_CREATE_OK`；SDK 读到对应 user/assistant item ID。
3. 回到原生新对话页，正常关闭 Desktop/Host/后端后重新启动。新 Native manager 中该任务 `loaded=false`。
4. 点击原生侧边栏任务条目，状态变为 `resumed` / `owner`；同一任务、回合和两条消息的 ID 与内容保持不变。

实机证据文件为 `native-create.json`、`cold-resume-before.json`、`cold-resume-after.json`。过程中曾出现模型连接重试，最后回合完成；任务创建/恢复的配置错误没有复现。原有 M3/M4 用户验收历史保留。

最终测试客户端 SHA-256 为 `8B995FC5FA6FDE5156E87FB4E09FA39386E6E1C3CEF3997B60870AAEDB2C4A4E`；Host `63416`、Desktop `3192`、独立后端 `54364`，启动记录 `1789095924176-64976`。六个原插件保持启用，临时探针已停用并移除；最终 doctor 为 passed、无 failedChecks，Adapter 在主窗口实测 available。原验收任务已由原生界面恢复，面板草稿、关闭状态和拦截开关按原记录恢复。

## 审批补验

当前实际权限请求包含 `fileSystem.entries` 的普通 `path` 项和 `environmentId=local`。本轮按当前 CLI 生成的 schema 补齐映射，兼容仅 entries、仅旧 read/write 和两者并存；DTO 去重展示全部请求路径，批准时仍回复原请求的完整权限快照，scope 为 turn。

glob、special、deny 项、未知结构和非 local 环境不能经本版 SDK 批准，仍可以拒绝或交给原生审批 UI。一次原生权限审批后已观察到 apply_patch 成功写入单个验收文件；该次并非本代理发送 SDK 回复，不计作 SDK 批准往返。

| 实机分支 | 结果 | 证据文件 |
| --- | --- | --- |
| SDK 权限批准 | `submitted` 后收到 `approval.resolved`，回合完成；实际文件内容为 `CODLET_SDK_PERMISSION_OK` 加换行 | `permissions-approved.json` |
| SDK 权限拒绝 | `submitted` 后收到 `approval.resolved`，模型停止且未创建文件 | `permissions-declined.json` |
| 重复 token | 上述两个分支再次提交同一 token 均被拒绝，没有第二次 Native 回复 | 同上 |
| 独立 fileChange 审批 | 未验收。直接 apply_patch 被当前只读策略立即拒绝，未产生 `item/fileChange/requestApproval`；不能将权限审批后成功写文件算作该分支通过 | `file-change-policy-blocked.json` |

已批准和拒绝的回合分别为 `01a08e61-c54c-7cf1-b86b-e0e35ac0e395`、`01a08e65-68e8-7133-8132-a4ad08dca719`。探针批准前核对唯一写入路径为本实验 temp 目录、无网络/附加读取、普通本地路径；批准回复使用现有 Desktop manager/request client。旧式独立 fileChange 批准/拒绝仍需单独的实机条件与证据。

## 检查与边界

- 28 项实验启动器 Rust 回归通过，覆盖正常恢复、中断拒绝、活动 owner、精确包/架构、目录租约及配置检查。
- 46 项 Adapter、bootstrap 与 idle Node 回归通过；新增 live export 延迟、构建替换、公开状态字段和权限 entries 用例。
- Clippy 全 target/feature、格式、Node 语法、diff 检查及 locked release 构建通过。分发包 7 组检查通过，涵盖显式文件清单、哈希、文档链接和只读 CLI 候选检查。
- 当前公开写接口仍限定已经加载的 local owner 任务；没有增加 SDK 创建/打开任务或任意历史改写能力。
- P0 源码盘点、最小内部接口草案和平台矩阵已记录于 `docs/PLATFORM_P0_AUDIT_2026-09-11.md`；其他 OS/架构仍未宣布运行支持。
- 本轮不重跑全部 M0/M1，不把实验资料恢复或 Windows 结果算作发布门禁与跨平台通过。
