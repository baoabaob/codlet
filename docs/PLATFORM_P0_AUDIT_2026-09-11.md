# 跨操作系统 P0 依赖盘点

日期：2026-09-11。状态：完成源码盘点、最小接口草案和验收矩阵；平台接口尚未抽取，非 Windows 运行支持尚未实现。

此页保留 9 月 11 日的盘点基线。最新官方平台范围和当前实现状态以 [平台支持矩阵](PLATFORM_SUPPORT.md) 为准；已实施的接口抽取与 Mac 工作见 [架构复审](ARCHITECTURE_REVIEW_2026-09-16.md)。

本记录落实[下一阶段计划](NEXT_DEVELOPMENT_PLAN_2026-09-11.md#p0--p1跨操作系统适配)的第一项 P0 工作。继续复用现有 manifest、权限、capability、generation、receipt 和生命周期协议；后续导入与管理功能按这些边界开发。

## 当前耦合位置

| 范围 | 现有源码 | 实际约束与抽取要求 |
| --- | --- | --- |
| 程序入口与编排 | `src/main.rs`、`src/lib.rs`、`src/probe.rs` | 非 Windows 主程序直接退出；Host runtime、JS runtime、OS broker、CLI、doctor 和实验启动器均位于 Windows 条件编译后。先把编排和系统资源实现分开，再开放平台入口。 |
| 官方 Desktop 发现与启动 | `src/windows/packages.rs`、`process.rs`、`environment.rs` | 依赖当前用户 AppX 包发现、Windows 命令行转义、环境块、继承句柄白名单和进程创建时间。新平台需要独立的安装身份与启动证据。 |
| CDP 传输与取消 | `src/windows/pipes.rs`、`src/cdp/client.rs` | CDP 协议处理可复用；启动管道、阻塞 I/O 取消和 worker 回收需要平台实现。当前非 Windows `ThreadCancelHandle::cancel` 是空实现，不能作为清理已通过的证据。 |
| 本地 IPC 与身份 | `src/windows/local_ipc.rs`、`control_pipe.rs`、`status_pipe.rs`、`control_scope.rs` | named pipe、用户安全描述符、对端进程身份、注册表作用域和实例 nonce 一起构成当前信任检查。换传输不能只换一个地址字符串。 |
| Host 与子进程生命周期 | `src/windows/plugin_process.rs`、`src/plugin_host/supervisor.rs`、`src/os_broker` | 插件先挂入不继承的 kill-on-close Job，再恢复执行；Host 退出时回收其后代。其他平台必须给出自己的进程资源保证与崩溃证据。 |
| 文件与目录身份 | `src/local_plugins.rs`、`src/plugins.rs`、`src/windows/launch_mutex.rs` | 路径规范、reparse point、硬链接、禁止写入/删除共享的打开句柄、原子替换和作用域互斥均需核验。通用解析已有部分非 Windows 分支，但不等于全部文件竞态条件已解决。 |
| Host/Renderer RPC 集成 | `src/renderer/host_rpc.rs`、`src/host_runtime` | 若干非 Windows 分支当前只消耗参数或返回成功，不发布实际 Host endpoint。开放平台支持前必须替换为可执行实现，或明确返回不可用。 |
| 受管 Node | `src/js_runtime.rs`、`runtime/node-runtime.json`、`scripts/Install-JsRuntime.ps1` | 固定 Windows 目录与 `node.exe`，二进制哈希使用 Windows BCrypt，打开句柄保护运行文件；不能改为搜索 PATH。x64/arm64 pin 已存在，实际发布验收需分别补齐。 |
| 安装与分发 | `scripts/Build-Distribution.ps1`、`Build-IsolatedClient.ps1`、`Test-Distribution.ps1` | PowerShell 流程、可执行文件名、许可证、签名和安装目录与平台相关。通用包清单/哈希校验规则保留。 |
| Desktop 私有适配 | `bundled/codex-desktop-adapter`、`bundled/codex-ui-adapter` | 按 OS/架构/官方构建登记探针结果。版本字符串相同也不能代替实际页面、连接与 UI 挂载核验。 |
| 实验客户端 | `src/lab`、`scripts/isolated-client.mjs` | 当前仅验证 Windows Dev/专用 WS 策略；正常关闭恢复与显式中断恢复都依赖 Windows 文件/进程证据。保持实验入口独立。 |

本次还发现一个具体兼容性教训：测试启动器添加的严格配置模式会拒绝官方前端的前向兼容字段；专用 WS 后端也必须带上官方用于不可用 app-tools 的禁用配置。平台移植应复现并读取实际生效的启动配置，不能仅依赖目录分离或 CLI 版本号。

## 最小接口草案

以下是内部职责约定，名称尚未成为公开 Rust/JS API。优先在下一次相关实现变更时提取一个边界并保留 Windows 回归证据，不一次性改写全部模块。

| 内部边界 | 输入 / 输出 | 必须保留的语义 |
| --- | --- | --- |
| Desktop 安装与启动 | 已审核的安装身份、参数、环境、工作目录 → owned child + owned CDP transport | 只控制本次创建的进程；验证安装、实例与启动时间；不附着已有日常客户端；启动前后均能拒绝身份变化。 |
| 受管进程资源 | 固定可执行文件、参数与获授权策略 → process owner + stdio + exit receipt | 不仅记录 PID；区分正常退出、超时、强制回收与未知结果；generation 退役须取消调用并关闭资源。 |
| authenticated 本地通道 | 用户/registry scope/instance identity → bounded channel + verified peer | 握手、对端身份和实例复查；限制帧大小、连接/读写期限及取消；身份不明时拒绝操作。 |
| 文件与目录租约 | 来源目录或受管包目录 → 规范化身份 + 快照/租约 | 明确链接与大小写策略、并发修改检查、替换条件；源目录、受管缓存和 pluginData 的所有权分开。 |
| 受管运行时包 | OS/arch/version + 固定清单 → validated runtime handle | 固定产物与哈希；保留许可证；不使用 ambient Node；不因插件声明而执行安装脚本。 |
| 平台诊断 | 上述 owner 与操作结果 → 现有诊断 DTO + 平台证据 | 共用可用/失败/未知语义；平台原始错误用于诊断，不把缺失实现报告为成功。 |

状态机、依赖解析、信任授权和管理 receipt 继续留在共享层。OS handle、Windows FILETIME、SID、named pipe 名称及 Job 细节由平台实现持有；对外传递可核验的身份与结果。

## 支持与证据矩阵

| OS / 架构 | 当前证据 | 进入 P1 前的条件 |
| --- | --- | --- |
| Windows x64 | 有本机、实际 AppX 启动链、Host/Renderer、IPC、Node 和历史验收；本轮审核包 `26.903.9818.0` / 页面 `26.903.71938` build `8576`。 | 完成本轮兼容记录；发布时执行仍未关闭的 M0/M1 门禁。 |
| Windows arm64 | 已有 Node pin 和架构选择分支；没有本轮原生设备与完整 Codlet 验收。 | 核实原生构建链、完整 Node/许可证产物、官方 Desktop 安装与测试设备，执行独立纵切。 |
| macOS arm64 / x64 | 尚无 Codlet 启动、IPC、进程回收、文件租约或分发实现证据。 | 移植启动时核对官方当时可用客户端、安装身份、签名/权限、测试设备；分别登记架构。 |
| Linux x64 / arm64 | 尚无 Codlet 原生运行与分发证据；现有非 Windows 占位分支不足以运行。 | 移植启动时核对官方客户端可用性、安装/桌面环境、测试设备及生命周期方案。 |

macOS/Linux 的官方可用性在本轮未做网络调查；矩阵不声明其当前存在或不存在。P1 的平台先后顺序仍取决于届时的官方发行与可用测试设备。

## 验收条件与下一步

1. 为第一个待移植平台补齐官方安装与测试设备证据，确定 OS/arch/Desktop build 组合。
2. 先提取 Desktop 启动、CDP I/O 取消与进程 owner；Windows 实现保持现有所有权行为。
3. 再接通 authenticated IPC、受管 Node、文件租约、Host/Renderer RPC 与管理命令，移除对应占位成功分支。
4. 在同一台目标设备完成启动 → 本地目录导入 → 授权/启停/重载/撤权 → Desktop 读写 → 正常退出/Host 崩溃 → 资源验证。
5. 分平台执行发布门禁，并保留来源、包哈希、版本、进程身份、管理 receipt 和残留检查；单独编译通过不升级支持状态。

M5 导入器据此预留来源、OS/arch、作者声明与实际验证的分离字段；具体 manifest 增量在 M5a/M5b 实现时确定，当前 strict schema 不提前放宽。GitHub release 与本地目录继续共用现有授权和生命周期，不引入第二套执行内核。
