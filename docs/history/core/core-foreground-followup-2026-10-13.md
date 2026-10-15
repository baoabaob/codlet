# 前台采集支持：namespace、清理与退出收尾

2026-10-13（Asia/Shanghai）。本聊天只读取源码/回执、运行本地离线回归、准备文件；没有启动、接入或操作本次 Native 实例。主聊天仍是唯一启动与退出所有者，已明确本轮不再重开或继续 Native 试验。

## 目录问题的真实复现与修正

首版 collector 和第一版盘符修复分别在 `consumer-52cc3144-5dc8-49ad-8f9f-e7e156bcbbe8`、`consumer-bfaa8980-b296-460d-bd01-9a154fa7ede1` 的构造阶段失败，均未进入 probe/Tracing。第一版只测了假设的 slash-normalized path shim，不能证明实际 Host 的实现。

随后直接使用测试包 Node **24.21.0**，仅查询 Core 工作目录及其祖先，复现：

- 普通绝对卷根 `X:\` 的 lstat/stat/realpath 成功。
- 实际传给 lstat 的 `\\?\X:\` 抛 EISDIR，错误对象的 `path` 却是 `X:`；该参数的 `path.resolve` 结果也失去了最后一个根分隔符。
- 因此，错误文本里的 `X:` 不能证明调用者真的把 `X:` 传给了 fs。第一版依据错误文字推断 path shim 的解释不充分。

当前 Core 源码的 `runtime/host.cjs` 直接加载 `node:fs/node:path`，Host `context.root` 来自 `process.cwd()`；`src/js_runtime.rs` 将已加载 package root 设为子进程 cwd。工作区源码不能单独认证 89c5 二进制的全部执行行为，但 namespace 路径在普通、真实 Node 中已足以复现同样失败。

新 collector 仅对遍历中严格匹配 `\\?\<盘符>:\` 的**卷根**，改用等价普通绝对卷根 `<盘符>:\` 进行 lstat；子目录仍保留 namespace 原字节和语义，不统一剥掉前缀，避免改变尾随点等文件名含义。卷根仍必须是普通非链接目录；其他错误照常传播。

真实 Windows 回归先在 c9a724 代码上复现 `lstat 'C:'`，修复后通过；另用真实 junction 验证 namespace 祖先链仍被拒绝。主聊天的调用端方案——使用已冻结且核验与 context.root 等价的普通绝对输出路径——也保留了原完整目录检查，已使后续实际 probe 成功。

## 可选的 owned Host 元数据探针

[foreground-host-metadata.cjs](../../../scripts/native-core/foreground-host-metadata.cjs) 可复制到一个未来新建、明确拥有的 Host 包，在建立 collector 之前调用：

```js
const {probeOwnAncestors} = require('./foreground-host-metadata.cjs');
report.hostPathMetadata = probeOwnAncestors(context);
// 随本 driver 已有的报告写入流程保存；探针自身不写文件。
```

探针只接受本进程 cwd（与 context.root 相符）及其祖先，不接受任意路径。记录原始字符串/code units、resolve/dirname/parse 结果、Node/uv/platform/execPath、builtin/别名对象一致性、方法可用性和函数源码摘要；每项错误保留完整 code/errno/syscall/path/message/stack。目录元数据使用 bigint 保留身份精度。盘符相对或不完整 namespace 根只记录、不查询；lstat 失败或发现链接时不继续用 stat/realpath 跟随。

探针没有 CDP、文件正文读取、写入、process 枚举、目录切换或模块修改。CLI 样本用于比较参数及函数摘要，不冒充实际 Host 探针结果；本轮不为此重开实例。

## 已完成的实际协议观察与清理缺陷

`consumer-5e5975c0-fd50-4543-80a1-5331d1eb7904` 使用调用端普通输出路径完成实际 probe：Chrome 155，Tracing categories 回空数组；Browser window 查询失败；layout/frame tree、Performance metrics、页面观察能力可读。Tracing.start、Page.startScreencast 和 Performance.enable 被接受，但无观测到 tracingComplete、screencastFrame 或 visibility 事件。原 capture 的 frames=0、traceFile=null，不能换算为 0ms 或呈现支持。

该样本的实际 driver 在 `scope:all` 单订阅中先 `fg.onEvent(event)`，然后才过滤其 Native 错误的 session。当前 Core 源码 `host_runtime.rs` 将 all 交给 `CdpEventFilter::All`，`cdp/client/raw_access.rs` 允许该 scope 的 root 事件，`cdp/client.rs` 将事件投递给 bounded sinks。未发现 driver 先过滤掉 root 的代码错误；但原数据不足以断言事件在哪一层缺失，也不把源码检查当作部署二进制的端到端投递证明。

旧 collector 将“未收到 complete”错误地保持为“仍有权再次 end”。dispose 因第二次 end 返回 `Tracing is not started` 而提前抛出，页面 observer 清理可能未执行。这是已定位的采集器清理缺陷，旧失败报告保留。

新版本分别保存 `traceEnd.accepted` 与 `traceCompletionObserved`。end 被接受后不再重复结束；仍有界等待完成事件，缺失证据保留在 capture。dispose 分别尝试 finish、screencast、trace、metrics 和 page observer 清理，某一步失败不阻止后续步骤；错误在全部步骤尝试后汇总抛出，`error.cleanup` 保留每步结果。新增 forwardedEvents 的 root/本 session/其他 session 计数，以及 `onSubscriptionEnd(reason)` 供唯一订阅的第三回调转发。它们用于下一次诊断，不改变本次未观测结论。

## 五分钟退出延迟

本次 coordinator `1791857416908-16000` 的 lab report 在 **11:25:46** 已有 Desktop exit 0、CDP workers reaped，但协调器仍暂时 stopping。只读 stderr 明确显示等待 Windows 更新注册、随后未确认安装且不启动第二份。

源码路径为 `src/lab.rs`：`cdp_workers_reaped` 后调用 `OfficialUpdateOwner.finish()`；`src/official_update/owner.rs` 的 pending 分支有 **300 秒** 有界等待。状态文件随后真实记录 **11:30:46.287 closed、Host exit 0、backend 在 Desktop 后停止**。主聊天在 **11:37:17** 重新核对四个根及全部 27 个捕获身份均退役，退出回执 remaining=0。

最小收尾方案因此是让已识别的有界等待自然完成，再由唯一所有者复核身份。实际没有终止任何进程、伪写 closed 或重开窗口。日志仅支持“触发更新确认等待但未确认安装”，不证明发生了升级；无需把这段已解释且自然结束的等待写成 Drop/control-server 死锁。

## 冻结交付与验证

`.codlet-artifacts/core-foreground-support-2026-10-13-namespace-cleanup-v2/manifest.json` 记录新 collector、可选 metadata 探针及原样配套文件的摘要。此版本仅为离线修复归档，不触发本轮重开。

包内 Node 24.21.0 上 **24 项检查通过**：原 11 项 collector、5 项路径模型、2 项真实 Windows namespace/junction、3 项 metadata 探针、3 项 end/事件/独立清理回归。真实 filesystem 回归不使用假 fs；CDP 与页面回归使用模拟边界，未连接客户端。原始失败 sample、capture、report、状态和退出记录均未改写。

通用修复没有在 Native 实例上复验。主聊天的[最终消费者验收报告](../../../../codlet-split-workbench/docs/history/consumer-final-acceptance-2026-10-13.md)已归档为 **not-accepted**，并区分 surface 检查通过、采集可观测性缺失和 Host 清理失败；本工具的离线回归不改变该结论，也不触发重开。
