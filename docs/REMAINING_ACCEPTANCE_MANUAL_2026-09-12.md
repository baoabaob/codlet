# 剩余审批补验与 M0/M1 发布门禁

日期：2026-09-12。配合 [M5a 手测指南](LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md) 使用。这里解释此前保留的检查，并区分可由用户验证的流程、发布阶段的自动采样和仍需开发修复的缺陷。**本页新增用例均未实测通过，不影响继续开发 M5b。**

## 这些检查是什么

| 检查 | 要证明的行为 | 当前状态 / 谁来完成 |
| --- | --- | --- |
| 独立 `fileChange` 审批 | 插件对一次文件修改请求分别批准、拒绝，收到 Desktop 确认，文件结果符合决定 | 待适用构建手测；下面 F01 / F02 |
| M0 启动与退出 | 正式启动后控制管道保持；用户正常退出后 Host 与 worker 一起结束，没有遗留调试端口 | 正式启动路径需单独验收；下面 R01 |
| M1 插件运行 | 正式启动中的挂载、启停、重载、导航恢复、多窗口和退出清理 | 机制自动回归已有覆盖，真实正式启动按 R02 补证据 |
| 重复运行 | 同一声明支持构建的连续冷启动、退出没有累积残留 | M5c 集中自动收集至少 100 次样本，不要求你手动重复 100 次 |
| 官方入口纯净性（DEFECT-001） | 从官方入口启动的实例不意外复用一个带扩展的主实例 | 已知顺序相关限制，见 R03；需要开发修复或阻止发布 |
| Runtime Host 崩溃（DEFECT-002） | Host 意外终止后，其启动的 Codex 是否按生命周期契约退出 | 历史实机曾失败；见 R04；需要开发修复或阻止发布 |

“门禁保留”表示现在不能把候选版本标为正式交付通过；不是要求每次改动重跑全部检查。隔离测试客户端使用独立资料与调试入口，它的通过结果不能替代正式 `codlet launch` 的 M0/M1 证据。本页包含完整手测步骤；历史详细记录可在源码仓库的 `docs/M0_M1_ACCEPTANCE_2026-09-09.md`、`docs/PRODUCT_TECHNICAL_PLAN.md` 查阅，便携包不附旧实验日志。

## F01 / F02：文件修改审批（适用时约 5 分钟）

这里要验证的具体请求是 `item/fileChange/requestApproval`。M3 / M4 面板将它显示为 **fileChange**。**permissions** 表示另一种临时文件系统权限请求：其批准/拒绝已经完成 SDK 实机往返。批准 permissions 后成功写文件，不能代替 fileChange 的批准/拒绝。

### 准备

1. 使用隔离测试客户端，在你专门准备的临时项目目录中创建 `approval-check.txt`，内容为 `before`，保存。仅在这个临时项目中试验。
2. 进入该项目的原生任务，打开右下角 **M3 / M4** 面板，确认连接可用。保留正常审批策略，不为触发旧请求关闭保护或扩大目录授权。
3. 关闭面板的输入测试拦截开关，避免测试前缀改写请求。先记住开关原状态，结束后恢复。

### F01　批准一次文件修改

1. 在原生输入框要求：`只把当前临时项目的 approval-check.txt 从 before 改成 approved，不修改其他文件。若需要审批，等待我决定。`
2. 等待 M3 / M4 面板出现审批卡片。只有标题以 **fileChange** 开头，才继续此用例。记录卡片和事件框里的 `approval.requested`、`kind`、thread / turn / item ID 与 token。
3. 核对原生界面提出的文件改动仅涉及这个临时文件。在 **M3 / M4 面板**点击 **允许本次**，等待事件框出现同一 token 的 `approval.resolved`，再等待回合结束。
4. 打开文件，确认内容是 `approved`，没有额外修改。卡片应消失。

**通过条件：** 确实出现 fileChange，插件回复获得服务端确认，实际文件改动与审批一致。仅出现“回复已发送”还不算完成。原生审批按钮的成功不计作插件 SDK 回复通过。

结果：____　构建：____　任务 / 回合：____　备注：____

### F02　拒绝一次文件修改

1. 手动把临时文件恢复为 `before`。另发一轮，要求把内容改为 `declined-change`。
2. 同样确认是 **fileChange** 卡片，记录请求标识。在 **M3 / M4 面板**点击 **拒绝**。
3. 等待同一 token 的 `approval.resolved` 和回合结束，再打开文件。

**通过条件：** 文件保持 `before`，没有绕过拒绝进行相同改动；卡片消失。回复事件、决定与文件结果能够对应到同一回合。

结果：____　构建：____　任务 / 回合：____　备注：____

### 没有出现 fileChange 时

当前已测隔离策略曾直接拒绝 `apply_patch`，也可能改走 **permissions**。这时记录“**未触发 / 当前配置不适用**”，附原生提示和卡片类型，结束本项即可。不要将其标记通过，也不要反复试图绕过策略。后续由开发者确认支持构建、适用条件或是否应撤下该能力声明。公开 SDK 使用不透明 token，不要求你读取私有 transport request ID。

