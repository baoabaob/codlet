# 统一 JS/TS 插件格式与执行器

更新：2026-09-10。本页是 M2 当前 JS/TS 开发契约；它继承了 2026-09-09 对统一 JS Host
入口的决定。运行验证与完成范围单独记录在 [M2 验收](M2_ACCEPTANCE_2026-09-10.md)，本页
不把源码接口、便携文件清单或旧二进制的 smoke 当作新版本验收。

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
导出 CommonJS `activate(context)` 和 `deactivate()`，可返回 Promise。host 的 deactivate
还会收到可选使用的 `cleanup` 上下文，见下述停止契约。2026-09-10 起，同包可同时声明
host 与 renderer，两入口共享注册、enabled 偏好和 generation。顶层 provides/requires
归 renderer，Host 的声明放在 host.provides / host.requires；Host-only 的顶层
provides / requires 属于 Host。
完整声明与生命周期见 [组合包契约](COMBINED_PACKAGES_2026-09-10.md)。

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
| `context.cdp.request(method, params?, options?)` | 原始 CDP 调用；options 可选 sessionId、timeoutMs、signal，成功返回原始 CDP result。无官方方法白名单；Core 校验它管理的 raw session/target 归属。 |
| `context.cdp.subscribe(filter, onEvent, onEnd?)` | filter 为 root/all，或 session+sessionId；返回 `{id,unsubscribe()}`，onEvent 收到 `{method,params,sessionId}`。每 host 同时一个订阅。 |
| `context.core.request(method, params, timeoutMs?)` | 通用版本化 Core 请求通道；优先使用对应的 cdp/rpc/OS SDK 包装。 |
| `context.rpc.provide(capability, method, handler)` | 注册已声明的 Runtime 或 Target capability；handler 接收 Core 验证的 invocation。 |
| `context.rpc.request(capability, method, params?, options?)` | 调用已声明 requirement；options 可含 scope、timeoutMs、signal。 |
| `context.rpc.notify(capability, method, params?, options?)` | Host 返回 Promise，等 handler 终态确认后丢弃返回值；失败仍 reject，不是持久消息队列。 |
| `context.rpc.target({sessionId}, options?)` | 从本 Host/代次拥有的 flatten raw session 签发 opaque Target handle；handle 可 close。 |
| `context.fs.readText/readDir/stat(params, options?)` | 只读访问显式 readRoots。 |
| `context.network.fetch(params, options?)` | 对明确 HTTP(S) origin 做受限 GET/HEAD。 |
| `context.process.run(params, options?)` | 以参数数组运行明确允许的 executable，由独立 Job 回收。 |
| `context.system.info(options?)` | 返回有界 OS、架构与 CPU 数量。 |
| `context.plugin` | 本实例的 id、version、generation。 |
| `context.root` | 原插件根目录；Node cwd 同该目录。 |
| `context.signal` | 停止时 abort；插件应取消未完成的异步工作。 |
| `context.log` / `console` | 输出到 stderr，不污染 JSONL stdout。 |

`host.process` 授权运行统一 Node 中的普通用户 JS；其 process.run endpoint 还需明确
executable 范围。`cdp.raw`、`host.fs`、`host.network`、`host.system` 分别控制对应 endpoint，
均需声明且显式获授。grants 与 brokerPolicy 一起原子持久化，多余 grant 不扩展 manifest 的
有效权限；完整记录变化使旧 generation 失效。范围、撤权和资源终态见
[OS broker](OS_BROKER_2026-09-10.md)。错误保留 code/message/data，
例如 permission_denied、request_timeout、cdp_error。关闭官方功能插件后，这些接口仍然
可用；纯 host 启动不执行官方 renderer URL/target 筛选。用户插件自行选择注入、适配和恢复
机制，官方便利层没有隐藏权限。

### Scope 与嵌套 RPC

Runtime 表示这次 Core 运行。Host provider 支持 Runtime/Target，renderer provider 只支持
Target；renderer consumer 可调用两者。其他 scope 留给有明确生命周期的 adapter，本版
不会仅因 descriptor 可解析就伪造其实例。Target Host 调用须使用本代 `rpc.target` handle，
或继承当前入站 Target；不能自报 targetId/documentEpoch，也不能跨 Host 传 handle。

```js
const runtimeApi = { name: 'dev.worker.service', api: 1, scope: 'runtime' };
const reply = await context.rpc.request(runtimeApi, 'inspect', null, { timeoutMs: 2000 });
```

这个 descriptor 必须在调用方 `requires` 声明，并由其他已就绪 provider 提供。Core 在解析
租约时固定 provider generation；等待 Ready、旧 target 退出、超时或取消，都不会把调用
改派给一个较新的 provider。

