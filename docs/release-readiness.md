# Codlet 0.2.0 首次正式发布准备

**结论：0.2.0 尚未发布。清理、代码修复和本机自动化验收不等于已经完全满足最初设计；下面的发布门禁必须完成或形成明确的产品范围决定。**

本轮检查日期为 2026-10-05（Asia/Shanghai），覆盖 Core 和官方插件两个仓库。基线分别为 `b381460`、`60bb8e9`。最初方案和研究依据可从 `9f2eccb^:docs/PRODUCT_TECHNICAL_PLAN.md`、`9f2eccb^:docs/RESEARCH_BASELINE.md` 读取；当前契约以 `docs/spec/` 为准。旧设计文档不重新复制到工作目录。

## 已完成的清理和修复

- 删除 22 条本地历史分支、3 条远端历史分支、6 个 Core Preview 标签和 6 个 Preview 发布（含草稿）。两个仓库各保留 `main` 和一个主工作树。清理前的提交保存在各自 `.git/pre-release-cleanup.bundle`；没有重写主分支历史。
- 保留 `node-runtimes` 依赖发布：安装器的固定 Node 下载地址仍引用其资产，它不是 Codlet 的安装版本。
- 删除旧实验客户端、历次 Preview 打包目录、过期发布说明、两个转发包装脚本和已被生产 GUI 取代的独立市场原型。清空旧 Cargo 输出时报告删除 91.5 GiB；当前测试只使用一份重新生成的构建目录。
- 移除 Core 中没有生产调用者的旧 `prepare/attach/beforeResume` 启动执行器、旧授权轮询及其测试。现行 `clientSource` 的不可变快照、授权复查、输出上限和临时进程清理继续有行为测试。
- 修复严格 Rust 检查中的死代码/条件编译和警告；收敛兼容性后台任务参数，避免让后台线程持有自己的生命周期 owner。
- 修复 CLI 测试继承日常 `CODLET_HOME` 的问题。带 `test-fixtures` 的 Windows 构建使用独立的控制、状态及启动 IPC 命名空间；正式构建仍使用原有鉴权端点。原生 Windows turn 测试要求可丢弃主机，避免把文件隔离误当成系统沙箱隔离。
- 修复正式版发布链路：版本为 `0.2.0`、通道为 `stable`，发布计划和 GitHub 元数据使用 `prerelease: false`。安装器显示 Codlet，新安装使用 Codlet 目录，已有安装保留其原位置、UpgradeCode、组件身份及注册信息。
- 修复 MSI 版本回退：正式 `0.2.0` 映射为 MSI `0.2.1000`，高于 Preview 29 的 `0.2.29`；后续 patch 递增。已知内置 Preview 更新配置迁移到 stable，自定义来源保持原配置。
- 升级 lodash、PostCSS、selector parser、reqwest/Hickory 和 rustls；统一 HTTP 客户端初始化，显式安装已有 ring 加密实现，并由业务层决定重试。保留异步 DNS、系统证书校验及明确授权的附加 CA。依赖声明和实际三方许可同步更新。
- 将已有 SDK 类型示例接入固定版本 TypeScript 和 CI；稳定版发布计划校验也进入 CI。
- 跨平台 CI 暴露并修复了两个问题：reqwest 升级后显式保持 WebPKI 对系统根证书与附加 CA 的校验语义；客户端模块观察器同时识别应用目录及其真实路径，避免 macOS `/var` 别名或 Windows junction 使启动 source 无法激活。目录别名回归已先复现失败，再验证修复及相邻目录排除。
- Mac 分发流水线中的官方 CUA Node 验收脚本也已从旧 `prepare` 阶段迁移到 `clientSource`；子进程失败直接报告退出结果，不再表现成无响应超时。
- Mac 完整检查发现并修复了启动 source 缺少就绪确认的问题：在 CDP reader 已启动后完成握手，再决定是否暂停不受支持的插件。删除无调用者的旧 Mac 启动错误转换函数；打包 fixtures 使用物理临时目录，并加入日常 macOS CI。

## 按最初设计核对

