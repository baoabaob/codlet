# 必要开发契约

读取上一层 `runtime.json`，里面提供本次运行的 CLI 包装脚本、默认目录，以及随 Core 分发的类型文件和详细文档路径。当前规范位于 `docs/spec/`：包格式看 `plugin-format.md`，完整权限/范围看 `permissions.md`，生命周期管理看 `management.md`，Host 与调用链分别看 `host.md`、`rpc.md`。PowerShell 使用 `& '<cliScript>' -Command @('plugin','list','--json')`，或在新 PowerShell 进程中调用；包装脚本固定本次运行的注册表范围，不要改它来选择另一个注册表。

最小的界面插件：

```json
{"schema":1,"id":"dev.my-plugin","name":"我的插件","version":"0.1.0","renderer":{"entry":"renderer.js","world":"isolated"},"permissions":["ui.dom"]}
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

后台计算使用 `host: {"entry":"host.cjs","mode":"sdk"}`，通过受限入口访问标准服务，不要求完整原始 Host 权限。确需 Node 内置模块时使用 `mode:"node"` 并声明 `host.raw`。旧省略 mode 的入口保留 `host.process` 授权兼容。SDK 模式是可信代码执行边界，不是恶意代码的 OS 沙箱。无需后台功能时不要添加 Host 入口。

保存设置、凭据、读写文件、文件选择框、订阅事件、后台任务、流式子程序、代理配置、通知、剪贴板和指定全局快捷键，先查 `types/core-services.d.ts` 和 `docs/spec/services.md`。它们通过 `context.services` 直接调用 Core，纯 Renderer 插件也可使用；声明 Runtime `codlet.core.services@1` 依赖和对应的独立权限，不借用 `runtime.manage`，也不为存储配置添加空 Host。文件写入需要单独声明 `host.fs.write`，不能把只读授权当作写权限。GUI 的统一授权或 CLI `--client-permissions` 使用系统用户权限，无需另配访问范围；已有旧限域授权则保留其范围。凭据使用系统存储和 origin 绑定引用，默认不把密钥放进普通配置。对用户按实际用途解释本次新增权限，保留既有确认流程。

分类使用顶层可选 `tags`，例如 `"tags":["UI","Enhancement"]`。推荐 `UI`、`Adapter`、`Tool`、`Enhancement`，也允许自定义。名称不做 i18n，不包含界面自动绘制的 `#`；最多 8 个不区分大小写的唯一标签，每个 1–32 个字母、数字、连字符或下划线。标签不授予权限，也不声明依赖，不要根据标签推断插件能力。旧版 Core 可能不支持该字段，以运行时提供的类型和 `plugin preview` 结果为准。

执行清单写在 `codlet.json`。发布元数据另写插件根目录的可选文件 `codlet-package.json`，例如：

```json
{"schema":1,"runtimeApi":1,"sdk":{"api":1}}
```

`runtimeApi`、`sdk`、`platforms` 和 `verification` 属于 `codlet-package.json`；放入 `codlet.json` 会被未知字段校验拒绝。可在这个发布元数据文件的 `sdk.capabilities` 中列出精确能力。标准 SDK 插件无需重复列举 OS。旧 `platforms` 和明确的特殊功能平台限制仍保留并生效。`verification` 分开记录作者提供的自动/实机测试证据；SDK 匹配不代表所有能力当前可用，也不代表未测试的平台已验收。完整格式见 [插件格式](../docs/spec/plugin-format.md)。

多语言使用运行时 `context.i18n` 和 manifest 的 `i18n` 元数据，按 `types/renderer.d.ts` 中的实际接口实现。日期、数字等显示也随所选语言格式化；技术标识保持稳定。用户只选单语言时不自动扩大翻译范围。

依赖使用清单中的精确能力描述 `{name, api, scope}`。Renderer 通过 `context.rpc.request(capability, method, params, options)` 调用；依赖放在 `requires`，所提供能力放在 `provides`。组合插件的顶层声明属于 Renderer，Host 的声明在 `host.requires` / `host.provides`。单纯调用一个适配能力不自动需要所有底层权限。

