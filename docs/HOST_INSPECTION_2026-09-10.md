# JS host 执行诊断

`codlet doctor` / `codlet doctor --json` 现在读取实际 JS 执行器样本，可查看在线启动、重载、
停止、清理和已退出代的记录。诊断仍是只读操作；它不会启动插件、提交 lifecycle receipt
或用磁盘声明冒充当前进程。doctor 原有的静态配置检查继续独立进行。

## 协议与兼容性

新增 authenticated scoped control 请求：

```json
{"schema_version":1,"command":"inspect_execution"}
```

成功响应仍为 `status: "inspected"`，包含原有 `inspection`，另以可选 `host_inspection`
返回 JS 进程样本。请求只携带协议版本和命令，不接受目录、JS、目标或修改动作。

- 原 `inspect` 返回原字段集，不附加 `host_inspection`，包括值为 null 的该字段。
- identify、prepare、submit、result 与 status-v1 的字段集保持不变。
- 只有新命令允许进程样本；客户端拒绝旧命令中注入的额外字段、缺失的 runtime identity
  及不匹配的 PID、registry scope 或 incarnation。
- 新客户端先请求 `inspect_execution`。只有已认证、匹配 scope 的旧 Host 明确返回不支持
  时，才回退为旧 `inspect`。两次只读查询共享既有 1500 ms 总预算；timeout、busy、身份或
  通信错误不会触发第二次查询，更不会触发生命周期操作。
- 新旧 Inspect 都受 256 KiB 响应上限约束。超限返回 `inspection_too_large`，不返回看似
  完整的部分样本，也不影响独立的旧 Inspect 或 receipt 队列。

保留旧命令是为了兼容严格解析字段的既有客户端；没有修改 status-v1 来伪装 host 为
renderer target。旧 Host 返回的 renderer 样本仍可使用，缺失 host 样本不等于零个 host。

## 样本含义

StatusPublisher 在同一次 publication 读取主运行时身份、renderer/kernel 样本和最近接收的
host 样本。JS 执行器是独立 owner，所以还保留自己的 `sequence` 和 `sampledAtUnixMs`；
新的 renderer publication 不能替旧 host 样本制造 freshness。

组合包的 Host 进程样本使用逻辑包 ID，renderer target 样本使用同一 ID 与共享 generation。
capability 注册样本中 Host owner 使用 `包ID:host`，其 kind 为现有 `host`；renderer
owner 保留逻辑 ID。这里只报告已经注册的 provider 与精确代次，不把声明当成活跃 endpoint。
等待 Host capability 的前台交付计入 lifecycle busy；原 `pendingCoreRequests` 仍只计
Host 发起的 managed Core 请求，未改为混算传入 invocation。参见
[调用与取消契约](HOST_CAPABILITY_2026-09-10.md)。

`host_inspection` 使用严格的 camelCase DTO：

| 字段 | 含义 |
| --- | --- |
| `sequence` / `sampledAtUnixMs` | 执行器自己的采样序号与时间，读者查询不推进它们。 |
| `ownerAlive` / `runtimeStopping` | RPC owner 当前是否存活，以及整个 JS runtime 是否在停止。 |
| `retainedLimit` / `historyTruncated` | 最多 16 个当前资源拥有者与 64 条终态记录；不是完整历史。 |
| `plugins` | 保留的每插件最新代：ID、版本、generation、state、当前或最后观测 PID 与有界错误。 |
| `pendingCoreRequests` / `subscriptions` / `outbox` | owner 当前持有的请求、订阅和待发回复/事件数量。 |
| `launching` | 该代是否仍等待固定 launch worker 返回创建结果。 |
| `cleanup` | 清理阶段、剩余总预算、清理请求数和有界错误。 |
| `exit` | 可用时提供已确认的退出 PID、exit code、forced 与 workersReaped。 |

纯 DTO 位于 `plugin_execution.rs`，没有 Windows 句柄或可执行源码快照。发布不序列化
`LoadedPlugin`，不读取插件文件或发起 CDP。错误是插件/执行器产生的有界诊断文本。

`starting` / `stopping` 表示仍可能持有资源；`failed` / `exited` 表示已完成原生退休。
终态 PID 是历史标识，不能据此判断同号 OS 进程现在属于此插件。清理 acknowledgement
完成与进程 Job/stdio 最终退出是不同事实，可能短暂出现 cleanup completed 而 state stopping。

旧代或终态记录被淘汰后，`historyTruncated` 保持 true；缺席不表示从未运行，也不表示
该 ID 在 registry 中已被禁用。终态 publication 禁止后续更新复活；正常与错误退出路径
均在确认 host 停止并发布最后样本后，才把主运行时标记为 terminated。

## doctor 输出

新样本在 `runtime.hostProcesses` 下出现，包含执行器原始样本、各状态计数、独立的
freshness 和 findings。超过 5000 ms、时钟倒退或尚未采样会明确标记，不用主 publication
的时间掩盖它们。renderer targets、capability providers 和 GUI compatibility 的含义不变。

失败代、cleanup timeout 或强制退出以保留事实显示；终态 finding 带 `terminal: true`。
这些历史记录可能在用户已停用或移除插件后继续存在，所以单凭历史失败不让 doctor
持续退出 1。若主运行时仍 ready、未进入全局停止，并且新鲜样本证明 JS owner 已停止，
则报告 `runtime_host_owner_stopped`，作为当前 runtime 故障。

该输出不探测插件 endpoint 健康，也不证明任意 DOM、页面或 OS 副作用已撤回。带预算的
协作清理合约见 [HOST_CLEANUP_2026-09-10.md](HOST_CLEANUP_2026-09-10.md)。

## 定向验证

- 真实受管 Node 与假 CDP：starting、active、stopping、退出事实和重载新代逐次发布；
  已取得的快照保持不变，序列化不带入入口源码，重复只读查询不执行 lifecycle。
- authenticated native pipe：新响应可读，旧字段集合保持，缺失身份或旧命令扩展被拒绝。
- 兼容回退：只在已认证的明确拒绝下读取旧 Inspect，其余错误不重试、不产生 receipt。
- DTO 与响应预算：新请求严格校验，过大 host 样本明确失败，旧 Inspect 继续独立工作。
- doctor：host 与 renderer 独立采样、旧代失败历史、清理进度、source freshness 与 owner
  意外停止的判断，以及原有 renderer 诊断兼容回归。

上述 16 个定向场景通过；本包未启动真实 Codex，也未改写用户 registry。