| 设计要求 | 当前实现与证据 | 结论 |
| --- | --- | --- |
| 用户主动启动；无预驻服务；不修改或分发官方应用 | 独立启动器、进程/pipe 所有权、安装载荷清单和安全模式测试 | 核心路径已实现；最终设备验收见 G1 |
| Core 不承担客户端 DOM、React、会话业务，第一方插件无专用权限后门 | Core/插件独立仓库，公共 capability、RPC、注册及授权事务；运行时 skill 是已确认的独立集成例外 | 保持既定边界 |
| Host/renderer/组合插件、代际隔离、取消、撤权、热更新与失败回滚 | Rust/Node 生命周期、真实受控子进程和多窗口 VM fixtures | 自动化覆盖；实际客户端组合需 G1 |
| GUI 可禁用，CLI 和运行时 skill 可恢复；完整 DOM/React 能力 | 管理、依赖、权限、菜单、页面、主题、语言与清理测试；生产 GUI 浏览器预览 | 已实现；不将浏览器预览视为原生客户端验收 |
| 同一 Desktop 连接的任务读写、事件、审批和提交拦截 | Desktop Adapter 测试及历史精确客户端验收记录 | 有实现和历史证据；新启动桥接组合仍需 G1 |
| 本地/GitHub 导入、明确授信、更新、来源校验、诊断 | Core 注册/归档/事务测试，GUI 审核流程和发布包校验 | 自动化覆盖 |
| 原生流量能力及 HTTP/SSE/WebSocket | 原生受控网络 fixtures、权限/取消/背压/信任边界测试 | 支持已声明路径；未覆盖网络见 G6 |
| 官方入口总能打开纯净实例 | 扩展实例在运行时，官方入口仍可能复用该主实例 | **未满足，DEFECT-001，见 G3** |
| Core 与其客户端同寿命，包括 Core 异常终止 | pipe EOF 只保证请求协作退出，不能保证客户端必然退出 | **未满足，DEFECT-002，见 G3** |
| 安装不关闭现有 Codex；卸载可明确选择是否保留数据 | 现有安装器提供正常关闭流程；卸载固定保留用户数据 | **与初稿有差异，见 G4/G7** |
| 跟随官方客户端的目标平台 | Windows x64 为主要验证目标；ARM64/Mac 有实现但缺少本次完整设备验收 | 见 G2 |

## 发布门禁和待办

| ID | 优先级 | 需要完成的工作 | 完成标准 |
| --- | --- | --- | --- |
| G1 | P0 | 在可丢弃 Windows VM/主机上用最终 0.2.0 安装包和当前签名 Codex 做完整验收 | 首次安装、从 Preview 升级、修复、卸载、PATH/快捷方式/安装范围；首次启动、两种流量 source、skill、GUI/CLI 导入/启停/撤权/重载/更新/回滚、安全模式、冷启动与多窗口；正常退出无遗留拥有者。记录准确包版本、源码提交、日志和通过项 |
| G2 | P0（若首发包含该平台） | 明确首发平台；补 macOS Apple Silicon、Windows ARM64 真机验收 | 对选入发布的每个平台执行安装和完整 Desktop 功能测试；否则发行清单和宣传明确仅 Windows x64。本机不能代替 Mac/ARM64 设备 |
| G3 | P1 / 原始契约 | 处理官方入口复用实例及 Core 崩溃后客户端残留 | 修复并复测 DEFECT-001/002，或明确将其从 0.2.0 保证中排除；不得继续宣称完全实现最初的独立纯净入口和崩溃同寿命保证 |
| G4 | P1 / 产品决定 | 确认安装/启动器的“请求已有客户端正常关闭”行为 | 若严格遵循初稿，改为仅提示用户自行关闭；若接受现行为，更新正式产品约定并验收取消、不强制终止、不自动重启 |
| G5 | P1 / 分发 | 决定并完成 Windows 签名及 Mac Developer ID/notarization | 校验最终安装包签名和安装体验；当前构建工具产生的未签名/ad-hoc 产物不能标为已签名或已公证 |
| G6 | P1 / 功能验收 | 补真实账户 OAuth 刷新、实际 provider、远端/cloud、附件、浏览器网络和 Realtime 的覆盖证据 | 按网络路径逐项声明支持；未实现/未验收的路径明确不可据此声称“全部流量透明拦截” |
| G7 | P2 / 功能缺口 | 卸载界面缺少是否清理 Codlet 数据的明确选择 | 如保留初稿目标，实现带清晰范围的可选数据清理；当前固定保留数据的行为继续如实说明 |
| G8 | P2 / 生命周期 | 热重载的 Chromium world 累积及 loaded-thread provider 自动恢复 | 长时间/高频重载提供明确边界；新增恢复协议前，插件必须先恢复原 provider 再关闭 route，不能把关闭通道当成恢复成功 |
| G9 | P2 / 维护性 | 持续拆分大型协调模块，保持回归覆盖 | 后续按职责拆分 renderer、lab、Host 与管理协调代码；每次独立变更验证 ABI、事务与生命周期，不为本次清理一次性重写所有模块 |

