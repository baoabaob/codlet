# 独立启动器原子状态发布修复

2026-10-12（Asia/Shanghai）初次修复；2026-10-13 补记实际恢复结果。初次交付只修改 Core 工作区脚本、测试和文档，未启动或部署客户端。随后由唯一启动者完成部署、恢复和正常退出，**本次故障恢复已实际成功**，详见文末回执。

## 已确认故障

coordinator `1791818967875-53656` 的 `state.json` 和 `manual-client.json` 停在 starting；`state.json.53656.tmp` 已包含 ready 和 `readyAt=2026-10-12T15:29:37.287Z`。首次错误发生在 **ready 发布时的 rename**。固定 PID 临时名在首次 EPERM 后残留，finally 再写同名临时文件时抛出 EEXIST，遮蔽了最终清理状态。

旧 lab report `profile/logs/run-1791818968350-55696/report.jsonl` 第 20–21 行有匹配 Desktop 60060 的 `child_exited(exit_code=0)` 和 `cdp_workers_reaped`。发起聊天另行只读核对本轮四个 PID 均不存在。本轮没有再次查询或控制它们；也不把旧协调器文件补写为 closed。

## 修复行为

- [isolated-state.mjs](../../../scripts/isolated-state.mjs)采用 PID＋随机 nonce、`wx` 独占创建。已有临时文件不覆盖、不删除；同名碰撞最多另取 4 次。写入并 flush 后，才尝试原子 rename；不删除目标文件后再改名。
- 只对 Windows 的 EPERM/EACCES/EBUSY 做 8 次以内的 rename 尝试，退避为 10/20/40/80/160/250/250ms，总等待 810ms。这个上限只指主动等待，不包含文件系统调用耗时。其他错误立即返回。
- 每次重试复核父目录链身份，拒绝 symlink/junction、非普通目录、目标硬链接/非普通文件；复核临时文件的 inode/dev/链接数。原有 root 标记、路径、版本、CLI/lab 摘要和来源验证保留。
- 写入或 rename 最终失败时保留临时文件，并在错误中记录路径。失败 temp 不是已发布状态，后续尝试使用新名称。
- [isolated-client.mjs](../../../scripts/isolated-client.mjs)把 stdout 事件回调和流错误交回启动控制流程，不让回调异常直接逃出清理。主错误先记录；请求退出、等待已持有的 lab 句柄、退出 backend 的顺序保持明确。等待 Desktop 退出期间，即使 needs_attention 发布失败，也继续保留 backend 并等待。
- finally 中每个状态文件分别尽力发布，失败记为次级错误、退出码非零，并提示状态可能陈旧；不会中断句柄清理或替换首个错误。run state 与 manual pointer 是两个独立原子写入，并非跨文件事务。

## 离线验证

使用部署包同版本 Node **24.21.0** 执行：

```text
node --test tests/isolated_state.test.mjs tests/isolated_coordinator_failure.test.mjs tests/isolated_readiness.test.mjs
```

22 项通过（18 项新增、4 项既有）。包括临时占用恢复、永久拒绝及有界次数、遗留 temp 不阻塞下一次发布、碰撞/写入失败、硬链接/目录跳转/目录与临时身份变化、ready 主记录与共享指针分别失败、stdout 回调异常、清理阶段持续失败、等待 Desktop 时发布失败、quit 写入次级失败、正常退出及 recovery 转发。

上述协调器回归在 VM 中执行真实 `start/publish/pump/cleanup` 源码，用内存子进程和假探针替代 OS 边界；未执行 CLI 顶层预检或真实进程创建。文件发布测试操作专用临时目录并注入错误。后续已完成真实恢复及退出验证，但仍未在真实客户端上复现 Windows 占用的成因或相同时序。

## 部署文件

现有 client 目录需要同时放入以下两个文件，保持现有 `isolated-readiness.mjs`：

