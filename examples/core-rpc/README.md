# Core RPC：四个独立 entry

这个例子展示 Host 和 renderer 之间的实际双向能力调用。四个目录分别注册，使用显式测试
registry，按各 manifest 声明授信。`service` 需要 `host.process`；`coordinator` 需要
`host.process` 和 `cdp.raw`；`view`、`consumer` 无额外 permission。它们不使用 OS broker 范围。

| 目录 | 行为 |
| --- | --- |
| `service` | Host 提供 Runtime 数值计算与 Target 身份查看 |
| `view` | 每个 renderer 文档提供 Target endpoint，并用 `invocation.rpc` 嵌套请求 Host |
| `coordinator` | Host 初始化先调用另一 Host，再选择最后一个 page Target，取得 Core scope，等待该窗口 renderer |
| `consumer` | renderer 消费 Host Runtime 能力，并暴露可交互的演示函数 |

运行环境需要至少一个 renderer page Target；多窗口时 `coordinator` 按 targetId 排序选择最后
一个，因此能验证初始化等待其它窗口的 provider。依赖图本身决定启动顺序，注册命令的排列
不会代替它。官方 renderer executor 在同一 entry 的全部目标安装完成后再继续消费者。

在 `consumer` 的隔离世界中，`__rpcRoundTrip({value:5})` 依次经过 renderer→Host→renderer→Host，
结果包含值、Core caller 和深度。`__rpcStats()` 查看真实 Host handler 的完成/取消计数；
`__rpcNotify()` 演示无响应 renderer 通知；`__rpcProbe()`、`__rpcRefresh()`、`__rpcClose()`
演示 Core scope 失效、重新验证与关闭。

Host 的 async 调用自动继承父预算。renderer provider 显式使用 `invocation.rpc`，使取消和
原始截止时间继续传到 Host 子调用。导航不会升级旧句柄，`close()` 也不会把 raw session
变成别的 Host 的资源。例子没有任意 OS 写入或网络调用，Core 在 Host deactivate 后归还
它记录的 raw session。

对应源码验收为 `src/cdp/client/core_rpc_vm_tests.rs`。其隔离 peer 执行这些实际源码和生产
bootstrap，验证两窗口启动、全部调用方向、原预算/取消、导航、关闭与 reload/补偿；不声称
模拟真实 DOM。API、资源上限和授权细节见 [Core RPC 合同](../../docs/spec/rpc.md)。
