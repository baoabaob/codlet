# 公开 runtime.manage@1 开发契约

第三方 Host 和可选托管 renderer 与 GUI 使用同一项 `codlet.runtime.manage@1` capability。
调用者必须声明精确 descriptor 和 `runtime.manage` permission，并获得明确 grant。Core
验证调用者、generation、scope 和授权；params 不能选择另一个 caller 或 registry，也不接受源码文本。M5a 导入接收显式本地目录及其预览摘要；M5b 新增 Core 校验的 GitHub 发布包准备与托管版本选择。

`runtime.manage` 是管理授权，包含导入和为其他插件选择 grants 的能力；只能授给可信管理插件，不能将它当作只读列表权限。

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
| `versionStatus` | `null` | `{runtimeVersion,runtimeUpdate,runtimeUpdateError,clientStatus}`，独立于插件列表的轻量版本快照 |
| `getSettings` | `null` | `{schema,revision,values,effective,defaults,availability}`，当前 owner 的持久设置及实际值 |
| `saveSettings` | `{expectedRevision,values}` | 一次 CAS 保存完整四个偏好字段并应用；返回新的设置快照 |
| `checkPluginUpdates` | `null` | 只读检查已注册 GitHub 插件的发布元数据，不下载或安装；工作中及结束后 60 秒合并重复请求 |
| `prepare` | `{action, plugin_id, permission?, cascade?, local_import?}` | 原 `ControlReport`，成功状态 `prepared` |
| `submit` | `{operationId}` | 原 receipt 的 `queued` / `running` / `completed` 等状态 |
| `operation` | `{operationId}` | 只读查询原 receipt |
| `previewLocal` | `{path}`，完整本地路径 | 校验后的 manifest、规范路径、内容/注册摘要和会话 watch 信息；不执行入口 |
| `permissions` | `{pluginId}` | 最新本地注册记录，格式与 CLI permissions 相同 |
| `chooseLocalFolder` | `null` | Windows 文件夹选择状态及 `selectionId`，立即返回 |
| `folderSelection` | `{selectionId}` | `selecting` / `selected` / `cancelled` / `failed`；成功才包含目录 |
| `githubReleases` | `{url}` | 开始只读发布列表任务，返回 job |
| `githubPrepare` | `{repositoryUrl,releaseId,assetId,operation?:'install'|'update',pluginId?}` | 下载/校验任务；update 必须指定目标 ID |
| `githubJob` / `cancelGitHubJob` | `{jobId}` | 读取 / 取消准备任务 |
| `managedHistory` | `{pluginId,cursor?}` | `{pluginId,currentVersion,history,nextCursor}`，每页最多 8 条并受响应字节预算限制 |
| `previewRollback` | `{pluginId,versionKey}` | 重新校验的托管候选预览，未提交变更 |

`action` 是 `enable`、`disable`、`reload`、`revoke`、`import`、`update`、`rollback` 或 `remove`；仅 `revoke` 必须携带一个 permission，
其他 action 省略该字段。注意 prepare 的 `plugin_id` 是 snake_case，而 submit/operation
的输入 `operationId` 是 camelCase。ControlReport 回包继续使用原 snake_case 字段：
`schema_version`、`host_pid`、`registry_scope`、`status`、`operation`、`error`。

`disable` 和 `remove` 可显式携带 `cascade: true`，一次关闭目标及所有已启用或仍在运行的依赖插件。
省略该字段时继续拒绝有依赖者的关闭；其他 action 不接受 `cascade: true`。
GUI 使用列表的 `disableDependents` 显示受影响插件，用户确认后只提交一次。
Core 在清理前原子保存整组关闭状态；这条路径不进行重新激活或回滚到启用状态。

## M5a 本地预览、导入与移除

`list.localManagement` 标识本地管理是否可用、当前会话是否开启 watch，以及是否支持系统选择器。选择器在专用 STA 线程运行，不阻塞 CDP/RPC；从已存在的注册目录或程序目录打开，避免隔离环境缺少 Desktop 的默认路径问题。路径输入和系统选择最终使用相同的 `previewLocal`。

预览经既有检查器读取选中目录的 manifest 和已构建 JS，返回 `codlet.local-import-preview`。它不创建注册、不复制源码、不执行 JS、构建或安装脚本。`dependencyCheck` 根据已发布运行样本列出依赖的可用状态，正式启用时仍由生命周期依赖图重新校验。

确认后的请求示例：

```js
const manage = { name: 'codlet.runtime.manage', api: 1, scope: 'runtime' };
const prepared = await context.rpc.request(manage, 'prepare', {
  action: 'import', plugin_id: preview.manifest.id,
  local_import: {
    path: preview.path,
    contentDigest: preview.contentDigest,
    registrationDigest: preview.registrationDigest,
    trusted: true,
    grants: explicitlySelectedPermissions,
    brokerPolicy: explicitlySelectedScopes,
    enable: false,
  },
});
```

本地 import 的 `local_import` 省略 `managed`。摘要覆盖规范根目录、manifest 语义、入口文本以及预览时的完整注册记录/启用偏好；它用于拒绝过期预览，不能代替信任作者。执行前再次检查，本地开发目录中同 ID 不同路径直接冲突；路径变化需要显式移除后重新授信。运行中的本地同 ID 包必须先停用，再更改授权。托管更新/回滚使用下述显式事务。

