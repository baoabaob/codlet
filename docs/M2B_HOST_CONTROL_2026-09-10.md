# M2b：JS host 在线生命周期

日期：2026-09-10。本包在统一 JS/TS 目录包上接入 host 在线管理，不改变 manifest、公开
CDP 原语或安全边界；完整 M2 与真实 Codex 的全层级验收仍未完成。

## 已交付路径

```powershell
codlet plugin add "C:\my-plugins\raw-host" --trust --grant host.process --grant cdp.raw
codlet plugin enable example.raw-host
codlet plugin reload example.raw-host
codlet plugin disable example.raw-host
codlet plugin operation <receipt> --json
```

使用正在运行的 Host 对应的同一个 `codlet.exe`。已经启动且起初没有 host 插件的会话，
也能注册并 enable 新 host；受管 Node 按需发现，缺失或摘要错误会失败，不回退到系统 Node。
注册、启用偏好和实际运行状态各自独立：`remove` 只删除注册，仍运行的实例必须 disable
或随 runtime 停止。源码/manifest 损坏或原 registration 已移除，不阻止实际 host 的 disable。
registry JSON 本身损坏仍返回 `registry_error`，不会构造替代配置。

一份已分配的插件 ID 在当前 runtime 固定为 host 或 renderer。编辑 manifest 改变执行器
会在旧实例退休前明确拒绝；本包不做跨执行器迁移。组合入口与跨执行器 capability 仍未开放。

## 事务与代数

- `enable` 对指定 ID 检查本次 registration、身份、JS entry 与声明/grants。active 且仍
  可信的实例可 unchanged；否则启动新代，ready 后才按既有 registry 锁与完整 local record
  compare 写入 enabled=true。新注册不会被启动时的旧 catalog 拒绝。
- `disable` 先保存 enabled=false，再等待该代进程、后代 Job 与 stdio workers 退休。
  插件源文件不参与这一清理决策。强制退出或非零退出如实记录为 degraded，偏好仍为 false。
- `reload` 必须曾加载且当前仍 enabled；新 ID 或已禁用 ID 被预检拒绝，不执行入口也不
  消耗代数。初始化曾失败但仍 enabled 的已知 host 可用 reload 恢复。
- 候选代码验证失败时旧实例不动。替换先退休旧代，再启动候选；所有实际分配的代数只递增，
  disable、失败和恢复均不会把旧代号重新投入使用。
- 启动或提交失败后，候选先退休。只有原目录仍注册、当前 grants 覆盖旧 manifest、当前
  enabled=true，才以旧 JS 入口源码快照和新 generation 恢复。恢复后再次核验注册与授信；
  中途撤权、停用或注册变化会使补偿停止，不能借 rollback 重新扩大授权。

恢复成功返回 `rolled_back`，仍表示原请求失败；无法恢复或清理需要检查时返回 `degraded`。
receipt 的 `desired_enabled` 是当前可读 registry 意图，`generations` 保留尚未确认退休的
运行时实例代数，不把仅分配的候选代号当作激活成功。host 故障借现有失败 DTO 的空 target_id
报告，不虚构 renderer target。

## 前台、回执与 GUI

前台协调器最多持有一项 pending host 事务，以 `begin_start` / `begin_stop` 和非阻塞
`try_result` 推进。等待 JS initialize/shutdown 时不阻塞 renderer 事件循环；其他 host
继续使用同一 CDP 连接。后续 CLI 生命周期请求保留在原有有界队列；renderer watcher 等
待本项完成，不并行执行第二个换代。

协调器与执行器共用每会话最多 4096 个 host ID 的历史上限；同 ID 的代数在原记录上递增。
到达上限只拒绝新的 ID，已知 ID 仍可停用、恢复和换代，不逐代积累历史资源。

继续使用既有 prepare → 一次 submit → 只读 result。CLI 有限等待后可以返回 uncertain，
之后使用同一 receipt 查询；协调器只完成原 receipt，不新建或重提 mutation。
每份 operation handle 交付一次终态，丢弃 handle 不隐式取消已受理的操作。

可选 GUI 接收执行器的真实 Starting/Active/Stopping/Failed/Exited 观察。已移除但仍活动的
host 行保留；退出并移除后行消失。host 的状态不会进入虚构的 renderer session 或 target。
本包没有扩展 status-v1 / doctor 的 host Inspect 协议，进程证据从 lifecycle receipt、
launch 日志和 GUI 获取。

## 清理边界与剩余项

热管理覆盖受管 JS 进程、generation、排队请求、订阅、stdio workers 与进程 Job。初始化
仍有截止，停止仍采用有限预算。shutdown 开始后不再接受本代新的 Core/CDP 请求；本地
`deactivate` 与 abort 可收尾本地工作，需要 CDP 的插件清理目前必须在进入 shutdown 前
自行完成。本包不能证明插件注入页面的任意效果均已撤回，也不把普通用户 Node 变为沙箱。

host 文件 watch、组合入口、跨执行器 capability、完整 host Inspect、带预算的 shutdown
清理 RPC 和更完整 raw 资源归属仍是后续工作。第一方便利层继续是可选插件，不成为 raw
CDP 的方法白名单或能力前置条件。

## 专项验证

`tests/host_control.rs` 使用真实固定 Node、假 CDP 对端和实际协调器/broker，覆盖：

1. 启动后新增 host 的 enable/reload/disable/reenable、receipt 重读及代数高水位；
2. disabled reload 预检拒绝、损坏/移除注册后的清理、新 broken registration 的纯偏好 disable；
3. 候选验证与执行器类型切换保留旧进程，初始化失败从旧快照恢复新代；
4. replacement 初始化期间撤权或停用，拒绝不再获准的补偿；
5. pending receipt 期间前台和共享 CDP 可响应，后续生命周期仍按队列串行；
6. 已知失败且仍 enabled 的 host 通过 reload 恢复。
7. 旧终态观察被有界列表淘汰后，仍 enabled 的已知 host 可依据代数记录 reload 恢复。

本轮共 21 个唯一验证场景通过：

- 协调器上述 7 项，以及 4096 条身份历史的容量边界单项；满额后拒绝新 ID，已知 ID
  仍可继续换代，不消耗被拒绝请求的代数。
- 底层执行器 10 项：既有 JS host 4 项、在线生命周期 5 项，以及延迟创建回收单项。
  覆盖真正的 `None → discover` 首次 host 启动、连续换代、初始化失败/超时、强停后的
  整个 Job 与 IO 退休、临时源码释放、其他 host 持续 Core heartbeat，以及创建期间的
  stop、runtime shutdown、launch timeout。
- 3 个既有 renderer 单项：直接 renderer 执行器拒绝 host 控制、执行器类型切换在退休/
  代数提交前拒绝、removed host 的 GUI 列表与实际退出观察一致。

最终格式检查、定向 Clippy（`-D warnings`）、`git diff --check` 与 release 构建通过。
未重跑全量 M0/M1，未启动真实 Codex，未修改用户 registry。产物与校验记录保存在
`.codlet-artifacts/m2b-host-control-2026-09-10/`。