结束后删除或保留这个临时测试文件均可，恢复输入拦截开关原状态。不要重置测试资料或真实项目。

## 正式启动验收的准备

**R01–R04 安排在你愿意退出 Codex 的时间进行。** 从项目目录外开的独立 PowerShell 运行脚本；保存工作并正常退出所有 Codex / ChatGPT (Dev) 实例以及隔离测试客户端。当前这条开发任务运行时不要执行这些检查。脚本遇到已有实例会拒绝，不应通过强杀其他实例解决。

在项目根目录打开 PowerShell，设定本轮要验收的 **最新便携包** `codlet.exe` 路径：

```powershell
$candidate = (Resolve-Path -LiteralPath '替换为本轮便携包的完整路径\codlet.exe').Path
Get-FileHash -LiteralPath $candidate -Algorithm SHA256
```

记录 Codex 实际构建、Codlet SHA-256、时间和脚本生成的结果目录。不要把 2026-09-09 旧产物的运行结果当成当前二进制的证据。以下脚本路径相对于本项目根目录；每次使用新的结果目录。

### R01　M0 正常启动、正常退出

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath $candidate -ArtifactsDirectory .\.codlet-artifacts\manual-m0-2026-09-12
```

按脚本提示检查：客户端能使用，各目标出现本轮 marker；保持窗口使用时 Host 与管道仍存活；随后正常退出客户端（必要时从托盘退出）。结果应出现 active 和 stopped，worker 已回收；前后快照没有新增监听 CDP 的 TCP 端口，也没有残留该轮 Host/worker。

**记录：** 脚本结果目录、窗口/marker 所见、正常退出方法。脚本退出码 0 只说明自动采集通过，结果中仍为 pending 的人工项需要逐项记录，不能直接把整项门禁关闭。

结果：____　产物 SHA-256：____　结果目录：____

### R02　M1 正式插件流程

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath $candidate -RuntimeMode M1 -ArtifactsDirectory .\.codlet-artifacts\manual-m1-2026-09-12
```

检查 Codlet 菜单、明暗主题与键盘焦点；对一个测试插件启用、停用和 Reload，确认没有重复 UI。打开第二个窗口、执行原生 Reload、切换任务/返回后，挂载能够恢复。正常退出后确认本轮 Host/worker 回收。只对测试插件操作；CLI 与 GUI 使用同一 registry，`doctor --json` 的结果应符合本轮真实运行状态。

需要验收 watch 时再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0Acceptance.ps1 -CodletPath $candidate -RuntimeMode M1 -Watch -ArtifactsDirectory .\.codlet-artifacts\manual-m1-watch-2026-09-12
```

watch 只修改本地测试插件的标记文字，保存后应更新一次，旧 UI 消失。详细本地管理用例沿用 M5a 指南。隔离客户端手测通过可记入对应 GUI 用例，但本节正式启动证据要单独保留。

结果：____　构建：____　结果目录：____　未测项：____

### R03　官方入口纯净性：已知限制，不要求现在重复确认

Electron 单实例复用导致启动顺序有影响。当前已知：**先开官方客户端，再开 Codlet** 时，Codlet 拒绝接管以保护现有实例；**先开 Codlet，再用官方入口** 时，官方入口可能交给已有的扩展主实例，新窗口也可能带扩展。这是 DEFECT-001，不是你操作失败。

M5c 修复后再分别从完全退出状态验证两种顺序，并记录已有进程是否受影响、官方入口窗口是否纯净。同一主进程中的多个窗口本身不算缺陷；官方入口意外复用带扩展实例才是这里要解决的问题。隔离资料启动不能作为该问题已修复的证明。

当前状态：已知限制 / 待开发修复或明确阻止发布。

### R04　Runtime Host 崩溃：发布阶段专项，不要求现在执行

历史实机中，故意终止本轮 Runtime Host 后，官方客户端超过 15 秒仍存活，故 DEFECT-002 不能标记通过。关闭管道目前只是合作退出信号，不能保证客户端已退出。

修复后再安排以下独立测试；它会故意终止**本轮脚本创建并核对身份的 Runtime Host**。保存工作、退出所有其他实例后才执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-M0CrashAcceptance.ps1 -CodletPath $candidate -ConfirmRuntimeCrash -ArtifactsDirectory .\.codlet-artifacts\manual-m0-crash-2026-09-12
```

检查报告中具体存活进程与退出结果，不以窗口看不见替代进程退出证据。脚本不能靠终止 Codex 来制造通过结果；若客户端残留，记录失败并由用户正常退出。此用例与至少 100 次冷启动采样由 M5c 集中处理，现阶段开发者仍负责修复，不转嫁为你的手测前置任务。

当前状态：历史失败 / 待开发修复或明确阻止发布。

## 反馈格式

`用例编号；通过/失败/未触发/未测；Codex 构建；最后一次操作；预期与实际；错误原文；事件/结果目录。`

审批可附卡片和事件框截图。退出检查附脚本生成的报告即可；分享之前去掉不相关任务内容、账户信息或真实工作目录。已经完成的检查不需要为了本页重复执行。
