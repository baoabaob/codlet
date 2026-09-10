# 同一目录包的 Host 与 renderer 入口

一个 `codlet.json` 现在可以同时声明 `host` 与 `renderer`。两个入口共享包 ID、注册目录、
完整 grants、enabled 偏好和 generation；加载器保留同一次选择得到的两个 JS 主入口快照。
可运行示例见 [local-host-renderer-capability](../examples/local-host-renderer-capability/README.md)。

## 声明归属

```json
{
  "schema": 1,
  "id": "example.combined",
  "version": "1.0.0",
  "renderer": { "entry": "renderer.js", "world": "isolated" },
  "host": {
    "entry": "host.js",
    "provides": [{ "name": "example.combined.host", "api": 1, "scope": "target" }]
  },
  "requires": [{ "name": "example.combined.host", "api": 1, "scope": "target" }],
  "permissions": ["host.process", "cdp.raw"]
}
```

| 包类型 | 顶层 `provides` / `requires` | `host.provides` |
| --- | --- | --- |
| 只有 renderer | renderer 的声明 | 无 Host 入口 |
| 只有 Host | `provides` 属于 Host；Host 侧 `requires` 暂不支持 | 必须省略或为空，避免两处声明 |
| 两种入口都有 | renderer 的声明 | Host 的声明 |

Host `context.rpc.provide(descriptor, method, handler)` 与 renderer
`context.rpc.request(descriptor, method, params)` 使用相同的完整 descriptor。当前跨入口路由
支持 Target scope。Host 侧 capability request / notify / requires 不在本次范围；
原有 `context.cdp` 原始方法和 session 能力不受此限制。

Core 为 Host 入口使用内部 owner `包ID:host`，renderer 入口保留包 ID。这个后缀不能成为
用户包 ID，CLI 和 registry 始终使用逻辑包 ID。这样 renderer 可以依赖本包的 Host，真正的
renderer 自循环仍被拒绝。Host 与 renderer 提供相同 descriptor 也仍是冲突，不会根据入口
顺序悄悄选一个 provider。诊断中的 qualified provider ID 属于 capability 注册证据，实际
Node 进程仍报告逻辑 ID 与同一 generation。

## 生命周期和失败补偿

启动时先运行各 Host 入口，观察到该 generation 的 Ready 后才激活需要它的 renderer。
renderer 自身没有调用 Host 的组合包也遵守这个顺序。声明本身不是 Host 已就绪的证明。

运行中的 enable/reload/disable 使用同一个前台协调器与原有 receipt。reload 根据当前已加载
快照计算传递依赖闭包：Host provider 的 renderer 消费者，以及消费者包自己的 Host 入口，
都属于本次替换。disable 拒绝仍有启用或运行依赖者的包，调用者应先停用依赖者。无关的新注册
或坏源码不参与这次源代码选择。

正常替换依次执行：

1. 读取并校验选中闭包的 manifest、两个声明入口、grants 与完整 capability 图。
2. 清理受影响的所有 renderer；此时原 Host 和原租约仍可供 renderer cleanup 使用。
3. 撤销受影响的入口注册与租约，等待旧 Host 进程和 IO 退休。
4. 启动候选 Host，确认 Ready，再为每个真实 renderer target 激活候选 renderer。
5. 再次核对注册与 enabled 意图，最后提交一个 `applied` receipt。

Native 操作以至多四个同时进行的有界批次轮询，前台继续泵送 CDP 与 renderer bindings。
若包是在仅运行 Host 的会话里加入，receipt 会等到真实 renderer target 建立及激活成功，
不会用零个 target 的空结果提前报告 applied。GUI `disableSelf` 的已保存意图与回复先完成，
随后进入同一协调器；broker 暂满时按逻辑 ID 保留并重试这项清理。

任一候选入口失败时，先清理候选 renderer 和 Host，再使用原来两个不可变源码快照恢复。
恢复为整个受影响包分配新的共享 generation，不会复用旧 world、binding 或 lease。
只有当前原目录注册、grants 与 enabled 偏好仍允许时才恢复；信任变化、清理无法确认或恢复
再次失败会得到 `degraded` 并保留具体阶段错误。恢复不会覆盖磁盘上的坏源码。

同一进程中的某个 ID 一旦拥有了一组入口，就不能在线增加、删除或切换入口类型；需要重启
Codlet 后采用新形状。正常源码编辑不受此限制。已坏掉、移除目录或取消注册的运行中包，仍可
按真实 owner 停用。已禁用的包须先 enable；已启用但失败的已知包可 reload 恢复。

## Watch 与读模型

`launch --watch` 对组合包一起观察 `codlet.json`、Host JS 与 renderer JS；每个入口沿用
1 MiB 限制，一次来源扫描最多读取三个受限文件。整体仍共用每轮四个来源的预算，要求两次
一致观察与 quiet interval。TS、导入模块和其他资源不在自动观察集合中。

组合包采用 Host 的 canonical root 与完整 grants 锚点。排队 receipt 执行前再检查 generation、
闭包内已选目录/Host grants 以及稳定 fingerprint。任意一个入口在稳定观察之后又变动，
这次选择以 `not_attempted` 退回观察；通过 fingerprint 检查的候选快照不会再被二次读取。
无效源码或实际激活失败保留失败签名，补偿产生新 generation 不会令同一坏版本反复重启。

管理列表每个逻辑 ID 只有一行。组合包只有 Host 和该行 renderer 都在相同 generation
实际激活，才显示 active；Host-only 包没有伪造 renderer target。Host process、cleanup 与
renderer target 的诊断保持各自真实执行事实。

## 定向验证

`tests/combined_packages.rs` 覆盖两入口失败补偿、Host→组合包→renderer 传递闭包、两入口
watch/F1、真实 target 等待及 broker 满时的组合包 self-disable。`catalog` 的图测试覆盖内部
owner 分离、真正自循环和重复 descriptor；`local_host_plugins` 验证两个不可变来源及旧式
Host-only 声明兼容。执行真实 JS 的组合验收见
[Host / renderer VM 验收](HOST_RENDERER_VM_ACCEPTANCE_2026-09-10.md)，原生桥接验证见
[Host capability](HOST_CAPABILITY_2026-09-10.md)。这些是隔离的本地执行验收，不扩大既有真实
Codex 界面验收记录。
