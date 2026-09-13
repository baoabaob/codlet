# 官方客户端更新流程核对（2026-09-13）

核对对象是本机安装的 `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0`，Electron 应用版本 `26.908.40834`、build `8881`。只读取安装包内代码并格式化供审阅，没有执行提取的模块，也没有触发官方更新。

## 实际链路

- Native 的 `SparkleManager` 是跨平台更新门面。Windows 使用 Store updater；x64/arm64 在 Store 路径明确允许回退时使用 MSIX updater。不能把 macOS Sparkle 的安装机制当作 Windows 实现。
- 默认检查间隔为 15 分钟；Store 检测另有 30 分钟节流。启动时还要经过构建渠道和更新策略判断。测试客户端的隔离配置关闭了 Native 自动更新。
- Windows 的检查会继续下载和暂存。MSIX 路径检查版本、包身份和发布者；适用时校验下载长度、SHA256、架构，再调用 Native `stagePackage`，原子保存 `staged-msix.json`，最后发布 `ready`。Store 路径通过 `trySilentDownloadStoreUpdates` 完成下载后发布 `ready`。
- Native 向界面发布 `lifecycleState`（`idle/checking/downloading/ready/installing`）、`isUpdateReady`、下载百分比和安装百分比。界面不应把“已发现新版本”当作“已下载、可安装”。
- 实际标题栏/侧栏按钮在 `app-primary-17b54400f32a.js` 的 `sLn`：`idle/checking` 不显示；下载和安装期间禁用；只有 `ready` 可点击。`ready` 的图标也是向下箭头加托盘，但点击调用的是安装，而不是开始下载。图标含义必须和状态、提示文字一起理解。
- 安装调用 `appUpdates.installUpdate`。Windows 界面会在存在活跃本地会话时确认中断影响；安装进度窗口屏蔽关闭、Escape 和点击外部退出。它不是前端自行替换应用文件或拼接重启命令。
- Windows 安装准备会保存会话恢复信息、刷新持久状态并停止项目 Git fsmonitor。MSIX 激活前还会等当前应用运行满约 61 秒，调用 `activateStagedPackage`；Store 安装在部署或完成时通知退出。
- 正式 Windows 构建的安装退出分支会执行其自身的清理、窗口销毁和进程退出；其中含 Native 后代进程清理及退出兜底。该行为只适用于官方自身拥有的进程，不能直接移植为 Codlet 任意结束客户端进程的依据。
- MSIX 激活失败时，JavaScript 层重新核对本地暂存状态并恢复 `ready/idle`；它没有实现通用 ZIP 文件备份回滚。底层 Windows 部署是否以及如何回滚，不能仅凭这些 JavaScript 代码断言。
- 暂存状态会在下次启动时恢复。会话恢复记录带账号身份和过期时间，前端在连接就绪后取用；这不等于对任意插件状态作无损恢复保证。

## Codlet 的交互和实现边界

按照本次明确需求，Codlet 保留“发现更新 → 点击下载 → 下载完成后点击安装并重启”。参考官方的状态语义、进度反馈、暂存恢复和失败恢复；主动下载是本次需求指定的交互。

Codlet 采用便携目录而非官方 MSIX 包，更新包、文件替换和同一启动器重启由 Codlet 自己实现。安装交接校验完成后，只正常退出本次启动器拥有的客户端与服务。官方客户端更新在 Codlet 中只作提示，不调用其安装操作。

当前尚未发布 Codlet 更新源。开发态不伪造“已是最新版”或可下载版本。发布源和更新包由开发发布流程配置，不要求终端用户填写地址。

## 代码证据

原始 ASAR 提取文件位于工作区 `.codlet-artifacts/desktop-compatibility-2026-09-13/`。审阅副本在 `.codlet-artifacts/official-update-audit-2026-09-13/`，使用 TypeScript parser/printer 格式化，未 import 或执行 Native 模块。

| 文件 | 核对内容 |
| --- | --- |
| `.vite/build/window-all-closed-BxbCP6YG.js` | `Rw` MSIX updater、`qw` Store updater、`Jw` 回退协调、`iT` SparkleManager、检查间隔和暂存恢复 |
| `.vite/build/main-D8abTQQE.js` | `appUpdates` Native 服务、状态广播、安装前准备、会话恢复记录、正式 Windows 退出清理 |
| `.vite/build/file-based-logger-C6QKdHxk.js` | 构建渠道、Store product ID 和官方 Windows 更新清单地址 |
| `webview/assets/app-initial-d9bed9d614d8.js` | 更新状态订阅、安装动作、活跃会话确认、安装进度与恢复状态消费 |
| `webview/assets/app-primary-17b54400f32a.js` | `sLn` 实际更新按钮、可见/禁用条件、进度和安装点击入口 |

原始主进程文件 SHA256：`b55be874a9b5a262c09a7945df38cec9b0ce8f14bd584ef73d6feca301ed90b4`。

原始更新模块 SHA256：`8939f42fd89899a649b8062699b386e9ff933c241155b611c3b5ec7a738673ed`。

原始主界面模块 SHA256：`8b57b72037a6478e5e2959b8e124469433f3bc19249c14f9a4dfb1f56ef8d7e7`。
