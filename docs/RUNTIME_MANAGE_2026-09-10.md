# 公开 runtime.manage@1 开发契约

第三方 Host 和可选托管 renderer 与 GUI 使用同一项 `codlet.runtime.manage@1` capability。
调用者必须声明精确 descriptor 和 `runtime.manage` permission，并获得明确 grant。Core
验证调用者、generation、scope 和授权；params 不能选择另一个 caller、registry 或源码。

Host-only 管理插件可使用 Runtime scope：

```json
{
  "schema": 1,
  "id": "dev.manager",
  "version": "1.0.0",
  "host": { "entry": "host.js" },
  "permissions": ["host.process", "runtime.manage"],
  "requires": [{ "name": "codlet.runtime.manage", "api": 1, "scope": "runtime" }]
}
```

组合包的 Host requirement 写入 `host.requires`；顶层 `requires` 属于 renderer。Target
scope 也可用，Host 通过 Core 签发的 target scope 或当前入站 scope 调用。Scope、嵌套调用
与取消语义见 [Core RPC](CORE_RPC_2026-09-10.md)。类型见
[`types/runtime-manage.d.ts`](../types/runtime-manage.d.ts)。

## 一项变更、一张 receipt

| 方法 | 输入 | 返回 |
| --- | --- | --- |
| `list` | `null` | `{plugins, sampledAtUnixMs}`，Host 收到前台发布的样本 |
| `prepare` | `{action, plugin_id, permission?, cascade?}` | 原 `ControlReport`，成功状态 `prepared` |
| `submit` | `{operationId}` | 原 receipt 的 `queued` / `running` / `completed` 等状态 |
| `operation` | `{operationId}` | 只读查询原 receipt |

`action` 是 `enable`、`disable`、`reload` 或 `revoke`；仅 `revoke` 必须携带一个 permission，
其他 action 省略该字段。注意 prepare 的 `plugin_id` 是 snake_case，而 submit/operation
的输入 `operationId` 是 camelCase。ControlReport 回包继续使用原 snake_case 字段：
`schema_version`、`host_pid`、`registry_scope`、`status`、`operation`、`error`。

`disable` 可显式携带 `cascade: true`，一次关闭目标及所有已启用或仍在运行的依赖插件。
省略该字段时继续拒绝有依赖者的关闭；其他 action 不接受 `cascade: true`。
GUI 使用列表的 `disableDependents` 显示受影响插件，用户确认后只提交一次。
Core 在清理前原子保存整组关闭状态；这条路径不进行重新激活或回滚到启用状态。

```js
const manage = { name: 'codlet.runtime.manage', api: 1, scope: 'runtime' };

async function submitReload(context, pluginId) {
  const prepared = await context.rpc.request(manage, 'prepare', {
    action: 'reload', plugin_id: pluginId,
  });
  if (prepared.status !== 'prepared') throw new Error(`prepare: ${prepared.status}`);
  const operationId = prepared.operation.operation_id;
  // Keep operationId in your UI/state before sending. A transport error does
  // not prove that submit failed to reach Core.
  try {
    await context.rpc.request(manage, 'submit', { operationId });
  } catch (error) {
    context.log.warn('Submit reply unavailable; query this receipt:', operationId, error.message);
  }
  return { operationId };
}

async function readOperation(context, operationId) {
  return context.rpc.request(manage, 'operation', { operationId });
}
```

后续查看原 receipt，直到 `status === 'completed'` 或出现需要用户处理的状态；用有界轮询
和调用者的 signal，不在 activate 内无限等待自身生命周期变更。收到 `busy`、`not_ready`、
`stopping`、`expired` 等状态时，不把它们伪装为成功。调用超时或 submit 回包丢失后，只查
原 operation ID，不重新 prepare，不生成第二项操作，也不改成离线写配置。

完成内容是以下两种之一：

```js
const completion = reply.operation?.completion;
if (reply.status !== 'completed' || !completion) {
  // Retain operationId and refresh this receipt later; this is not success.
} else if (completion.kind === 'report') {
  // report.outcome: applied | unchanged | rolled_back | degraded
  // report.target_failures identifies actual renderer/native cleanup failures.
} else {
  // completion.error: { code, message }
}
```

prepare/submit/operation 复用同一有界 broker 和既有生命周期事务；重复查询不会再执行代码。
重复 submit 同一有效 receipt 返回原状态，不生成第二个 job，但客户端仍须按一次提交来设计。
Mutation 应使用 request；Host notification 的完成语义不替代可查询的管理 receipt，renderer
notification 没有交付 receipt。

## 列表、撤权与 CLI

Host `list` 明确返回 `sampledAtUnixMs`，不能把旧样本当成即时运行事实。托管 renderer 的
原 `list` 保留即时读取 registry 的行为，可能没有该时间字段。每个逻辑包只有一行；组合包
的 active 要求两个入口在相同 generation 真正激活。`enabled` 是持久意图，和 active 不同。
`name` 是 manifest 的可读名称，缺省时回退到 ID；`disableDependents` 是连带关闭的其他
插件 ID。显示名称只用于界面，所有管理请求仍使用稳定的 `plugin_id`。

```powershell
codlet plugin permissions dev.my-tools --json
codlet plugin revoke dev.my-tools host.fs --json
codlet plugin operation '<receipt>' --json
```

Revoke 先原子保存减少后的完整 grants/policy，然后使旧 Core 权限失效并退休 provider 和
传递依赖者。它保留 enabled 偏好，不自动补偿或恢复旧授权。重新运行需要明确重新授信
并 enable；仍声明但未获授的 permission 会在加载时被拒绝。离线 revoke 仅在证明该
registry 没有运行中 Host 后写入。

`permissions` 是只读记录查询。实际授信使用 `plugin add --trust --grant ...`，并通过重复的
`--read-root`、`--network-origin`、`--executable` 设置对应范围；详见
[OS broker](OS_BROKER_2026-09-10.md)。这些命令不会为插件自动推断或扩大权限。

GUI 的一般启停、reload 和 revoke 使用同一张 receipt。既有 renderer `disableSelf` 保留
回复后清理语义；组合包清理仍交给同一前台协调器，不留下本包 Host 半边继续运行。

当前运行验证和范围由 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)单独记录；分发脚本只读
smoke 与 payload hash 不能代替这些运行时验收。
