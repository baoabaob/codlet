# 透明流量接管：进程入口原型与真实后端验证

本轮已经实现并验证进程范围 HTTP/HTTPS、SSE、WS/WSS 接入基础设施，真实官方后端的请求和响应能够经过拦截器。**尚未完成 Codlet 产品启动链的自动接入，不能宣称安装插件后官方桌面全部流量已生效。** 新工厂保持私有，未发布为 `ctx.host.traffic` 新能力。

Core 分支 `codex/transparent-traffic` 已吸收 `f6a7c36` 的内存优化；官方插件同名分支已吸收 `fea9796`。未改动原任务的实验配置、注册表或客户端进程，未打包发布。

## T0：固定构建与实际出口

| 对象 | 固定身份 |
|---|---|
| 官方 CLI / app-server 二进制 | `0.155.0-alpha.9.2` |
| 二进制 SHA-256 | `bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226` |
| Windows 桌面包 / 内部版本 | `26.915.4065.0` / `26.915.31945` |
| `app.asar` SHA-256 | `b8aeb817cd1ee6ef50efe8a97985d3be41de89688a5addfe0a444e1e52348096` |
| 只读桌面源码定位 | `.vite/build/main-LM8MUIFp.js`，`early-bootstrap.js` 为包入口 |

旧 `8d32abc` 源码仅用于构造假设；以下网络结论来自上述实际二进制。

| 进程 / 功能 | 协议与接入点 | 证据和界限 |
|---|---|---|
| 官方 `exec` 模型请求 | 子进程 HTTP(S) proxy 环境变量 | 原目的地址保持；受控 HTTP、HTTPS、WS、WSS 均完成，无 WebSocket 到 HTTP 的假通过 |
| 官方 `exec` 内置 provider | 同一入口 | API-key / ChatGPT **人工凭据夹具**通过，没有添加自定义 provider；此项本身不是真实 OAuth 证据 |
| 官方 `exec` 真实账户 | HTTPS / WSS | 有效 ChatGPT access token、原系统上游代理、TLS 校验保持，真实模型列表 200 和模型响应已收到 |
| 官方 `app-server` | 同一入口，stdio 仅承担管理 RPC | 实际 `account/read` 确认 ChatGPT；`thread/start` 返回 `modelProvider=openai`；第二个 turn 仍使用同一个已加载 thread |
| `app-server` 已建立的 WSS | 连接建立时固定拦截快照 | 只启用处理器不会追溯修改旧连接。显式断开本入口拥有的连接后，新连接经过新处理器；Core 不重放请求 |
| 桌面附件 / 应用服务 | Electron `applicationNetwork.fetch/request`、`net.fetch`、`session.fetch` | 当前桌面源码显示上传进度路径使用独立网络栈；未验证其进程代理和 CA 接入，不能由后端结果外推 |
| macOS | 通用网络实现与环境准备逻辑 | 仅跨平台代码及环境合并单测；没有 macOS 真机或官方二进制证据，Adapter 拒绝未验证构建 |

`respect_system_proxy=true` 的受控 HTTP 试验没有到达指定模型代理，返回 502；默认配置可达。不能照搬旧源码测试强制打开这个开关。Adapter 对调用方明确报告的启用状态返回不可用，不擅自关闭原策略。真实 app-server 的配置读取未返回显式启用值。

TLS 使用独立 CA 签发的 `CA:FALSE` 服务器叶证书；直接把 CA 证书当叶证书的初始夹具失败，已修正。未信任 CA 的后端到达 CONNECT 后没有产生应用请求；可信组使用相同入口成功。负例由驱动在 5 秒终止后端的连接重试，不把该终止称为成功对话。

## T1：已实现的 Core 基础设施

