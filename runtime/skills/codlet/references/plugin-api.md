# 必要开发契约

读取上一层 `runtime.json`，里面提供本次运行的 CLI 包装脚本、默认目录，以及随 Core 分发的类型文件和详细文档路径。当前规范位于 `docs/spec/`：包格式看 `plugin-format.md`，完整权限/范围看 `permissions.md`，生命周期管理看 `management.md`，Host 与调用链分别看 `host.md`、`rpc.md`。PowerShell 使用 `& '<cliScript>' -Command @('plugin','list','--json')`，或在新 PowerShell 进程中调用；包装脚本固定本次运行的注册表范围，不要改它来选择另一个注册表。

最小的界面插件：

```json
{"schema":1,"id":"dev.my-plugin","name":"用户确认的名字","version":"0.1.0","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom"]}
```

```js
let cleanup;
module.exports = {
  activate(context) {
    cleanup?.();
    const node = document.createElement('div');
    document.body.append(node);
    cleanup = () => node.remove();
    context.onDeactivate(cleanup);
  },
  deactivate() { cleanup?.(); cleanup = undefined; }
};
```

后台入口为 `host: {"entry":"host.cjs"}`，需要 `host.process`。Host 是以当前用户身份运行的 Node 代码，Core 的授权检查并不是操作系统沙箱。无需后台功能时不要添加 Host 入口。

保存设置、凭据、读写文件、文件选择框、订阅事件、后台任务、流式子程序、代理配置、通知、剪贴板和指定全局快捷键，先查 `types/core-services.d.ts` 和 `docs/spec/services.md`。它们通过 `context.services` 直接调用 Core，纯 Renderer 插件也可使用；声明 Runtime `codlet.core.services@1` 依赖和对应的独立权限，不借用 `runtime.manage`，也不为存储配置添加空 Host。文件写入需要单独的 `host.fs.write` 与 writeRoots，不能把只读授权当作写权限。凭据使用系统存储和 origin 绑定引用，默认不把密钥放进普通配置。对用户按实际用途解释本次新增权限，保留既有确认流程。

分类使用顶层可选 `tags`，例如 `"tags":["UI","Enhancement"]`。推荐 `UI`、`Adapter`、`Tool`、`Enhancement`，也允许自定义。名称不做 i18n，不包含界面自动绘制的 `#`；最多 8 个不区分大小写的唯一标签，每个 1–32 个字母、数字、连字符或下划线。标签不授予权限，也不声明依赖，不要根据标签推断插件能力。旧版 Core 可能不支持该字段，以运行时提供的类型和 `plugin preview` 结果为准。

平台与语言按用户已确认的范围实现。发布元数据 `codlet-package.json` 的 `platforms` 可声明系统/架构；省略表示未知，`any` 是作者明确的跨平台声明，不是默认值。目标范围需要同时满足 Core、插件自身限制、所需 Adapter 能力及传递依赖，静态检查不能证明任意 JavaScript 都跨平台。当前 Core 的 GitHub 包检查会拦截明确不匹配的平台；不要声称尚未实现的自动继承已经由 Core 强制执行。

多语言使用运行时 `context.i18n` 和 manifest 的 `i18n` 元数据，按 `types/renderer.d.ts` 中的实际接口实现。日期、数字等显示也随所选语言格式化；技术标识保持稳定。用户只选单语言时不自动扩大翻译范围。

依赖使用清单中的精确能力描述 `{name, api, scope}`。Renderer 通过 `context.rpc.request(capability, method, params, options)` 调用；依赖放在 `requires`，所提供能力放在 `provides`。组合插件的顶层声明属于 Renderer，Host 的声明在 `host.requires` / `host.provides`。单纯调用一个适配能力不自动需要所有底层权限。

| 权限 | 向用户解释的范围 |
| --- | --- |
| ui.dom | 读取和改变客户端页面上的元素 |
| ui.mainWorld | 进入客户端本身的 JavaScript 环境，能接触其页面状态 |
| host.process | 运行后台 Node 代码；启动受管子程序还需指定可执行文件 |
| host.fs | 通过文件代理读取明确允许的目录 |
| host.network | 通过网络代理访问明确允许的网址来源 |
| host.system | 查询基本系统信息 |
| cdp.raw | 使用底层浏览器调试接口，作用面很广，优先考虑适配层 |
| runtime.manage | 管理其他 Codlet 插件及权限，仅管理功能才需要 |

安装流程：`plugin preview <directory> --json`；确认后 `plugin add <directory> --trust --grant <permission> ...`，只有同意启用时加 `--enable`。目录放在 packages 下面不会自动加载，必须通过 Core 注册，不要直接编辑 config.json。源目录编辑后用 `plugin reload <id> --json`，停用用 `plugin disable <id> --json`。不确定的结果通过 `plugin operation <receipt> --json` 查询。

官方适配层的确切能力、方法和限制以随运行附带的 `types` 与清单为准，先检查实际可用版本。依赖官方适配层仍需在技能工作流中让用户选择；没有对应能力时才讨论直接操作底层接口的代价。

涉及实际网络请求/响应或 API 接入时，先读 `docs/spec/traffic.md` 和 `types/host.d.ts`。`context.traffic.registerInterceptor` 为已授权 Host 提供 HTTP(S)/SSE 与 WS/WSS 拦截；`traffic.intercept` 只作用于明确授权的来源，敏感头与改换来源另需 `traffic.sensitiveHeaders`、`traffic.redirect`。优先使用已安装且兼容的官方 Desktop Adapter 抽象，注册始终保留当前消费者身份。首次启用接管插件需要重启客户端，运行时探针会报告实际入口是否已附接；不能把 worker 正在监听说成全客户端均已验证。

按任务分流优先使用官方 Adapter 已验证的会话元数据，在 Host 拦截器中选择上游和改写请求；WS 握手、预热和续接需要维持同一任务的状态，不能把旧服务的 `previous_response_id` 随意交给另一服务。若还要改变后端自身的模型配置或使用无官方账号的自建 provider，在新建/恢复任务前使用 `codex.backend.write@1` 的 `registerThreadConfiguration`，不修改用户全局配置。旧 `codex.backend.transport` / `registerThreadTransport` 已移除，不再使用。

`context.traffic.openChannel` 是保留的通用 HTTP/SSE/WS 本地服务原语，不是透明接管的前置条件。编写启动适配层时才查看 `codlet.client.launch@1` 的额外 Host 阶段及 `cdp.raw` 权限；普通拦截插件不必自己实现启动注入。配置隔离、一次性流、取消和协议覆盖按当前规范处理，不为捕获流量关闭 TLS 校验或修改系统代理/根证书。

提交文本拦截、页面 CDP 和实际模型网络通道是不同范围。选服务、重试和恢复是插件策略，不是 Core 默认行为；已加载任务和现有连接是否能切换，以 Adapter 的实际兼容探针为准。
