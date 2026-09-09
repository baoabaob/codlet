# M2a：独立 host 入口与 Core CDP 原语

本文记录提交 `f25b338` 的过渡实现。用户随后确认统一 JS/TS 插件格式；当前使用
`codlet.json` 与 `host.entry`，不再接受本文的可执行文件入口。现行合约与迁移见
[统一 JS 插件运行时](JS_PLUGIN_RUNTIME_2026-09-09.md)。旧格式和验证数字仅作为历史证据保留。
后续 host 在线启停/重载的现行实现见 [M2b](M2B_HOST_CONTROL_2026-09-10.md)；下文的未实现项描述本历史提交。

日期：2026-09-09。状态：首个实现小包，专项验证通过；不是完整 M2 或真实 Codex 全层级验收。

按用户要求，小修复完成后继续推进开放 Core 路径。新 M1 复测正常退出的证据已补入
[GUI 修复记录](GUI_REGISTRY_REPAIR_2026-09-09.md)。旧 exit 1 原因未定，重复启动与 crash
门禁继续留证，但不再要求每个开发小包先重跑完整 M0/M1。

## 已交付

- manifest schema 1 可选择独立 renderer 或独立 host。host 不提供 renderer 空入口。
- 本地原生 `.exe` 使用独立 stdin/stdout JSONL、stderr 尾部缓存和按插件持有的 Windows Job。
- 通用 Core 方法 `cdp.request`、`cdp.subscribe`、`cdp.unsubscribe` 对插件公开，不含官方
  provider ID 或 CDP 方法白名单，不解释 DOM、React、thread、turn 或 approval。
- 纯 host 启动跳过 managed renderer 的 URL/target 筛选。混合运行时，host RPC 有独立 owner
  线程；renderer 激活、重载或官方目标发现失败不作为 raw host 的接口授权条件。
- 插件初始化可先调用 Core 并等待结果，再完成 ready 握手。退出或失败回收只作用于该插件
  的 Job、stdio、排队请求与事件订阅；Core 的 Codex 进程和共享 CDP 连接不属于插件 Job。
- 可选 GUI 合并执行器的真实进程观察，显示 Starting/Active/Stopping/Failed/Exited 与错误。
  已移除注册但仍存活的实例保留行；已退出且已移除者消失。

代码边界：`plugins/local_plugins/catalog` 负责入口与授信文件装载；`plugin_host` 负责独立
进程和严格 JSONL；`host_runtime` 负责通用 Core RPC；`cdp/client/raw_access` 提供有界请求和
事件；renderer 仅消费只读 execution observation。没有引入官方 adapter 的私有快捷路径。

## 插件入口

```json
{
  "schema": 1,
  "id": "example.raw-host",
  "version": "0.1.0",
  "host": {
    "command": ["bin/codlet-raw-host-example.exe"],
    "protocol": "jsonl"
  },
  "permissions": ["host.process", "cdp.raw"]
}
```

`command[0]` 必须是注册目录内的普通 `.exe` 文件，相对路径遵守既有 traversal、链接、大小写
别名和 Windows 路径校验。其余元素是字面 argv，不经 shell 展开；cwd 为插件根目录。
检查阶段不运行可执行文件；装载保留拒绝写入/删除的文件句柄，启动前重新核对文件身份。

注册时必须显式 `--trust --grant host.process`；调用 CDP 还必须声明并获授 `cdp.raw`。
`host.process` 允许运行普通当前用户进程，不限制其直接文件、网络或系统调用。授信、Job
和 RPC 检查不是 OS 沙箱或插件安全背书。raw 插件自行承担注入、导航恢复、兼容性及副作用清理。

## JSONL v1

每行一个 UTF-8 JSON 对象。两端每个 request/response/notification 均带
`v:1`、`pluginId`、`generation`、`type`，严格拒绝未知顶层字段及身份不匹配。
两方向分别使用递增的正 safe-integer request id；过期/已退休回包不能恢复旧请求。

```json
{"v":1,"type":"request","pluginId":"example.raw-host","generation":1,"id":1,"method":"cdp.request","params":{"method":"Target.getTargets","params":{},"timeoutMs":5000}}
{"v":1,"type":"response","pluginId":"example.raw-host","generation":1,"id":1,"ok":true,"result":{"targetInfos":[]}}
```

Core 首先发送 `initialize` request，其 params 含 protocolVersion、coreVersion、permissions
和公开 methods。插件完成初始化后回复 `ok:true,result:{"ready":true}`。Core 发送
`shutdown` 后插件回复并退出；此阶段新 Core 请求会被拒绝，因此需要 CDP 的清理应在进入
shutdown 前完成。Core 不保证回滚插件已经执行的 DOM/JS/系统副作用。