- `runtime/host-traffic.cjs` 新增**启动管理方私有**的 `openProcessIngress`。复用现有一次性字节流、背压、HTTP 转发与 WS 桥；现有插件 `api` 仍只暴露显式 channel 接口。
- 监听 `127.0.0.1` 的随机端口，256-bit 随机代理凭据；绝对形式 HTTP 请求或认证 CONNECT 保留原目的地址。CONNECT 内的 Host 不能越过原 authority；嵌套 CONNECT 被拒绝。
- HTTPS/WSS 解密与明文 HTTP/WS CONNECT 分开处理。同一 authority 同时声明 HTTP 和 HTTPS 的歧义配置拒绝接入。只协商 HTTP/1.1；不声称 HTTP/2、HTTP/3、QUIC 覆盖。
- 复用既有网络 profile 的上游代理 / 附加 CA / 凭据引用。阻止入口代理递归指向自身。所有上游 TLS，包括 HTTPS 代理，显式要求证书校验，继承的 `NODE_TLS_REJECT_UNAUTHORIZED=0` 也不能取消校验。
- 改换 origin 会丢弃认证、Cookie、未知厂商头及原 WS 子协议，仅保留 `accept` / `content-type` / `content-encoding`。另一个 origin 的凭据必须通过其自身授权引用提供。
- `traffic-interceptors.cjs` 提供 32 个有界注册槽。按优先级、插件 ID、注册顺序执行请求处理；第一个阻止或合成结果结束后续请求处理；响应逆序执行。重写不会扩大后续插件观察范围。
- `intercept`、`sensitiveHeaders`、`redirect` 分开授权。无敏感头权限时只暴露有限的表示层头；重写普通头时保留被隐藏的原头，禁止注入敏感头。响应上下文区分真实上游和合成响应。
- 每个拥有者绑定代次和 abort signal。禁用、代次退役、决策超时、撤权回调失败会停止所属处理；WS 每帧重查授权。沿用并发、正文、消息、队列字节和帧数限额，另加请求 / 隧道硬生命周期。
- 私有 `disconnect()` 只断开该入口拥有的连接，保留监听器及地址。用于明确协调过的切换，**会中断连接，不承诺无损迁移**。
- `process-traffic-environment.cjs` 生成子进程专用 CA bundle，合并所选原信任文件，保留原环境快照和 NO_PROXY，不改全局代理 / 根证书。状态和日志不包含代理密码、正文或私有查询参数。

限制：JS 原型的 `authorize` 和拥有者信号由验证驱动提供，**还没有接到 Native 权限仓库、实际插件 Host IPC、Windows Job / macOS 进程拥有者**。单测中的撤权 / 代次清理不能冒充已完成原生插件卸载验收。入口当前对声明范围外的 origin 拒绝接入，产品化前还需保留未拦截业务的原路转发和工具进程环境隔离。

## T2 / T3：官方 Adapter 与公开接口边界

官方插件库的 `host/codex-traffic.cjs` 已实现：

1. 当前 Windows 二进制哈希核验，构建漂移失败。
2. `CODEX_CA_CERTIFICATE` 优先、`SSL_CERT_FILE` 回退的官方信任语义，委托 Core 合并子进程信任。
3. Responses / 已核实模型列表的语义分类；thread、model 关联未知时返回 null。
4. 有界 identity / gzip / deflate / br / zstd JSON 读取和重写；移除已失效的编码、长度、摘要头。真实 HTTP 模型请求确认使用 zstd。

该模块尚未进入分发 manifest，也没有伪造 `registerInterceptor` 公共能力。`probeCodexTraffic` 仍返回 `available:false`、`officialOAuth:false`、`existingLoadedThreads:false`，原因是产品启动链尚未附接。真实后端驱动证据与可供安装使用的产品能力严格分开。

旧接口使用方仍有 `examples/http-channel/{host,renderer}.js`、`types/{host,codex-desktop}.d.ts`、官方 Adapter 的 `frontend/src/desktop/transport.js` 与相应回归测试。它们仍是显式 provider 通道，不能用其测试充当透明接管。新验证驱动已经使用直接拦截注册；现有使用方在 Native 自动接入完成前不删除、不强行迁移。运行时 Codlet skill 也不宣传尚不存在的公开入口。

## T4：真实链路结果

完整的计数、构建身份和受控性能数据见 [JSON 证据](TRANSPARENT_TRAFFIC_EVIDENCE_2026-09-22.json)。所有 live 试验使用自己的配置目录、一次性 CA 和当前有效登录快照；禁止刷新令牌，结束后删除快照、会话目录及私钥。

