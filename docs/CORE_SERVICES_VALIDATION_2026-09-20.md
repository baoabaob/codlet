# Core 通用服务实施与验收记录

本轮补齐八组通用服务的首版实现：持久存储、系统凭据、文件操作与选择、事件、后台任务、流式子进程、网络配置、桌面集成。Host 和 renderer 共用 Core 内的服务实例，通过 `context.services` 使用；GUI、CLI 权限展示和运行时 Codlet skill 的参考资料已经同步。实际 API 与边界见 [Core services](CORE_SERVICES.md)，后续扩展建议另列在 [实施计划](CORE_SERVICES_IMPLEMENTATION_2026-09-20.md)。

## 已确认的行为

- 本机 Windows 的 Rust 全目标测试通过；新增存储并发、凭据、授权、文件替换、任务取消、进程字节流与清理等定向测试通过
- 双窗口、无 Host 入口的 renderer 测试验证共享 CAS 存储、文件创建与替换、事件传递和越权拒绝
- 本机 Windows Credential Manager 测试实际写入、读取使用并移除独立的测试凭据
- 本地 HTTPS/WSS 上游及代理测试验证转发、CA、认证隔离和取消；未关闭证书或主机名校验
- 本机官方 AppServer 的两项 opt-in 回环验收均通过：Adapter 选择的 HTTP 与 WebSocket 通道实际完成生成，并在后台冷重启后恢复会话。使用独立 home/SQLite 目录、文件凭据模式及本地模拟响应，不使用日常会话数据库或实际模型服务
- SDK 测试验证真实 callback runner、进度、合作取消、文档结束、无效或超大结果；远端完成回执未知时不自动重放
- 隔离 dev 内临时插件实际完成存储事务、事件传递、后台 callback 与结果读取，随后通过 CLI 移除测试注册
- dev 主窗口显示 Codlet、UI controls、M3 / M4 入口，运行时 skill 状态为 `ready`；辅助头像窗口不挂载插件页面

本机完整 Node 测试在此前版本通过 256 项；冷启动修复新增三项回归，相关 UI、i18n 和 skill 的 67 项测试全部通过。最终代码通过 Windows clippy（全目标、全部特性、警告视为错误）。测试日志和屏幕截图在被 Git 忽略的 `.codlet-artifacts/core-services` 内，不上传测试用户数据。

## 验收发现并修复的问题

- 官方客户端冷启动超过原 12 秒时，UI adapter 会永久放弃初始化。改为先接受有界、按插件归属的页面 lease，官方路由就绪后挂载；等待期间不占用长 RPC，插件停用或文档退休会取消等待
- Windows 临时目录的 8.3 路径和规范路径混用，导致 runtime skill 目录 pin 或测试文件授权不匹配；规范化父目录和测试根目录后仍保留原有路径边界
- Windows PowerShell 继承 PowerShell 7 的模块路径时，`Get-FileHash` 自动加载可能失败；包构建脚本改用 .NET SHA-256
- ZIP 生成器以短路径根长度截取长路径文件名，可能生成错误条目；改为遍历时逐段维护相对条目名
- Windows overlapped 管道在超时与完成竞态下可能丢弃已消费的字节；取消后先读取实际完成结果，仅在操作确实取消时返回超时
- macOS 保持 leader 未 reap 以固定 PID/PGID；先确认组内活动成员再发送终止信号，对退出竞态重新核查，不把 zombie-only group 的信号错误误报为活动进程清理失败
- 旧生命周期 fixture 把转发超时和完整双窗口补偿压在 300～500 毫秒内，在 CI 慢机上误报。扩大测试自身预算，以目标端退休时刻和请求 trace 检测错误的期限重置，保留补偿结果断言并补充耗时/回执诊断；生产期限未修改。完整 46 项集成测试在双线程与四线程下均通过
- 更新辅助程序测试曾把系统临时目录的 8.3 别名直接写入计划，被生产路径身份校验拒绝。在本机显式短路径环境复现同样的 11 项失败后，仅规范化测试根目录与清理边界；正常目录与 8.3 目录下的 12 项测试均通过，生产链接/篡改防护未放宽
- Windows Job 活动计数归零时，外部保留的后代进程句柄仍可能尚未 signaled。清理完成现在同时要求根进程退出、计数归零及私有 IOCP 的 `ACTIVE_PROCESS_ZERO` 通知；每次轮询有界清理通知，缺少确认则返回 `cleanup_incomplete`。后代清理回归重复 20 次、完整 Host、进程流和撤权回归均通过。实现参照[微软关于等待整个 Job 退出的说明](https://devblogs.microsoft.com/oldnewthing/20130405-00/?p=4743)
- PowerShell 7 的 `Add-Type` 不支持生成控制台 EXE，导致旧启动测试在构造原生 argv 夹具时失败。改用 Windows 自带 .NET Framework C# 编译器生成夹具，实际验收脚本仍在被测 PowerShell 中运行；Windows PowerShell 5.1 与 PowerShell 7 的完整启动测试均通过

## 平台和发布范围

私有仓库为 `baoabaob/codlet`，CI 分别运行 Windows 和 Apple silicon macOS。提交 `54e36a9` 的 macOS CI 全部通过：全目标编译、12 项存储/凭据测试、6 项事件/任务测试、1 项未 reap 子进程回归及 6 项原生生命周期/字节流测试。真实 Mac 上的官方客户端页面、文件选择器、Keychain 提示、剪贴板、通知和全局快捷键交互仍需人工验收；模拟凭据后端测试不等于原生 Keychain 交互验收。

Windows 原生、JavaScript/界面、启动脚本作为独立 CI job 并行运行。启动和异常退出脚本分别覆盖 Windows PowerShell 与 PowerShell 7，前一组测试失败不会阻断另一组结果的收集。

2026-09-21（北京时间），提交 `91462e7` 的[完整 CI](https://github.com/baoabaob/codlet/actions/runs/35521716990) 全部通过：Windows Core、Windows UI、Windows launch scripts 和 macOS 四组均为 success。JavaScript 共 260 项，其中 258 项通过；另 2 项因 CI 未安装官方 CLI 而跳过，已在本机使用官方 CLI 补验通过。

CI 完成后的收尾只更新此记录和 opt-in 原生测试的隔离设置，应用实现与 CI 验收版本相同。测试显式设置独立 SQLite 目录和文件凭据模式，并再次通过 HTTP/WebSocket 两项真实 AppServer 测试；预先设置的外部 SQLite 路径未被创建。该收尾提交使用 `[skip ci]`，不重复运行未变更的全套检查。

本轮不制作安装包、不创建 release、不适配 Linux。文件写入采用有界原子替换，任务记录不跨 Core 重启恢复，基础系统通知尚不提供自定义操作按钮；这些限制均在公开契约中说明。
