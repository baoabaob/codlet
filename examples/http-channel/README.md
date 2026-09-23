# HTTP、SSE 与 WebSocket 通道示例

本示例展示 Core `context.traffic.openChannel` 和官方 `codex.backend.write@1` 通用任务配置接口的组合。它适用于插件提供自己的本地服务，不是透明流量接管的必需步骤，也不会自动安装/启用。

Host 创建带随机私有路径的 loopback 端点，HTTP(S)/SSE 和 WS/WSS 通过 `exchange.forward` 转发。renderer 使用 `registerThreadConfiguration` 返回本地 provider 的 `baseUrl` 与 `supportsWebSockets`；Adapter 设置这一任务的临时 provider 配置，保留无官方账号使用自建服务的能力。

## 配置

在示例目录自行创建 `settings.json`：

```json
{
  "origin": "http://127.0.0.1:8765",
  "cwd": "C:/work/traffic-fixture"
}
```

`origin` 必须是自己准备的、提供 Responses HTTP 与 WebSocket API 的服务。`cwd` 必须与准备接入的任务工作目录完全一致。没有设置文件时示例不接入任何任务。macOS 使用自己的绝对路径。配置中不放官方登录凭据；样例不会转发入站 Authorization/Cookie。

注册时明确授予 `host.process`、`host.network`、`ui.mainWorld`，并用 `--network-origin http://127.0.0.1:8765` 授权同一 origin。`ws://` 使用对应 `http://` origin 授权，`wss://` 对应 `https://`。还需启用官方 Desktop Adapter。通常的注册步骤如下；路径和 origin 换成实际值：

```text
codlet plugin add <本示例目录> --trust --grant host.process --grant host.network --grant ui.mainWorld --network-origin http://127.0.0.1:8765
codlet plugin enable example.http-channel
```

新建或恢复匹配工作目录的任务时，Adapter 在同一 Native 请求中附加临时 provider 配置，不修改用户全局配置。已经加载的任务和正在进行的回合不会自动迁移。停用示例会关闭它拥有的通道；已接入任务不能继续使用关闭的端点，需由插件/用户按明确的恢复流程重新接入。

## 扩展位置

- HTTP：在转发前改写 URL、方法、头或字节流；返回前改写状态、头和 body。SSE 的事件边界可能跨网络 chunk，按协议处理时需自行解析
- WS：给 `exchange.forward` 传 `clientToServer`、`serverToClient`，分别返回修改后的文本/二进制消息；返回 `null` 可丢弃消息
- 作用范围：renderer 的 `draft` 包含新建/恢复来源、threadId、cwd、model、provider，可由普通插件决定是否接入
- 策略：默认只允许一次 forward；需要多次 HTTP 尝试时显式配置 maxForwardAttempts，并由插件消费或取消前一响应再发起下一次；Core 不自动重试或重连

通道描述含私有路径，勿写入日志或长期保存。可用范围、取消/关闭限制及测试边界见[流量契约](../../docs/spec/traffic.md)和 [Host 类型](../../types/host.d.ts)。

只需要拦截现有模型请求时，直接使用 Host `context.traffic.registerInterceptor` 及官方 Adapter 的会话元数据；无需创建通道或更改 provider。旧 `codex.backend.transport` / `registerThreadTransport` 已由通用任务配置与明文流量源替代。