| 方法 | params 与结果 |
| --- | --- |
| `cdp.request` | `method`、可选对象 `params`、可选 `sessionId`、可选 `timeoutMs`（1–15000，默认 15000）；成功 result 是 CDP 原始 result。插件自行选择 target、attach 与 detach。 |
| `cdp.subscribe` | `scope:"root"`、`scope:"all"`，或 `scope:"session",sessionId:"..."`；返回 `subscriptionId`。每个 host 同时一个订阅。 |
| `cdp.unsubscribe` | `subscriptionId`；只能删除本 generation 自己的当前订阅，返回 `unsubscribed:true`。 |

事件是 `cdp.event` notification，params 为 `{subscriptionId,event:{method,params,sessionId}}`。
订阅溢出或连接结束发送 `cdp.subscriptionEnded`，含 subscriptionId 与 reason；需要插件重新
订阅和取快照，不把丢失的事件伪装为完整数据。通知不授权执行 Core 方法，调用需要 request id。

错误 response 为 `ok:false,error:{code,message,data?}`。权限不足返回 `permission_denied`；
CDP 远端错误返回 `cdp_error`，data 中保留原始 code/data（过大时省略 data）；超时、未知方法、
无效参数和队列上限分别返回明确错误。过大的 CDP 结果转成 `response_too_large`。

## 生命周期与限度

JSONL 帧上限 1 MiB（不含末尾 LF），每方向 stdio 队列 4 帧、pending 16，stderr 尾部 64 KiB；
初始化 5 秒，RPC 与不完整帧最长 15 秒，停止预算 2 秒（其中 1.5 秒允许优雅退出）。同一个
Core host executor 最多运行 16 个插件；每插件最多 4 个进行中的 CDP 请求、8 个待发送桥接帧。
原始 CDP 写队列共享上限 16，事件订阅各自保留最多 4 帧，溢出只退休该订阅。

Core 在原请求绝对预算内完成路由，初始化期间再受初始化截止约束。尚未写出的取消请求会被
跳过；已经开始写入共享 pipe 的帧不能安全撤回，它有独立的 15 秒 transport 预算。短 RPC
超时不会关闭另一插件的正在进行的写入；真实共享 transport 故障仍影响所有使用该连接者。
一般插件失败通过非阻塞 begin_stop/poll 回收，不占用其他插件的初始化等待。

M2a 不支持组合 host+renderer 入口、host 的 provides/requires 跨执行器 capability、host
在线 enable/disable/reload 或 host 文件 watch。此时在线管理返回 `host_executor_required`；
host 的 enablement/grant 修改在下次 launch 生效，移除注册也不立即停止已运行进程。动态撤销、
热 generation 换代、broker 便利 API、完整 host 诊断与导航恢复是后续工作。
实验性 `codlet-lab` 仍只启动 managed renderer；发现启用的 host 入口时明确拒绝，使用正式
`codlet launch` 运行本小包的 native host，不把跳过执行误报为已加载。

`status` v1 与 doctor Inspect 继续描述 managed renderer，不含 host 插件执行证据；纯 host
会话的 renderer 观察可能 unavailable。host 状态目前从 launch 的 `host-plugin` /
`host-plugin-stopped` 日志及可选 GUI 获取。不能用 renderer 的 `active` 或静态声明判断 host
是否运行。官方插件的兼容性与 raw CDP 自有适配分别承担各自的限制。

## 示例与验证

[原生示例](../examples/raw-host/README.md)只依赖标准库和 serde_json。它自行 getTargets、
attach、订阅目标 session、执行表达式、接收事件、unsubscribe 和 detach，随后完成 ready；
不导入 Core Rust API 或 renderer ABI。需要查看结果时在 host.command 中加
`"--report","report.json"`；默认不记录页面数据。

专项检查覆盖原生 host/Job/stdio、严格协议、权限拒绝、二进制装载与保留句柄、CDP 请求和
订阅上限、错误帧、独立 host 闭环，以及受影响的旧 renderer/local-loader 兼容路径。
GUI 仅运行 execution-observation 对应单项用例。Clippy 对改动的 library、binaries 和相关
集成目标执行。没有重跑整仓 Rust/Node 全量测试，没有启动或重启真实 Codex，也没有修改用户
插件注册。构建及本地验证摘要保存在 `.codlet-artifacts/m2a-host-2026-09-09/`。
