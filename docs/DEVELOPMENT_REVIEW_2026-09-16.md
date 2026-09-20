# 开发试用、架构 review 与平台适配

当前保持开发试用阶段，图标设计与打包发布延后。允许调整内部结构和接口，以现有已实现功能继续可用为验收标准。

接续的全面复审、架构决策与 Mac 前端源码依据见 [架构复审与 macOS 功能接续](ARCHITECTURE_REVIEW_2026-09-16.md)。本页后部保留每轮验证和部署记录。

## 执行顺序

1. 完成易读安装目录、移除历史版本界面、更新成功删除旧包，验证失败与中断恢复
2. 对现有 Core、插件协议、管理 GUI、更新、权限、生命周期、运行时 skill、诊断和启动流程做完整 review，记录并处理实际问题
3. 根据 review 结果分离平台代码，再适配官方桌面客户端的平台和架构

## 本轮平台范围

2026-09-16 核实官方页面后，本轮支持目标为 Windows x64、Windows ARM64、macOS Apple Silicon（ARM64）。用户明确暂缓 Linux。macOS Intel 未列入本轮已确认官方范围。

- Windows x64 / ARM64：[官方部署说明](https://learn.chatgpt.com/docs/enterprise/windows-deployment)
- macOS Apple Silicon：[官方桌面页](https://learn.chatgpt.com/docs/app)
- Linux 官方已提供 x64 / ARM64 预览，但本轮暂不适配：[官方 Linux 说明](https://learn.chatgpt.com/docs/linux/linux-app)

不同平台须分别记录代码检查、构建、模拟协议测试和真实客户端验收的结果；构建通过不能替代真实客户端兼容性验证。

## 已确认的 Dev 启动问题

2026-09-16 的中断源于通过 FastCtx 后台作业启动持久客户端：作业结束后其普通子进程被回收，AppX 窗口残留，状态记录停在 ready。独立的短时子进程探针验证了这一行为；通过统一执行工具启动的子进程能在前台命令退出后持续运行。

已使用现有 `Start-TestClient.ps1 -RecoverInterrupted` 恢复同一实验环境；Core、管理器、独立后端、Desktop 持续存活，`skills/list` 正常返回唯一 codlet。启动器已补充底层错误和恢复命令提示。此类持久客户端启动不使用会在命令结束时清理子进程的作业包装。

## 当前修改进度

目录与安装事务已部署到 Dev 并完成实际迁移。Skill 使用 `runtime-skills/codlet`，GitHub 安装包使用 `packages/github/<插件ID>`。更新过程保留短期事务恢复信息，确认安装成功后删除旧包；详情页不再展示已安装历史和回退入口。旧版记录保留读取兼容性，Core 在加载插件前迁移现有目录。

实际测试插件保留 1.1.0，删除 4 个旧包目录，启用状态、权限范围及用户设置保持一致。Windows 删除目录改用支持保留观察句柄的方式，并保留原有路径固定、目录替换防护和旧文件系统回退。清理延迟不再阻塞 Core 启动。构建 B9FB2BB756BD9D7DEAD1A7799BCE0091E067921055A196E35B5767798DAB52BE，运行记录 `1789493138423-28912`。

## 本轮 review 结论与修复

| 发现 | 处理 |
| --- | --- |
| 存储迁移误把文件整理当作插件激活，撤权插件可能阻塞启动 | 分离注册信息迁移和执行入口校验；保留已撤权限与禁用状态 |
| 目标 ID 目录被占用时，迁移可能先保存禁用的暂存注册 | 文件事务提交前不保存迁移中的临时状态；单个迁移冲突记录错误，其余 Core 继续启动 |
| 在线更新先保存新注册，文件替换日志稍后才创建，期间崩溃缺少旧状态 | 保存注册前持久化 `.pending` 恢复记录，文件日志接管后再移除；并发撤权不会被恢复覆盖 |
| 已提交清理记录的旧 history 路径可能与永久 ID 目录重合 | 清理始终排除事务的永久目标目录，仍检查当前注册引用和 Core 来源凭据 |
| CDP 清理测试使用全局线程计数，混入并行 VM 测试的线程 | 改为只统计本测试创建的客户端，保留真实回收断言 |
| 平台判断只看 CPU、Node ARM64 许可证摘要缺失 | 以 OS + CPU 选择目标，补齐官方归档、二进制与许可证摘要 |
| macOS 不能沿用 Windows 的线程取消、named pipe、Job 和文件租约 | 增加独立系统实现，共用 Host 调度、权限、控制协议与回执校验；移除 Mac 对占位成功分支的依赖 |
| CLI 与响应验证嵌在 Windows 启动模块，文档保留旧浮窗/历史版本描述 | 拆出共享插件命令与响应验证，更新 README、当前架构决策和平台验收说明 |
| Mac 的 Core 和插件回收进程共用终端进程组，Ctrl+C 可能一起结束回收进程 | 回收进程单独建组；Core 信号走正常停止流程，新增 Core 崩溃和终端组中断的原生回归用例 |
| Mac 启动后身份/CDP/插件初始化失败时，Rust Child 的 Drop 不会终止客户端 | 引入直接子进程所有者，覆盖启动阶段所有错误返回；正常退出先使用固定的官方 quit-app 桥接，再限时回收所持有的子进程 |

系统实现通过 `platform` 边界接入。macOS 的进程组回收与 Windows Job 有明确差异，Mac 自身的更新安装交接、签名与分发仍待后续阶段；详见 [macOS 开发与验收](MACOS_DEVELOPMENT_2026-09-16.md)。不把这些平台限制隐藏在成功状态中。

## 回归与 Dev 状态

- Windows 全量 Rust：580 通过、0 失败；1 个会启动日常官方客户端的外部门禁按既有标记忽略
- 更新事务最终补验：16 通过，覆盖暂存后崩溃、目录替换中断、失败恢复、已撤权迁移和随后撤权保留
- JavaScript / 前端：192 通过；Node 22 的 Host / capability / skill 桥接：15 通过
- Windows 严格 Clippy、类型检查、构建和差异格式检查通过
- Windows ARM64 使用 `aarch64-pc-windows-gnullvm`、macOS 使用 `aarch64-apple-darwin`；完整库、程序和测试的交叉检查及严格 Clippy 均通过。均不是目标设备运行记录
- 历史版本界面移除后的浅色/深色实图已在存储迁移验收中核对；本轮未改变管理页布局。Mac 视觉验收尚未进行

Dev 已更新为 `28BD9EE97756D9FE637A940A084EBAC656595DF73784289E7A0D270A9FD3BA39`。本次启动 `1789504550297-32412`，正常模式 ready；管理器 32412、Core 35436、后端 53816、Desktop 568，Desktop birth `134339781609298600`。配置验证通过，日常客户端 57000 / `134339531293020300` 未变。

实际 GitHub 测试插件仍位于 `packages/github/dev.example.github-release-check`，只有这一份安装；运行时技能目录只有 `runtime-skills/codlet/SKILL.md`。后端重新读取到 37 个技能、唯一 codlet、无错误。验证汇总保存于 `.codlet-artifacts/review-2026-09-16/verification.json`，skill 实测保存于 `.codlet-artifacts/runtime-skill-2026-09-15/live-skill-platform-review.json`。

运行时 skill 附带的 CLI 包装脚本已实际执行 `plugin list --json`，8 个插件的验证错误均为空；包装脚本正确选择当前实验 registry，未带对应环境的直接 CLI 调用被作用域检查拒绝。退出启动命令后，管理器、Core、后端和 Desktop 仍持续运行。

下一步是用户继续 Windows 试用，以及在真实 ARM64 Windows / Mac 执行平台验收。没有创建发行包、发布源码或设计最终图标；`DEFECT-001`、`DEFECT-002` 与正式安装/签名门禁继续保留。

后续 Mac 开发补充：加入 `scripts/test-macos.sh`，通过现有测试二进制验证真实 Mac Host/进程组实现，不依赖官方客户端或用户注册表。构建脚本固定 Cargo.lock 并读取实际 Cargo 输出目录。本次 Mac 退出修复与测试通过 ARM64 严格 Clippy；Windows 的 5 个 `plugin_host` 进程回归测试再次通过，脚本语法和差异格式检查通过。Mac 原生运行结果仍待实机验收，不计入上面的 Windows 测试通过数，也不改变当前 Dev 的已部署版本。

## 架构复审接续的验证与部署

- Windows 严格 Clippy 与完整 Rust 回归：583 通过、0 失败；保留原有 1 项外部客户端门禁忽略
- 全量 JavaScript：196 通过、0 失败；Node 22 单独运行更新后的 skill 桥接用例，4 项通过
- macOS ARM64、Windows ARM64 GNU LLVM 的完整库、程序和测试严格 Clippy 均通过；前端构建、类型检查、差异格式检查通过
- Dev Core / 内置 UI 更新为 `8FDAB009BAE92733FA652E2BB37E5A603272BD3FB69BE60158B53B5FE4698778`
- 新运行 `1789508637825-50500`；管理器 50500、Core 39600、后端 11780、Desktop 52720，Desktop birth `134339822496139178`，正常模式 ready
- 启动命令退出后再次确认进程存活；原有日常客户端 57000 / `134339531293020300` 仍为同一实例
- registry 和 preferences 与部署前备份摘要一致；8 个插件的注册验证错误均为空，6 个启用的 renderer 激活成功，Host 示例 active
- 原生后端读取 37 个 skill，唯一 codlet 位于固定目录，无错误；未将本轮登记为 GUI 视觉验收

Dev 中 `codex.desktop.adapter` 仍使用用户现有的本地注册来源（原工作目录），未更换该来源。当前工作树生成的新 Desktop adapter 已经过四个构建 profile 的 JS 回归；此次原生 Dev 更新验证覆盖 Core、内置 UI 和 runtime skill，新 Desktop adapter 的本地来源替换与 Mac 实机使用分别保留为后续验收。

汇总证据：`.codlet-artifacts/review-2026-09-16/round2-verification.json`；全量日志：`round2-rust.log`、`round2-js.log`；skill 实测：`.codlet-artifacts/runtime-skill-2026-09-15/live-skill-architecture-review-2.json`。备份位于 `.codlet-artifacts/version-source-2026-09-15/architecture-review-2-backup`。
