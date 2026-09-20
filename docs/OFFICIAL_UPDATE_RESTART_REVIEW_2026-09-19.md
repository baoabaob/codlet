# 官方更新后保留 Codlet：源码核对与实现依据

目标：通过 Codlet 启动的客户端，在用户点击官方更新入口并完成更新后，继续由 Codlet 管理；同时存在两项更新时，在 Codlet 更新按钮旁提供一起更新的入口。

## 当前结论

2026-09-19 已实现 Windows 的会话内重启接管和“同时更新”，并完成原生 API 测试、事务测试及隔离客户端重启演练。实现和验收边界见 [更新交接记录](OFFICIAL_UPDATE_HANDOFF_2026-09-19.md)。尚未执行真实官方包的跨版本安装，也未实现 macOS Sparkle 的对应接管。

单独监听旧客户端退出并再启动 Codlet 不足以实现目标：Windows 官方安装器已经登记了自己的重启目标，可能先启动一个未由 Codlet 管理的应用，与 Core 的新实例产生冲突。正常退出也不能被当成更新完成而自动重启。

## 本机证据

核对包：`OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0`，应用 `26.915.31945`，build `9922`。ASAR SHA-256：`b8aeb817cd1ee6ef50efe8a97985d3be41de89688a5addfe0a444e1e52348096`。

- `main-LM8MUIFp.js` 的 `appUpdates.installUpdate()` 调用现有 SparkleManager 门面，官方 UI 并不通过 Codlet 启动器重启
- `bootstrap-DK4EfNwt.js`：MSIX 的 `installPreparedUpdate()` 调用 `activateStagedPackage(path, progress, allowElevation)`；Store 的 `performInstall()` 调用 `trySilentDownloadAndInstallStoreUpdates(progress)`。这两处没有外部重启命令参数
- `windows-updater.node`（SHA-256 `0caf30c97b1fa0f5472668e10c71739ac587119ee7edac4208949753f70dcd8c`）：只读反汇编显示两处 `RegisterApplicationRestart` 调用。虚拟地址 `0x1800255c4` 的参数为 UTF-16 `codex://launch`、flags 0；`0x180028ae1` 为 UTF-16 空串、flags 0
- `main-LM8MUIFp.js` 的普通 `a7()` 重启可以通过 `CODEX_ELECTRON_DEV_RELAUNCH_MARKER_PATH` 通知开发父进程；上述 Windows 安装器路径没有调用此分支，因此该 marker 不能证明真实更新后的恢复有效
- 隔离 dev 默认关闭官方更新，其安装包仍与日常应用共享。直接在 dev 开启官方安装不会提供独立的包升级验收环境

提取文件、扫描脚本和只读反汇编位于忽略目录 `.codlet-artifacts/tag-search/`，未修改官方文件或协议注册。

## 实现约束

1. 使用当前官方更新的真实就绪状态与版本身份，保留官方的用户确认、会话保存和安装失败语义
2. 在安装前与 Core 完成一次性启动交接，明确由谁负责新版进程；不能抢占任何已存在的日常窗口，不能依赖 PID 或包版本单独推断继承关系
3. 成功时恢复同一配置和插件；取消或失败时保留当前可用实例；普通退出不自动重启
4. 在解决安装器自身重启与 Core 启动的协调方式前，不提供声称覆盖该流程的 dev 验收按钮

## 同时更新预览

保留原 Codlet 更新按钮，旁边增加浅蓝色“同时更新”；仅 Codlet 更新时隐藏，官方客户端下载中时禁用并说明等待。确认框说明两项更新及本地任务中断。产品按钮已经接入 Core 的真实事务；本地 UI 预览中的版本和进度仍为示意。
