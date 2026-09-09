# 统一 JS/TS 插件格式与执行器

日期：2026-09-09。用户确认后替代 `f25b338` 的任意可执行文件 host 入口；仍属于 M2a，
不代表完整 M2 或 M3/M4 已完成。

## 已确认并实现的约定

开发使用 JS 或 TS；TS 在构建时编译为 JS，运行时只加载 `.js` / `.cjs`。一个插件是一份
目录包，包含 `codlet.json`、JS 入口和资源。`host` 与 `renderer` 是运行位置，使用同一套
schema、registry、授信记录和生命周期命名。

```json
{
  "schema": 1,
  "id": "dev.example",
  "version": "0.1.0",
  "host": { "entry": "dist/host.js" },
  "permissions": ["host.process", "cdp.raw"]
}
```

Renderer 使用 `renderer: {"entry":"dist/renderer.js","world":"isolated"}`。两种入口均
导出 CommonJS `activate(context)` 和 `deactivate()`，可返回 Promise。首批继续支持独立
host 或独立 renderer；同包双入口协同与 host 的跨执行器 provides/requires 仍待后续。
这项实现范围不会把两者拆成不同插件格式。

不接受 `host.command`、可执行文件入口、插件选择的 runtime/flags/protocol；不支持原生
Node `.node` 扩展、运行时 TS 转译或自动 npm 安装/安装脚本。纯 JS 依赖与资源可随包提供。
当前使用 CommonJS 输出；ESM 入口尚未列入本版 ABI。

## Codlet 管理的 JS 环境

Core 复用现有进程监督器，创建一个独立 Node 进程执行每个 host JS 实例。统一 bootstrap
由 Codlet 内嵌并启动，负责 JSONL v1、request id/generation、事件分发、ready 握手、abort
与 deactivate；插件不编写 JSONL，也不选择启动程序。

发行目录包含 `codlet.exe` 及 `runtime/node-v24.21.0-win-x64/node.exe`（arm64 对应版本目录）。
版本和 SHA-256 固定在 `runtime/node-runtime.json`，依据 [Node 官方发布摘要](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt)。
加载 host 前检查受管 Node 的摘要，持有其文件句柄防止运行期间替换。缺失或错误的 runtime
在正式 Codex 启动前报告失败，不回退到 PATH、系统 Node 或 Codex 包内的程序。

发行包一次携带 runtime，不要求每个插件安装 Node。源码开发时运行
`scripts/Install-JsRuntime.ps1 -Destination <codlet.exe 所在目录>`；它按固定摘要下载并仅
提取官方 Node 和 LICENSE，也可用 `-ArchivePath` 指定同摘要的离线压缩包。`launch`、
`list` 和 `doctor` 不下载或安装依赖；纯 renderer 会话不需要启动 Node。

