# Managed Host capability providers

本文保留最初 renderer→Host Target provider 阶段的实现与验收记录。当前 M2 合约已加入
Host `requires`、主动 request/notify、Runtime scope 与 Host 持有的 Target scope；完整声明、
嵌套调用与双方通知语义以 [Core RPC 合约](CORE_RPC_2026-09-10.md)为准。

Host JS 可以通过 `context.rpc.provide(capability, method, handler)` 提供 Target scope 的 capability endpoint。renderer 的声明、租约、target 和 document 身份由 Core 验证后，才进入 Host executor。Host-only 包使用顶层 `provides`；同时包含 renderer 与 host 的包使用 `host.provides`，顶层 `provides` / `requires` 属于 renderer。

```js
const capability = { name: 'dev.worker-tools', api: 1, scope: 'target' };
module.exports = {
  activate(context) {
    context.rpc.provide(capability, 'listTargets', async (params, invocation) => {
      // invocation.caller 来自 Core，不能被 params 内的同名字段替换。
      return context.cdp.request('Target.getTargets');
    });
  },
  deactivate(cleanup) {
    // 使用 cleanup.cdp 归还本代仍持有的外部资源。
  },
};
```

`provide` 校验完整的 name / api / scope 声明、method 和 handler，拒绝重复注册，返回冻结的 `{ ok: true }`。只允许 Starting 或 Active 阶段注册；最多 256 个方法。未注册方法返回 `method_not_found`，handler 异常只结束这次调用，超大返回值返回 `response_too_large`。此处记录的先前阶段未提供 Host 侧 capability request / notify / requires；当前接口与权限见上方 Core RPC 合约。`context.cdp` 的原始方法与 session 能力保持开放。

handler 的第二个参数为不可变对象：

| 字段 | 含义 |
| --- | --- |
| `pluginId`, `generation` | 当前 Host provider 的实际包 ID 与代次 |
| `capability`, `method` | 这次调用的声明与方法，descriptor 为冻结副本 |
| `caller` | 冻结的 Core 身份：`pluginId`, `generation`, `targetId`, `documentEpoch` |
| `signal` | 调用终止、超时、取消或本代停止时 abort |
| `remainingMs()` | 当前调用所剩的有限预算，不会续期 |

Core 内部的 `HostCapabilityClient` 可廉价 clone。`begin_request(HostCapabilityRequest)` 接收实际 owner 包 ID、expected generation、descriptor、method、params、Core caller metadata 和绝对 `Instant` deadline，返回可轮询的 `HostCapabilityOperation`。`try_result()` 只交付一次结果；`cancel()` 和丢弃 receipt 会撤销尚未完成的调用。已有 lifecycle receipt 的“丢弃后继续完成”语义不变。所有 provider work 在现有 Host owner 上轮询，没有每调用线程。

队列与保存的输出有独立界限：capability 入队 8 个，全局未完成或未取走的结果最多 16 个，每 Host 同时运行最多 4 次 invocation；结果 receipt 被消费或丢弃后才释放全局额度。原 Host CDP pending 4、Core outbox 8、JSONL IO 队列每向 4 帧与 1 MiB frame 限制继续生效。capability params / results 为最多 `1 MiB - 4096` 的 JSON，为 envelope 与身份预留空间。调用 deadline 最多 15 秒。

传输沿用按 Host ID / generation 验证的 JSONL v1：Core 发 `capability.invoke` request，JS 回相同 request ID；取消通过 `capability.cancel` notification。排队中的 invoke 帧在写入前检查取消和原始 deadline。已取消、过期或属于旧代次的 response 不会重新附着到新调用。

JS 使用独立的 async invocation context 将 Core 的 invocation token 带入 handler 的 managed Core 调用。此类请求使用内部 `capability.request` envelope；Core 再次验证 token 属于当前 Host 的活动 invocation、取消状态与绝对 deadline。CDP 子请求 deadline 取原调用 deadline、Host request receipt deadline 与子请求 timeout 的最早值。parent 结束时，尚在 Core 中等待的子请求被丢弃、写入前的 raw 请求被取消，后续 async continuation 不能继续发起属于旧 invocation 的 managed Core 请求。Core 不依赖 JS 自报的剩余时间授权子请求。

