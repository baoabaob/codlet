# 必要开发契约

读取上一层 `runtime.json`，里面提供本次运行的 CLI 包装脚本、默认目录，以及随 Core 分发的类型文件和详细文档路径。PowerShell 使用 `& '<cliScript>' -Command @('plugin','list','--json')`，或在新 PowerShell 进程中调用；包装脚本固定本次运行的注册表范围，不要改它来选择另一个注册表。

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

分类使用顶层可选 `tags`，例如 `"tags":["UI","Enhancement"]`。推荐 `UI`、`Adapter`、`Tool`、`Enhancement`，也允许自定义。名称不做 i18n，不包含界面自动绘制的 `#`；最多 8 个不区分大小写的唯一标签，每个 1–32 个字母、数字、连字符或下划线。标签不授予权限，也不声明依赖，不要根据标签推断插件能力。旧版 Core 可能不支持该字段，以运行时提供的类型和 `plugin preview` 结果为准。

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

涉及实际网络请求/响应或 API 接入时，先查 `types/host.d.ts` 的 `context.traffic.openChannel` 和 `types/codex-desktop.d.ts` 的 `codex.backend.transport@1`。Core 提供 HTTP(S)/SSE 与 WS/WSS 的受管通道，Adapter 使用统一 `{endpoint, protocols}` 描述接到客户端支持的新建/恢复线程入口。详细流、权限、生效时机与示例在 `docs/TRAFFIC_CHANNELS.md`（由 `runtime.json.docsDirectory` 定位）；按需读取，不把全部网络细节加进普通插件流程。

提交文本拦截、页面 CDP 和实际模型网络通道是不同范围。选服务、重试和恢复是插件策略，不是 Core 默认行为；已加载任务和现有连接是否能切换，以 Adapter 的实际兼容探针为准。
