# 插件流量通道

Core 的 `context.traffic` 为 Host 插件提供显式接入的 HTTP(S)、流式 HTTP/SSE 和 WS/WSS 通道。官方 Desktop Adapter 的 `codex.backend.transport@1` 将该通道接入支持的客户端线程请求；插件不需要编写客户端私有 provider 配置。

此能力只处理流经已接入通道的请求。`cdp.raw` 的页面网络、Desktop 内部 RPC、官方登录服务和未接入线程的网络是不同范围。Core 不安装根证书、不改变系统代理，也不把一次成功的模型接入宣称为全客户端网络接管。

## Core Host API

类型以 `types/host.d.ts` 为准。Host 需声明并获授 `host.process`、`host.network`；每个上游 origin 还需在注册时获授 `--network-origin`。`ws://` 对应同一 `http://` origin，`wss://` 对应 `https://` origin。

```js
const channel = await context.traffic.openChannel({}, {
  async http(request, exchange) {
    const response = await exchange.forward({
      url: upstreamOrigin + request.path,
      method: request.method,
      headers: [['content-type', 'application/json']],
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body
    });
    return { status: response.status, headers: response.headers, body: response.body };
  },
  async webSocket(request, exchange) {
    await exchange.forward({
      url: upstreamWebSocketOrigin + request.path,
      protocols: request.protocols,
      clientToServer: frame => frame,
      serverToClient: frame => frame
    });
  }
});
```

`upstreamOrigin` 及 `upstreamWebSocketOrigin` 是插件选定并获准的目的地。只提供 HTTP 或 WS handler 也有效，`channel.protocols` 如实声明支持的协议。`channel.endpoint` 是动态端口和随机私有路径组成的 loopback URL；它随 Host generation 失效，不应长期保存、打印或共享。

HTTP request 包含 `id`、`method`、去掉私有前缀后的 `path`、头部数组和一次性 body 流。插件可在转发前修改方法、目的地址、头和正文，也可直接返回自己的 `{status, headers, body}`。上游响应同样可修改；重复的头部（例如 Set-Cookie）用数组保留。SSE 是 HTTP 字节流，不承诺一次 chunk 就是一条完整事件。

WS handler 在上游握手完成后桥接下游。`clientToServer` 与 `serverToClient` 分别接收 `{data, binary}`，可以返回原消息、替换文本/字节、替换 frame，或用 `null` 丢弃。每方向按顺序处理。业务事件解析、协议转换、错误修复或重新选择服务都属于插件，Core 不把消息内容解释成模型回合或工具结果。

`forward` 的每次调用都先经 Core 验证当前代次、权限和上游 origin。它不会自动复制入站认证信息，不跟随重定向，也没有默认重试或重连。HTTP 的默认派发额度为一次；需要显式多次尝试的插件可设置有界 `maxForwardAttempts`，自己消费或取消前一次响应，再决定下一次派发。一次性请求 body 不能直接重用，需要插件按自己的预算重建。

通道支持请求/响应大小、并发、handler 决策时间和 WS 消息/队列的界限。长流不占用一条永不结束的 Core JSON RPC；实际 socket 由当前 Host 生命周期管理。撤权、禁用、重载、Host 退出和通道 `close()` 会取消所拥有的网络资源。已经发到远端的请求不因此证明远端没有副作用。

TLS 上游使用正常证书验证，不提供忽略证书错误的通道开关。CONNECT 隧道及全局 TLS 劫持不属于该 API。Host 本来就有用户级 Node 执行权限，受管 API 的边界不等于 OS 沙箱。

## Adapter 的统一接入

renderer 需要 `ui.mainWorld` 及精确的 capability requirement：

```js
const capability = {name: 'codex.backend.transport', api: 1, scope: 'target'};
const support = await context.rpc.request(capability, 'probe', {});
if (!support.available) throw new Error(support.unavailable?.message);
const access = await context.rpc.request(capability, 'getApi', {});
const handle = globalThis[Symbol.for(access.symbol)].registerThreadTransport(
  context, access.ticket, {id: 'my-channel'},
  async (draft, {signal}) => {
    // 从本插件的 Host capability 取得当前通道；普通插件决定匹配哪些任务
    const {channel} = await context.rpc.request(ownHostCapability, 'channel', {}, {signal});
    return {channel};
  }
);
```

返回值的 `channel` 只需包含 `{endpoint, protocols}`，也可返回完整 Core channel 对象。可选 `path` 默认为 `/v1`，可选 `model` 指定模型；不返回值则保持当前 Native 请求。Adapter 从协议声明自动设置 HTTP/WS 客户端参数，不要求作者处理不同底层配置字段。仅 WS 的通道不提供 HTTP fallback；如果客户端确实尝试未声明的协议，应得到真实失败。

`draft` 含 `source`（`thread.start` 或 `thread.resume`）、`threadId`、`cwd`、`model` 和 `provider`。这些属于 Adapter；Core 不认识任务、供应商或模型。新建/恢复时的配置通过当前 Desktop 的原生连接发送，不写入全局配置，不另起生产后端。

回调使用与其他 Adapter callback 相同的一次性、代次绑定 ticket。单回调最多 2 秒，整次选择最多 5 秒，最多 32 个注册及 16 个待处理请求；`handle.setEnabled(false)`、disposer 和插件注销会使未发出的选择退场。多个回调同时返回通道是明确冲突，不静默覆盖，也不向两个服务重复派发。诊断不包含端点私有路径、正文或 callback 的任意错误文字。

接入发生在新建或恢复线程时。已有加载任务、进行中的回合和已建立的 WS 不会因为更新注册项自动迁移；停用通道也不会改写已配置任务。需要动态切源的插件应围绕这些生效时机设计自己的通道和重建策略，不把“已修改设置”显示成“当前请求已切换”。

## 代码与验证

最小组合插件见 `examples/http-channel`：缺少设置文件时不接入任务，只处理明确选定的工作目录，并过滤入站认证。它是接口示例，不是完整网关产品。

测试分别覆盖 Core 的真实本机 socket、授权/生命周期、Adapter 的同连接请求改写，以及隔离官方 AppServer 的 HTTP/WS 真实模型请求。具体已通过记录和平台边界见 `TRAFFIC_INTERCEPTION_PLAN_2026-09-20.md`；fixture、官方 CLI 和真实桌面 UI 验收不能互相替代。