这不撤回 CDP 已接受的外部效果，也不自动回滚成功 setup 已交付、仍由插件拥有的 session 或其他持久资源。插件使用正常的生命周期清理这些资源。Host 进程是生命周期边界，不是 JavaScript / 操作系统沙箱。

Host stop / failure 先结束所有 capability receipt 和 managed pending children，随后进入原有最多 1500 ms 的 cleanup。`deactivate(cleanup)` 明确运行在 invocation context 之外，使用 Core 原来的独立绝对 cleanup deadline；旧调用的 abort / Promise 不会为 cleanup 续期或阻止它启动。Job 进程树与 IO worker 的严格退休条件不变。已有 inspection DTO 字段不扩展，`pendingCoreRequests` 仍计数 Host 发起的 CDP 请求。

## Renderer 调用与异步交付

renderer 使用现有 `context.rpc.request(descriptor, method, params)`，并在 manifest 的
renderer `requires` 中声明完整 descriptor。其 `notify` 也进入同一授权与有界执行路径，
但不产生回复。CLI、registry 和 JS SDK 使用逻辑包 ID；Core 内部以 `包ID:host` 区分
Host owner 与 renderer owner，renderer 因而能依赖自己包内的 Host。

前台从真实 target/session、binding、execution context、opaque principal 和 lease 取得
caller，拒绝 payload 自报身份、错误 context 或未声明 capability。入队时捕获租约实际授权
的 provider generation，不会根据较新的 Host observation 升级旧租约。调用与交付阶段继续
检查 caller、document epoch 和原 provider 租约；停止、导航或文档销毁会取消旧调用及尚未
写入的回复，迟到结果不会转交给重建文档或新代次。

桥接器最多保留 16 项调用及待确认回复，每个 renderer binding 最多 4 项；这些限度与 Host
executor 的限度独立生效。调用、Host 内的 managed CDP 子请求、renderer 回复共享原始
绝对 deadline，上限 15 秒；生命周期中的调用还受当前激活/清理阶段更短的 deadline 限制。
原 deadline 耗尽后不会另开一段时间发送错误，renderer 的既有 RPC timeout 负责结束等待。

Host receipt 与 renderer 回复的 CDP ACK 都以非阻塞方式轮询，慢 handler 不占住其他窗口、
binding 或前台控制。激活中的 `await context.rpc.request(...)` 使用同一事件泵；Host 完成会
唤醒本地 CDP activity wait，因此没有额外 CDP 流量时也能继续完成。每次先处理已排队的
target/document 退休事件，再处理 Host 回复。轮询不新增线程，也不伪造 CDP 事件。

组合包 renderer 的 `deactivate()` 可在原 Host 停止前完成受预算限制的 capability 调用；
具体先后顺序和双入口回滚见 [组合包契约](COMBINED_PACKAGES_2026-09-10.md)。已经被远端
接收的调用或回复不能通过本地取消撤回。

## 定向证据

验证入口：`tests/host_capability_bootstrap.test.mjs` 直接运行固定版本 Node bootstrap，覆盖声明、冻结 caller、async token、取消、过期、迟到回复、输出和 endpoint 上限，以及独立 cleanup。`tests/host_capability.rs` 通过实际 managed Node、Core owner 和 isolated fake CDP 验证 combined snapshot、资源归还、取消后的 token 重放、子请求总预算、结果保存上限、Host 并发隔离与代次更替。现有 `host_bootstrap`、`host_runtime`、`host_cleanup`、`plugin_host` 回归覆盖清理与进程所有权。

`tests/renderer_host_capabilities.rs` 的 5 项定向场景验证无额外 CDP 流量的激活唤醒、
null/错误/notification、跨窗口与嵌套 CDP 的前台响应、伪造身份和旧租约拒绝、文档销毁取消、
并发额度及 300 ms 原始预算。此组的 renderer 对端是协议夹具；
[4 项实际 JavaScript 验收](HOST_RENDERER_VM_ACCEPTANCE_2026-09-10.md)另外执行真实
bootstrap、renderer 入口和 managed Host，覆盖共享换代、失败补偿与资源退休。
