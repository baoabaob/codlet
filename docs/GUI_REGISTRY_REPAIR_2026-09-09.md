# GUI Registry Repair and Acceptance Record

日期：2026-09-09。

本记录描述 bundled GUI 的 registry reconciliation 和插件 ID 兼容性修复，
并单列本轮用户验收事实。它不改写历史验收报告中的 `pending` 字段，也不把
部分 M0/M1 观察扩大为完整生产门禁或新版正式 GUI 通过。

## Canonical identity

Bundled GUI 的 canonical plugin ID 是 `codlet-gui`。菜单、窗口和产品显示名
仍为 `Codlet`，能力名称仍为 `codlet.runtime.*`。

旧 ID `codlet` 可作为 CLI 兼容别名，供 `enable`、`disable` 和 `reload` 使用。
客户端在 `prepare` 前将它归一化为 `codlet-gui`；新版 Host 的 `status` 和 GUI
列表使用新 ID，静态 `list`/`doctor` 同样列出新 ID。`codlet` 与 `codlet-gui` 都是保留的 local ID，
本地插件不能接管任一名称。

Registry preference 的迁移规则如下：

- 明确存在的 `plugins.codlet-gui` 优先；
- 新 key 不存在时，只读回退读取旧 `plugins.codlet`；
- `list` 和 `doctor` 不写入或迁移这两个 key；
- 用户明确更新 GUI preference 时，在现有 registry save lock 内写入新 key 并删除旧 key；
- 已运行 Host 的 plugin identity 和既有 receipts 不现场重写，canonical identity 在使用新二进制的下一次启动生效。

## GUI registry reconciliation

GUI 管理列表每次刷新读取最新 registry 和实际 loaded plugin 集合，不使用旧的
启动缓存推断当前状态。

- 已注册且已 loaded 的插件显示 registry metadata 与实际 target active state。
- 已从 registry 移除但仍在 runtime 中 loaded 的插件继续显示，直到实际 unload，
  并显示 `Registration removed; still loaded`。
- 插件同时满足已 unload、已移除注册时，该行消失；remove 本身不执行 unload。
- 新注册但 `not_loaded` 的插件只提供 registry metadata；GUI 不读取其源码来伪造
  runtime state。
- registry 读取失败显示明确错误，不回退到 stale cache。

## User acceptance observations

用户实际运行了 M0、普通 M1 和 M1-watch，并确认整体视觉检查符合预期；同时报告
disable+remove 后 GUI 仍显示 disabled 条目的例外，本批针对此问题修复。以下记录
原始报告与用户确认的事实：

- 核对普通 M0 harness 的原始 JSON，exit 为 `0`，Host PID `63976`，
  child PID `11692`。
- 普通 M1 运行 exit `1`，缺少 stopped 协议，报告未保存具体错误。用户不记得原因，
  因此该项保留待核验，不推断为手动中断或成功完成。
- M1-watch 运行 exit `0`，包含 active 和 stopped，Host PID `29692`，child PID
  `36240`。
- 三次已记录运行的 before/active/after 相关 TCP 列表均为空，after 相关进程均为 `0`。
- 热添加 `dev.codlet.acceptance-marker` 成功；online `enable`、`reload`、
  `disable`、`reenable` 已观察；watch 两次变更已 applied；doctor Inspect 已观察。
- 用户报告的视觉检查作为单独观察保留，不改变原始 acceptance JSON 的 pending
  字段，也不宣称新版真实 GUI gate 已正式复测通过。

完整 M0/M1 尚未关闭；100 次冷启动基线和 crash gate 仍未关闭。

## 修复构建的正常退出复测

用户随后重新运行了 M1。新报告实际命令为 `launch --watch`，使用下文固定
SHA-256 的修复构建，Codex build 仍为 `26.903.8094.0`。报告位于
`.codlet-artifacts/gui-registry-repair-2026-09-09/production-m1-watch/m1-acceptance-20260909T124017233Z-45096.json`。

- UTC 12:40:17.233 至 12:40:46.817；Runtime Host PID `41432`，Codex PID `20540`。
- 退出码 `0`，active/stopped 均出现，CDP workers 已回收。
- before/after 相关进程均为空；三个阶段的 TCP listener 列表均为空，captureError 均为空。
- `executionStatus=codlet_completed`、`scriptExitCode=0`；原始 decision/manual 字段保持原样。

该记录补充了修复构建正常退出的成功证据。用户认为旧普通 M1 的退出 1 可能来自直接关闭
cmd，但无法确认；保留旧报告和原因未定，不再用这一条历史疑点阻塞日常开发。
本次复测没有单独记录 disable/remove 场景的新视觉步骤，不扩大成该场景的实机回归声明。

用户已明确要求小修复采用针对性检查后继续推进。M2 开发继续进行，重复冷启动与 crash
等里程碑收口证据单独保留，不要求每个开发小包重跑完整 M0/M1 或启动真实 Codex。

## Final source validation

本轮修复源码提交为
`202d89b04834f6e0952ade36b7c6c9f10b8e8472`。最终 Rust 验证为 315 项通过、0
项失败，1 项显式 real-start gate 保持 ignored；Node 为 64 项通过。Clippy
（all targets/features，`-D warnings`）、fmt 和 release bins 均通过，release
构建耗时 13.88 秒。

证据目录为 `.codlet-artifacts/gui-registry-repair-2026-09-09/`，其中包括
`codlet.exe`、`codlet-lab.exe`、`run-m1-watch.cmd`、`cargo-test.log` 和
`node-test.log`、`verification.json` 和 `post-cleanup-verification.json`。release `codlet.exe` SHA-256 为
`49FB948EBCEDDFE1B018C6DAE716D672E37877828B18D4946CE2E67353C6ABE2`。

清理后的只读检查中，真实 registry 的 `plugin list` 与 `doctor` 均 exit `0`，
仅显示 `codex.ui.adapter` 与 `codlet-gui`；`markerStillRegistered=false`、
`guiDesiredEnabled=true`、runtime 为 `not_running`，没有 `codlet` 或 `codlet-lab`
进程。registry 前后 SHA-256 均为
`9CA6FA292AC8566B62EA724D1EECD5D26A03E30A7157A048CE1F4AE4E4367C16`。
这些结果证明当前磁盘注册已清理且 GUI preference 已恢复；它们不能代替已关闭
旧 Host 的当时 runtime snapshot。