G1/G2 的完整 Windows 原生 turn 验收不能在共享日常主机上补跑：官方沙箱初始化可能修改系统用户和防火墙。当前环境没有可用的可丢弃 Windows VM，也不是 Mac/ARM64 设备。工具检查和浏览器预览均不能关闭这些门禁。

## 验证记录

本机使用 Rust 1.97.1（Windows GNU）、固定 Node 24.21.0。清空旧构建目录后重新构建；测试构建关闭调试符号和增量缓存以控制磁盘占用，保留 debug assertions 和测试功能。正式构建使用 `--release --bin codlet --no-default-features`。

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `cargo fmt`、全目标/全功能 `clippy -D warnings` | 通过 | 包括平台条件编译可在 Windows 上检查的部分 |
| `cargo test --locked --all-targets --all-features -- --test-threads=2` | **754 通过，7 ignored** | 包括受控进程、IPC、权限、RPC、生命周期、网络及更新事务；ignored 不算通过 |
| Core Node 全套 | **212 通过，0 跳过** | 包括真实 Core 原生 HTTP/SSE/WS/WSS fixtures 和目录别名回归 |
| 官方插件 Node 全套，配置匹配的 `CODLET_CORE_ROOT` | **256 通过，2 跳过** | 两个真实 AppServer turn 测试需可丢弃 Windows 主机；受控 Node 冷启动/Host ABI 已运行 |
| TypeScript SDK 检查 | 通过 | 固定 TypeScript 7.0.2，检查现有声明与使用示例 |
| npm 审计 | 两个仓库均 0 项 | 当前锁文件已知漏洞记录 |
| Rust 锁文件 OSV/RustSec 查询 | 234 个 registry 包，0 命中 | `cargo-audit` 安装遇到 registry 网络超时，改为数据库批量查询；不是 cargo-audit 的结果 |
| 原生安装器、启动器、进程隔离、M0/M0 crash 脚本测试 | 通过 | 原生 UI/受控假客户端；没有在日常 Codex 上做崩溃或安装实验 |
| 稳定版发布计划测试 | 通过 | 合成包、摘要、篡改拒绝、精确提交标签和模拟 draft/publish；无 GitHub 写入 |
| 真实候选 MSI、安装器和更新 ZIP | 构建及结构校验通过 | MSI 产品版本为 `0.2.1000`；未安装到当前日常系统 |
| 候选 ZIP 更新及失败回滚 | opt-in 验收通过 | 实际解包、替换、重启成功和回滚路径；使用独立临时目录与受控假客户端 |
| macOS 打包规则 | 5 项通过 | 离线 Python 载荷检查，没有执行 Mac 二进制 |
| 真实固定 Node 镜像下载及缓存复用 | 补跑通过 | 校验实际公开镜像和可复用私有缓存 |
| 指定旧官方 CUA Node 复用验收 | 环境前提未满足 | 该 opt-in 测试要求 `26.917.6896.0`，本机已是 `26.930.3930.0`，无法取得其精确旧源；不能记为通过。当前固定下载路径已验收 |

本轮 Windows 候选材料使用 `.codlet-artifacts/release-0.2.0/`，其中 `evidence/` 保留最终日志和截图，`release/` 保留发布计划、安装包和摘要。目录不提交到 Git；具体源码身份以 `release-plan.json` 和构建清单为准。

已完成的浏览器预览检查：插件搜索及清除、市场入口、详情、更新审核在未勾选授信时禁用、勾选后可提交、返回导航、中文/英文、浅/深色、设置失败后的禁用与重新读取恢复、720px 窄窗无横向溢出。控制台无错误。该预览全部使用模拟管理数据。

只读日常实例检查使用其自己的 CLI：Core Preview 29、Codex `26.930.3930.0`，Desktop Adapter `0.2.13`、UI Adapter `0.1.10`、GUI `0.1.9` 均已确认激活。这是既有安装的状态证据，不是候选 0.2.0 的通过记录。

依赖安全问题来源：[Hickory 编码复杂度](https://rustsec.org/advisories/RUSTSEC-2026-0119.html)、[Hickory DNSSEC](https://rustsec.org/advisories/RUSTSEC-2026-0118.html)、[rustls TLS 边界](https://rustsec.org/advisories/RUSTSEC-2026-0285.html)。修复后的锁文件通过 OSV/RustSec 查询；这是已知漏洞数据库检查，不是所有依赖的安全证明。

发布时只使用 `Publish-Release.ps1` 生成并复核的不可变计划。应先完成上述门禁，再创建/检查 GitHub 草稿和发布；本轮不会直接执行正式发布。