执行器传入 `--no-addons`、`--no-experimental-strip-types` 等固定选项，清除继承环境中的
`NODE_*` / `OPENSSL_*` 以及 `ELECTRON_RUN_AS_NODE`，避免预加载脚本、全局模块路径或
外部启动参数改变执行契约。普通环境变量如 PATH 和代理设置继续可用。Node 对原生扩展
加载返回 `ERR_DLOPEN_DISABLED`；该行为依据 [Node CLI 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/cli.html#--no-addons)，
并已通过本版实际 JS 子进程验证。

## 公开 Core 原语

```js
module.exports = {
  async activate(context) {
    const targets = await context.cdp.request('Target.getTargets');
    context.log.info('targets:', targets.targetInfos.length);
  },
  deactivate() {}
};
```

| 接口 | 行为 |
| --- | --- |
| `context.cdp.request(method, params?, options?)` | 原始 CDP 调用；options 可选 sessionId、timeoutMs，成功返回原始 CDP result。无官方方法白名单。 |
| `context.cdp.subscribe(filter, onEvent, onEnd?)` | filter 为 root/all，或 session+sessionId；返回 `{id,unsubscribe()}`，onEvent 收到 `{method,params,sessionId}`。每 host 同时一个订阅。 |
| `context.core.request(method, params, timeoutMs?)` | 通用 Core 请求入口；当前实现 cdp.request/subscribe/unsubscribe，未来原语沿此版本化通道开放。 |
| `context.plugin` | 本实例的 id、version、generation。 |
| `context.root` | 原插件根目录；Node cwd 同该目录。 |
| `context.signal` | 停止时 abort；插件应取消未完成的异步工作。 |
| `context.log` / `console` | 输出到 stderr，不污染 JSONL stdout。 |

`host.process` 授权运行统一 Node 中的普通用户 JS，`cdp.raw` 授权经 Core 路由的 CDP 调用。
均需声明且显式获授；多余 grant 不扩展 manifest 的有效权限。错误保留 code/message/data，
例如 permission_denied、request_timeout、cdp_error。关闭官方功能插件后，这些接口仍然
可用；纯 host 启动不执行官方 renderer URL/target 筛选。用户插件自行选择注入、适配和恢复
机制，官方便利层没有隐藏权限。

## 开发与生命周期

两种入口都只读检查 UTF-8 JS（每入口上限 1 MiB），保留本代源码快照。host 快照放在 Core
持有的临时文件中，进程退出后删除；按原入口 filename 编译，因此 `__dirname`、相对 JS
require 和资源路径仍指向原包。原始入口不会被长时间锁住，编辑不会修改已加载代。
依赖文件和资源按访问时从目录读取；本版没有整包原子快照或自动依赖构建。

初始化仍是 5 秒，插件可以在 activate 的 Promise 完成前调用 Core；成功后才发布 active。
shutdown 撤销本代请求入口、abort signal 并调用 deactivate；未完成的 Core Promise 被拒绝，
不会在停止后重新激活。需要 CDP 的清理应在进入 shutdown 前完成；该阶段不再受理新 Core
调用。初始化失败同样尝试本地 deactivate；阻塞 JS、未退出进程或后代由原有独立 Job
与有限停止预算回收，失败不关闭其他插件的共享 CDP 连接。

JSONL、CDP 队列与监督截止保留 [M2a 监督层的限度](M2A_HOST_RUNTIME_2026-09-09.md#生命周期与限度)。
执行器还限制 pending JS RPC 和事件回调数量；订阅响应与第一条事件在同一读取批次中也
不会丢失。直接写 stdout 会成为协议错误。任意未托管副作用仍需插件自己负责。

TS 示例写法：

```ts
import type { HostContext, HostPlugin } from './types/host';
const plugin: HostPlugin = {
  async activate(context: HostContext) {
    const value = await context.cdp.request<{ targetInfos: unknown[] }>('Target.getTargets');
    context.log.info(value.targetInfos.length);
  },
  deactivate() {}
};
export = plugin;
```

构建工具使用 CommonJS 输出并把 JS 放到 manifest 的 entry，例如 TypeScript 配置
`{"compilerOptions":{"module":"commonjs","target":"es2022","outDir":"dist"}}`。
[类型声明](../types/host.d.ts)属于开发资料；运行时无需携带编译器。

## 迁移与仍未交付项

旧目录将 `plugin.json` 明确重命名为 `codlet.json`。若只有旧文件名，检查命令返回迁移说明，
不会偷偷重命名或修改 registry。host.command 需改成 host.entry 并把代码改成 JS 生命周期
入口；没有保留 native 插件兼容分支。Bundled 插件、local-echo 和 raw-host 示例已迁移。
用户已留证的历史日志与旧产物不重写。

本次 JS 改造之后，[M2b](M2B_HOST_CONTROL_2026-09-10.md)接入了同一 CLI receipt 的 host
在线启停/重载，并支持启动后注册的新 host。host watch、组合入口、跨执行器 capability 与
完整 host Inspect 仍为后续 M2 工作。host 状态目前从 launch 日志、生命周期 receipt 与可选
GUI 获取，status v1 / doctor Inspect 仍主要观察托管 renderer。

统一 JS/TS 是开发与分发契约，开放性由 Core 暴露的原语决定。图灵完备本身不能替代缺失
的系统接口。普通 Node host 仍可直接操作当前用户有权访问的文件、网络或进程；禁用 addon
不会将其变成安全沙箱，也不承诺阻止主动绕开约定的程序或回滚所有 raw CDP 副作用。

## 本批验证范围

使用固定 Node 的真实子进程与假 CDP 对端，验证 JS 入口、源码快照、依赖/资源、原生 addon
拒绝、无运行时 TS、权限拒绝、事件、延迟 target、退出和故障隔离。bootstrap 专项验证同批
回包/事件、初始化期间停止及失败清理；另检查 manifest 改名影响的 local/renderer/CLI 路径。
只运行相关检查，没有重跑 M0/M1 全量、启动真实 Codex 或修改用户插件注册。