注意：用户日常 CLI 配置选择了自定义 provider。本轮 live 驱动使用**独立的官方内置 provider 配置**，没有注入另一个 provider，也没有加载或改写日常配置。因此它证明官方账户及内置 provider 的真实后端链路，不证明日常自定义 provider 或用户原桌面任务已经接入。

| 验证 | 结果 |
|---|---|
| 真实 WSS 请求与响应 | `exec` 完成；认证头保留；请求改写成功；真实上游消息返回 |
| 真实 HTTPS / SSE | 明确阻止 WS 以触发官方 HTTP 回退；解码并改写 zstd 请求后正常完成。此过程有 WS 拒绝 / 回退事件，不称为无损切换 |
| 历史任务 | 先在独立配置创建任务，再启用拦截器并从磁盘恢复；两次 turn 均完成 |
| app-server 已加载任务 | 同一 app-server、同一已加载 thread；第一次 turn 在处理器禁用时完成；启用后断开旧入口连接，再提交第二个 turn，无 provider 替换 |
| app-server 响应修改 | 第二次 turn 捕获 1 条认证模型请求、12 条服务端消息；修改 3 条响应消息，后端输出检测到验证标记；两次 turn 完成，退出码 0 |
| 模型列表 | 真实 200，读取到 7 个可用模型；不保留原始列表正文 |
| 改换上游、合成、阻止、文本 / 二进制、队列超限 | 受控本地协议测试通过；不是全部真实云端场景验收 |
| 生命周期 | JS 拥有者 / 超时 / 取消测试通过；真实驱动退出后 `registered=0, active=0`。原生插件崩溃及完整 RSS / 私有内存回收仍未验收 |
| 桌面 UI、登录刷新、附件、macOS | 未完成真实验收 |

验证也留存了失败原因：过时模型 `gpt-5.4` 被上游拒绝；早期驱动没有解码 zstd；旧 WSS 连接不会自动接收后来启用的处理器；一次驱动断言把已成功完成的 HTTP 重编码误判为“没有修改”。修正后的 HTTP 恢复和 app-server 响应改写均再次完成。

使用 Node 24.18 执行全量 JS 回归时，既有 `bootstrap_idle` 测试触发 V8 `DisallowJavascriptExecutionScope` 原生崩溃。相同代码改用项目配套 Node 24.21 后全量通过；最终计数保存在 JSON。Adapter 的新增和既有桌面 / transport 相关回归共 38 项通过。本轮没有修改 Rust 源码。

小型 Node HTTP 实验为每组 40 次、单并发、32 KiB 正文：原路径、启用无处理器、透传处理器、正文改写，p50 分别为 1.210 / 2.631 / 2.770 / 2.603 ms。这些是合成 JS 测量，不是官方桌面、完整插件 IPC 或原生私有内存结论；队列峰值未采集，不能补成 0。

## 可复现入口与剩余工作

- `scripts/probe-official-traffic.mjs <CLI> --core --adapter <官方插件 host/codex-traffic.cjs>`：仅人工凭据与本地响应；另有独立代理对照模式。
- `scripts/verify-live-backend-traffic.mjs <CLI> <auth.json> <Adapter> --run-live`：显式 live 入口，默认 exec；`--http-only --resume` 验证 HTTP 回退与磁盘历史；`--app-server --resume --rewrite-response` 验证已加载任务及真实响应改写。
- `scripts/benchmark-process-traffic.mjs`：配合 `node --expose-gc`，仅合成 Node HTTP 实验。

下一阶段必须完成：Native 启动前的长期入口拥有者、权限及插件代次桥接、短管理 RPC + 有界跨进程数据通道、当前 Desktop Electron 网络栈接入、原代理 / NO_PROXY / 企业信任的完整预检与继承、未匹配流量策略、公开 SDK / UI / skill 迁移，以及 Windows Desktop 和 macOS 真机 T4。真实后端结果证明接入路线可行，**不替代这些尚未完成的产品工作**。
