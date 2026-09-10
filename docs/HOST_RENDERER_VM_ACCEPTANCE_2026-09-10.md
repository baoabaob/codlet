# Host + renderer JavaScript execution acceptance

`src/cdp/client/host_renderer_vm_tests.rs` 将 production `CdpClient`、`TargetController`、`RendererRuntime`、`HostRuntime` 与 combined package coordinator 接在同一条 NUL JSON CDP 连接上。renderer 侧真正执行 `bundled/runtime/bootstrap.js` 和包内 `renderer.js`；Host 侧由固定版本 Node 的正常 managed Host executor 执行包内 `host.js`。

CDP peer 为 `tests/fixtures/renderer-cdp-peer.cjs`，每个 target / world 使用独立 Node VM context。`Runtime.evaluate` 执行收到的完整 JavaScript，异步 Promise 挂起时继续处理 stdin，`Runtime.addBinding` 安装的函数会发送真实 `Runtime.bindingCalled`。因此 renderer 的 `activate()` 必须等 Host handler 的实际返回值，经 Core 路由和 `__rpcReceive` 交付后才能完成；peer 不会预设或伪造 activation 成功。

验收直接复制 `examples/local-host-renderer-capability` 到临时目录并从显式临时 registry 加载。全部可选 bundled plugin 被禁用，不读取默认用户 registry，也不启动真实 Codex、Chrome 或其他浏览器。

覆盖以下完整流程：

- 从 disabled 状态启用实际 combined example，在两个 `app://-/index.html` target 的独立 renderer world 中等待自己的 Host capability。断言真实返回值、caller 包 ID、generation、target ID 和 document epoch，及 Host 在两个默认 world 中通过 raw CDP 写入的资源标记。
- 修改临时包的两份实际代码，按一个 shared generation reload。断言新 Host 代码和新 renderer 代码产生不同结果、两个 world 采用同一新代次、旧原始 session / 标记被归还。
- 替换一个 target 的 document，销毁旧 VM contexts 与挂起 evaluation，并执行持久 bootstrap script。Core 为新文档重新激活 renderer，caller document epoch 更新，另一个窗口保持原身份。
- 销毁一个仍有未完成 JavaScript Promise evaluation 的 target，确认它收到 context-destroyed 失败，另一个 target 继续实际执行 JavaScript，peer 的 evaluation / context / session 记录同步退休。
- renderer candidate 在实际 Host RPC 后留下局部 global 再抛错；其真实 `deactivate()` 删除该 global，coordinator 停止 candidate 并以同一个新代次恢复之前两份不可变代码。
- Host candidate 先通过真实 raw CDP attach 并写入 global，再在 activate 抛错；独立 cleanup 删除已知标记并 detach，确认资源退休后恢复之前的 Host / renderer 代码。
- disable 完成后检查实际 VM globals、bootstrap active records、bindings、new-document scripts、timers 和 Host raw sessions；同时检查 managed Host 的 process / worker retirement 事实。

检查包含所有已分配的 candidate generation 标记，避免只检查最终活动代次而遗漏失败 candidate 的页面效果；测试自身的 cleanup 计数仅用于断言真实 deactivate 已执行。

peer 只实现 executor 与示例所需的 Target / Page / Runtime 子集，提供 `location` 与只读 `document.URL` / `readyState`，不实现 DOM 节点、布局、渲染、网络、页面权限或 Chromium 的完整错误对象。VM worlds 与真实浏览器隔离世界并不等价；这些测试证明 JavaScript 执行、RPC、身份和生命周期协议，不能替代真实页面兼容性验收。

资源界限：最多 4 个 target、16 个 session、64 个 context、每 session 64 个 binding / script、32 个并行 evaluation、每 context 64 个 timer；JSON frame 最多 1 MiB，trace 保留最近 128 条，stderr 最多 64 KiB，Node heap 限制 128 MiB。同步 VM evaluation 最多 1 秒，异步 evaluation 最多 8 秒，document / target 退休会取消对应的等待并清除 timers。不存在用每次请求新增线程的路径。

测试先调用 `JsRuntime::discover()` 验证仓库 pin 的 executable digest，并持有验证文件；VM peer 路径从相同的 checked-in pin 推导，没有系统 PATH Node 回退。测试专用 unit module 使用父模块私有 `spawn_io`，没有扩大 production CDP constructor API。peer 使用 `CREATE_NO_WINDOW`、明确的 stdin/stdout pipes 和临时 stderr 文件；成功与 panic 路径均由 guard 回收 peer child，`CdpClient::shutdown()` 完成其 IO worker 退休。

运行固定 Node 已部署到 unit-test binary 相邻 `runtime` 目录后的定向验证：

```text
cargo test --lib host_renderer_vm_tests
```

这不是全量 suite，也不会访问正常 Codex 会话。