1. `scripts/isolated-client.mjs` → `client/isolated-client.mjs`
2. `scripts/isolated-state.mjs` → `client/isolated-state.mjs`（新增运行依赖）

精确副本及 SHA256 位于 `.codlet-artifacts/isolated-state-fix-2026-10-12/` 的 `deployment.json`，其中未部署标志保留为初次交付时的记录。实际部署回执见文末；部署前已备份旧脚本和 manual 原件并核对摘要。`Build-IsolatedClient.ps1` 也已更新，新构建会自动包含 helper；现有包无需更换 lab 二进制、配置、登录或 profile。

## 本次 stale starting 的恢复路径

在两个脚本部署完整、旧进程退役确认仍有效、没有其他启动者之后，唯一启动者可在原 client 目录运行：

```powershell
.\Start-TestClient.cmd -RecoverInterrupted
```

初次交付没有执行此启动操作；后续唯一启动者已通过同一 PowerShell 入口 `Start-TestClient.ps1 -RecoverInterrupted` 完成恢复。无需更名、删除旧 `.tmp`，也无需改写旧 starting。

协调器先按旧 manager PID＋创建时间检查是否仍存活；随后给 lab 传入最新原始报告和显式恢复选项。lab 仍核对 profile 归属、报告位置/新旧顺序、包身份与版本、Desktop PID＋创建时间及 root 占用。依据 [resume.rs](../../../src/lab/resume.rs:242)，本次报告已经满足 closed lifecycle，因此走正常 closed-report 路径；`-RecoverInterrupted` 不会把旧 starting 伪造成 closed，也不会在该分支额外声称重新核查过四个 PID。若最新报告不满足 closed 条件，才进入显式 interrupted recovery，并要求匹配协调器来源及记录 PID 全部退役；无法证明则拒绝。

新启动成功后会发布新 coordinator 状态，`manual-client.json` 自然更新为新 run。旧 coordinator 的 `state.json`、故障 temp、启动 stderr 和原 lab report 继续保留为历史证据。

## 2026-10-13 实际恢复与退出回执

本节仅只读复核发起聊天交回的文件，没有再次启动、操作或查询实时进程。时间均按 Asia/Shanghai 表示。

- [实际部署回执](../../../../codlet-split-workbench/.checks/native-comparison/consumer-d8b2880c-350b-4b85-b043-9f3c293469f9/recovery-evidence/deployment.json)：10 月 12 日 23:53:34 部署两个脚本，完整 SHA256 与交付清单匹配；旧脚本和 manual 原件已备份，失败 run 的证据保持不变，lab 与配置未改。回执中的 `clientStarted:false` 描述部署时点，不覆盖随后恢复。
- 新 coordinator `1791820455182-54408` 的[归属与 ready 证据](https://github.com/baoabaob/codlet-plugins/blob/main/.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/owned-runtime-evidence.json)确认认证、sandbox、8 个 synthetic fixture、registry/data routes 和新 Target；lab SHA 仍为 `89c5c94d…`。这些 PID/Target 只作历史证据。
- [协调器最终状态](https://github.com/baoabaob/codlet-plugins/blob/main/.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/profile/logs/coordinator-1791820455182-54408/state.json)记录 10 月 12 日 23:54:29 ready，10 月 13 日 00:02:51 closed，Host exit 0，backend 在 Desktop 退出后结束。发起聊天同时确认四个临时包已移除、scoped list 为空，没有草稿写入或新 turn。
- [退出复核回执](https://github.com/baoabaob/codlet-plugins/blob/main/.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/retirement-1791820455182-54408.closed.json)使用 `pid-creation-parent-creation-v1`，记录 27 个捕获身份，remaining 和 reusedPids 均为空。

因此可确认这次修复已成功部署，并完成从旧故障状态恢复、重新就绪和正常收尾。该结果不证明 Windows 文件占用的具体来源已找到，也不等于现场重现并消除了所有占用情形。实例已关闭，不追加实验。