| 权限 | 向用户解释的范围 |
| --- | --- |
| ui.dom | 使用标准界面 SDK；共享 Renderer 不是 DOM 安全沙箱 |
| ui.nativeDom | 直接依赖 Native 私有 DOM，属声明审核，作者维护该功能兼容 |
| ui.mainWorld | 进入客户端本身的 JavaScript 环境，能接触其页面状态 |
| host.raw | 显式使用完整 Node Host 环境；作者维护该功能兼容 |
| host.process.spawn | 通过代理启动明确选定的程序；必须授权可执行文件、工作目录和环境键 |
| host.fs | 通过文件代理读取明确允许的目录 |
| host.network | 通过网络代理访问明确允许的网址来源 |
| host.system | 查询基本系统信息 |
| cdp.raw | 使用底层浏览器调试接口，作用面很广，优先考虑适配层 |
| runtime.manage | 管理其他 Codlet 插件及权限，仅管理功能才需要 |

安装流程：`plugin preview <source-directory> --json`；按已授权范围 `plugin add <source-directory> --trust --grant <permission> ...`，要求启用时加 `--enable`。Core 将插件复制到 packages；源码保留在独立项目目录。修改源码后先构建，再用 `plugin add <source-directory> --update --trust --grant <permission> ... [--enable] --json` 更新安装副本，保留原启停状态和授权策略。`plugin reload <id> --json` 只重启安装副本。停用用 `plugin disable <id> --json`；不确定的结果通过 `plugin operation <receipt> --json` 查询。

客户端能力优先使用 `context.codex`，完整接口见 `types/codex.d.ts` 与 `docs/spec/codex.md`。保留精确 requires 声明，Core 内部如何使用主世界/CDP 不会自动转授给消费者。当前本地回调/Native DOM 句柄需要主世界的功能仍明确声明 `ui.mainWorld`，不要仅删权限字段就声称隔离。

需要重载恢复时导出 `saveState(context)` 返回 `{schema:1,value:纯JSON}`，以及 `restoreState(snapshot,context)`。每份最多 256 KiB；不保存 DOM、闭包、Promise、凭据或原生草稿。`context.restoringState` 为 true 时不得自动重放写入。保存钩子只计算状态；更新先关闭新请求 admission 并等待已接收请求，保存失败保留旧实例。未声明钩子的旧插件仍可重载，但不承诺恢复任意内存状态。

涉及实际网络请求/响应或 API 接入时，先读 `docs/spec/traffic.md` 和 `types/host.d.ts`。`context.traffic.registerInterceptor` 为已授权 Host 提供 HTTP(S)/SSE 与 WS/WSS 拦截；`traffic.intercept` 只作用于明确授权的来源，敏感头与改换来源另需 `traffic.sensitiveHeaders`、`traffic.redirect`。优先使用 Core 的统一 Codex 语义，注册始终保留当前消费者身份。正常启动预先准备桥接，实际入口是否已附接以运行时探针为准；未成功准备的入口不能靠启用插件取得早期注入。不能把引擎正在监听说成全客户端均已验证。

按任务分流优先使用 Core 已验证的会话元数据，在 Host 拦截器中选择上游和改写请求；WS 握手、预热和续接需要维持同一任务的状态，不能把旧服务的 `previous_response_id` 随意交给另一服务。若还要改变后端自身的模型配置或使用无官方账号的自建 provider，在新建/恢复任务前使用 `context.codex.configuration.register`，不修改用户全局配置。按任务选择每次实际提交的模型时，额外注册 `appliesAt: ['turn.start']` 的同一通用回调，依据 `draft.threadId` 返回 `{model}`；turn 阶段不能改变 provider。旧 `codex.backend.transport` / `registerThreadTransport` 已移除，不再使用。

`context.traffic.openChannel` 是保留的通用 HTTP/SSE/WS 本地服务原语，不是透明接管的前置条件。编写启动适配层时才查看 `codlet.client.launch@1` 的额外 Host 阶段及 `cdp.raw` 权限；普通拦截插件不必自己实现启动注入。配置隔离、一次性流、取消和协议覆盖按当前规范处理，不为捕获流量关闭 TLS 校验或修改系统代理/根证书。

提交文本拦截、页面 CDP 和实际模型网络通道是不同范围。选服务、重试和恢复是插件策略，不是 Core 默认行为；已加载任务和现有连接是否能切换，以 Core 的实际兼容探针为准。