导入先将注册与停用偏好原子保存；`enable: true` 随后在同一 receipt 中使用既有激活事务，保留检查过的源码快照。激活失败不会留下默认启用的新注册；结果会指出失败或 degraded 状态。依赖预检失败时不会保存注册。传输丢失后仍只查询原 receipt。

Remove 取消本地注册、停用已确认的依赖闭包，并撤回运行权限后清理；作者目录、文件和插件自有数据不删除。内置安装不能移除。每次 prepare 的完整序列化请求仍受 4 KiB 限制，预览/结果受 256 KiB 限制。

`plugin preview <directory> --json` 提供 CLI 只读预览。`plugin add --trust --grant ... [--enable] [--json]` 和 `plugin remove <id> [--cascade] [--json]` 使用同一注册与生命周期服务。Add 默认停用；离线修改仍必须先证明该注册表没有 Host。手测步骤见 [M5a 手测指南](LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md)。

## M5b 后台准备与托管选择

`list.githubManagement.available` 表示服务可用。GitHub job 为 `{jobId,kind:'releases'|'package',status:'running'|'completed'|'cancelled'|'failed',stage,result?,error?:{code,message}}`；它不等于管理 mutation receipt。最多 4 个尚未退出的 worker、16 条保留结果，网络准备预算两分钟；取消后不交付迟到结果，不会自动注册。正在做的同步校验可能先完成，再释放 worker。

package job 完成时返回 `codlet.managed-preview`，包含来源、当前/候选版本、权限/依赖差异、兼容声明及一次采样的依赖检查。预览和完整 job 一起受响应预算约束，超限发布明确 failed。公开预览用 `historyCount` 代替完整历史；历史分页不携带大型 metadata，选择回滚后再获取完整候选声明。

托管的最终 prepare 仍使用 `local_import`，额外携带 `managed:'install'|'update'|'rollback'`，分别配对 `action:'import'|'update'|'rollback'`。其余字段与上面的导入确认一致。源记录不由 caller 传入；Core 根据同 registry 的下载回执和整包摘要重新获取。每次显式选择 grants、scope 和 enable。换仓库不继承信任；运行更新复用代次替换和失败补偿。

`permissions` 与 list 中的托管项另有 `ownership:'core-managed-github'`、`managedSource`、`managedVersionKey`、可选 `metadata`。本地开发条目继续原格式。CLI 和发布细节见 [GitHub 分发规范](GITHUB_PLUGIN_DISTRIBUTION.md)。

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

M5a 行数据增加 `brokerPolicy`、`ownership` 和 `providedCapabilities`。本地目录 ownership 为 `development-directory`；GUI 的 Details 展示最新授权，并提供撤销与移除。

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

## 运行设置与版本状态（2026-09-14）

设置方法使用同一 Core caller/generation/grant 校验。它们不创建插件操作 receipt：保存通过
`expectedRevision` 比较并交换，Host 未就绪、停止中或已有排队/执行中的生命周期操作时拒绝写入。
`values` 必须完整包含 `automaticUpdateChecks: boolean`、`checkPluginUpdatesOnStartup: boolean`、
`updateCheckIntervalSeconds: null | 300..86400 的整数`、`localSourceAutoReload: null | boolean`；
未知字段和非整数 revision 拒绝。回包丢失后调用 `getSettings` 查询，不自动重复提交。

偏好放在该 registry 路径追加 `.preferences.json` 的 sidecar 中，使用独立文件锁、有界大小和
原子替换。缺省读取不会创建文件。interval 的 null 继承开发者发布通道间隔，watch 的 null
继承原启动默认值；仅保存偏好不会改插件注册、启用、grants 或发布源。更新 worker 的排程和
本地源码 watcher 在当前会话应用，重启读取相同偏好。自动更新设置只控制 Codlet 自身更新，
官方客户端版本监测仍独立每 15 分钟进行。详见 [布局、设置与验证](LAYOUT_AND_SETTINGS_2026-09-14.md)。

`checkPluginUpdatesOnStartup` 缺省为 true，旧偏好文件在读取时补默认值而不写文件。每个运行时 owner 启动时检查一次；切换页面或创建窗口不重复检查，修改开关影响下次启动。手工检查不受该开关限制。`versionStatus` 同时返回 `pluginUpdates`：检查阶段、毫秒检查时间、按插件 ID 索引的结果和错误。结果绑定 `versionKey`；当前注册移除或换版后不会显示旧结果。只比较同源 GitHub 发布的语义版本 tag；稳定安装不主动提示预发布。自定义 tag 和不完整目录报告 unknown，网络失败报告 failed。版本候选仍走既有下载检查、插件 ID 校验、权限确认和 update receipt。详见 [插件检查边界](UI_POLISH_AND_PLUGIN_UPDATES_2026-09-14.md)。

当前运行验证和范围由 [M2 验收记录](M2_ACCEPTANCE_2026-09-10.md)单独记录；分发脚本只读
smoke 与 payload hash 不能代替这些运行时验收。