Host handler 的 immutable invocation 包含 caller、scope、depth、rpc、signal 与
remainingMs。Host async continuation 的受管理 RPC/CDP/OS 自动继承原绝对 deadline 与
取消；托管 renderer 没有 Node async context，handler 要使用 `invocation.rpc` 发起嵌套
调用。renderer 的普通 `context.rpc` 是新 root 调用。最大嵌套深度为 8，预算不逐层续期。

renderer request 支持第四个 `{timeoutMs?, signal?}` 参数，既有单 requirement shorthand
保留。renderer notify 仍返回同步 void、没有响应 ID或交付 receipt，Core 对失败记有界诊断；
这与 Host notify 的确认 Promise 不同。完整接口、server-request、错误和验收见
[Core RPC](CORE_RPC_2026-09-10.md)及 [renderer 类型](../types/renderer.d.ts)。

公开 `codlet.runtime.manage@1` 可在 Runtime 或 Target 使用，提供 list、prepare、submit、
operation，复用 CLI/GUI 的同一 receipt；详见 [管理契约](RUNTIME_MANAGE_2026-09-10.md)。

## 开发与生命周期

两种入口都只读检查 UTF-8 JS（每入口上限 1 MiB），保留本代源码快照。host 快照放在 Core
持有的临时文件中，进程退出后删除；按原入口 filename 编译，因此 `__dirname`、相对 JS
require 和资源路径仍指向原包。原始入口不会被长时间锁住，编辑不会修改已加载代。
依赖文件和资源按访问时从目录读取；本版没有整包原子快照或自动依赖构建。

初始化仍是 5 秒，插件可以在 activate 的 Promise 完成前调用 Core；成功后才发布 active。
shutdown 撤销普通请求和事件、abort 普通 signal，并调用 `deactivate(cleanup)`；未完成的
普通 Core Promise 被拒绝，不会在停止后重新激活。清理上下文的 `cleanup.cdp.request`
与 `cleanup.core.request('cdp.request', …)` 可在同代、同授信下使用公开 CDP，全部请求
共享 Core 的 1500 ms 总预算，不增加订阅或延长 deadline。尚未完成的异步 activate 不阻止
清理；阻塞 JS、未退出进程或后代仍由独立 Job 和有限停止预算回收。完整语义与示例见
[Host cleanup](HOST_CLEANUP_2026-09-10.md)。

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
[Host 类型](../types/host.d.ts)、[renderer 类型](../types/renderer.d.ts)和
[管理 DTO](../types/runtime-manage.d.ts)属于开发资料；复制到开发项目或配置 TypeScript
paths 后使用 type-only import。运行时无需携带编译器。

## 迁移与仍未交付项

旧目录将 `plugin.json` 明确重命名为 `codlet.json`。若只有旧文件名，检查命令返回迁移说明，
不会偷偷重命名或修改 registry。host.command 需改成 host.entry 并把代码改成 JS 生命周期
入口；没有保留 native 插件兼容分支。Bundled 插件、local-echo 和 raw-host 示例已迁移。
用户已留证的历史日志与旧产物不重写。

本次 JS 改造之后，[M2b](M2B_HOST_CONTROL_2026-09-10.md)接入了同一 CLI receipt 的 host
在线启停/重载，并支持启动后注册的新 host。后续已接入
[host watch](HOST_WATCH_2026-09-10.md)、带预算的清理与
[host execution Inspect](HOST_INSPECTION_2026-09-10.md)。doctor 可读实际进程和清理样本，
旧 status-v1 / Inspect 保持原契约。组合入口、双向 Host/renderer RPC、Runtime/Target、
独立 OS broker、持久权限撤销和公开 runtime.manage 已纳入当前开发接口。具体执行证据
按 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)核对。Managed main world、adapter scope、
Codex 私有映射和 M3/M4 扩展仍按各自后续边界推进。

统一 JS/TS 是开发与分发契约，开放性由 Core 暴露的原语决定。图灵完备本身不能替代缺失
的系统接口。普通 Node host 仍可直接操作当前用户有权访问的文件、网络或进程；禁用 addon
不会将其变成安全沙箱，也不承诺阻止主动绕开约定的程序或回滚所有 raw CDP 副作用。

## 本批验证范围

使用固定 Node 的真实子进程与假 CDP 对端，验证 JS 入口、源码快照、依赖/资源、原生 addon
拒绝、无运行时 TS、权限拒绝、事件、延迟 target、退出和故障隔离。bootstrap 专项验证同批
回包/事件、初始化期间停止及失败清理；另检查 manifest 改名影响的 local/renderer/CLI 路径。
只运行相关检查，没有重跑 M0/M1 全量、启动真实 Codex 或修改用户插件注册。
