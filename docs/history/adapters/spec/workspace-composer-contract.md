# 可重绑定 Native 输入器：接口评估

日期：2026-10-11。状态：双方已接受的最小契约；协议、取消和清理边界已通过离线 fixture 测试，直接 Native 渲染/绑定核验已有候选实现，Native 草稿/附件 bridge 尚未实现和验收，未发布。

对应分屏侧方案：`X:/codlet-split-workbench/docs/design-decision-2026-10-11.md`。最初使用归档 26.1002 源码及 React/jsdom/模拟 driver；随后核对当前 26.1007.2314.0 包，并在独立、已认证、空数据的 Adapter 测试实例完成只读组件发现和主页模型核验。没有挂载附加输入器或写草稿。不同验证阶段的范围见 [测试环境记录](workspace-native-environment-2026-10-11.md)。

## 结论

**同一个逻辑句柄切换会话，在源码结构上可行；同一个底层 EditorView 跨会话原位复用，不是 Native 当前提供的语义。** Native 按会话派生的 composer 身份给编辑器 provider 设 key。切换 key 会重新创建编辑器，并销毁旧 controller。因此契约只保持插件 container 和 Adapter handle，不承诺 contenteditable、EditorView、撤销栈或选区对象跨不同会话保持同一对象。插件侧不需要恢复按 cache 常驻多个输入器的方案。

归档版发现了比现有 Frame 更小的 Native 组件：primary 模块的通用 composer（`GX`，导出 `Fc`）及其 surface 包装器（`VV`，导出 `xf`）。本轮又从当前 26.1007.2314.0 包静态核对了对应组件、scope hook 和 Native controller factory，并实现直接渲染/绑定核验候选。真实 Native 数据生命周期 bridge 尚未实现，运行时角色唯一性未验收；它仍有自己的监听、模型和辅助控件成本。详见 [当前 driver 进展](workspace-native-driver-2026-10-11.md)。

**完整需求尚未成立。** 最大待验证项是：附加编辑器修改某会话后，仍存活的主编辑器能否同步最新 Native 草稿/附件，且不在退出或销毁时写回旧状态。当前存在共享持久化路径，但也存在 scope 本地缓存和初始化读取。源码不足以证明同时存活编辑器的双向同步；原来的实测也未证明它。这是 `composerRebind` 能力启用前必须独立验证的条件。

## 原生依据与限制

| 观察 | 源码依据 | 意义 |
| --- | --- | --- |
| 现有候选不是最小输入组件 | `workspace-composer.js` 的旧 render 路径调用 `Frame`；Native `Nj -> yj -> bD` | `hideThreadContent` 去掉正文，并没有去掉 thread layout、滚动、路由副作用。新实现应验证直接 composer 路径 |
| 实际输入组件可单独发现 | thread 模块导入 primary `Fc as Ym`、`xf as qh`；`bD` 调用 `qh(Ym(props))` | 不必继续用 Frame 获取完整输入器。组件发现必须验证上下文/发送链路，不能只按导出名匹配 |
| 草稿初始值来自 composer scope | primary `sdt` 从 `Ke` 读取 Native 草稿和文档，派生 `ut`，以 `ut` 为 key 渲染 editor provider | thread、route、composer 身份必须一起切换；只改外层 conversationId 会导致错误模型/处理器 |
| EditorView 不提供 thread bind 方法 | initial `wel` 用 useState 固定初始内容；在 layout effect 中创建 controller，cleanup 后通过 timer 销毁 | 逻辑 bind 应走 Native keyed 生命周期，不能用 updateState 搬文档假装完成绑定。旧 controller 销毁晚于 DOM detach，需要计入清理测量 |
| 文档变更通过 Native transaction 更新 | initial `vTc` 的 dispatchTransaction 仅在 docChanged 时调用 onDocumentChange；`sdt` 对接 Native 文档存储 | 元数据 transaction / EditorView.updateState 不证明持久化同步，禁止重复此前恢复方式 |
| prompt 和文档有共享保存路径 | initial `jR` 对 client identity 与 conversation identity 保存 Native draft；`bxr` 按 conversation identity 定位文档 | 有实现同步的基础，但不是“同 thread 的所有活编辑器自动同步”的证据 |
| 活编辑器不会因每次外部 draft 改变重新初始化 | primary `uct` 在 scope/controller 等依赖变化时恢复草稿；`sdt` 初始内容读取的依赖不是持续的草稿订阅 | 必须验证并适配活主编辑器同步；禁止盲目覆盖当前主编辑器、合并冲突或猜测原值 |
| Native 保存有延迟路径 | initial `ekn` 非删除普通更新使用 250ms 延迟；shared persisted-state 有队列 | 不能用固定 sleep 或同步 dispose 宣称保存完成。发布通知与宿主已保存要区分 |
| 没有发现 owner 级编辑器互斥要求 | Native 输入注册表按 DOM 输入节点分发；旧 Adapter `activate` 自行循环停用同 owner 其他 record | 本轮已删除该策略，离线测试覆盖两个同时激活的句柄。若后续验证发现具体限制，显式 unsupported，不能暗中停用其他句柄 |

静态提取片段在 `.artifacts/workspace-composer-contract/`：`bD.txt`、`Nj.txt`、`yj.txt`、`GX.txt`、`sdt.txt`、`wel.txt`、`uct.txt`、`vTc.txt`、`jR.txt` 等。提取只解析源码，没有导入或执行 Native 模块。导出名仅是本次证据，不进入公开接口。

## 建议约定的最小差异

保留分屏侧提出的 `bind/activate/deactivate/focus` 形状和身份回执，增加明确能力标识、修订验证和异步收尾。旧候选只具有 `features.composer`，不得据此认为支持 bind。当前真实发现固定返回 `features.composerRebind:false`；只有验证完成的 profile 才能异步准备 driver 并在创建输入器之前通过现有 subscribe 公布 true，消费端无需调用 prepare API。

```ts
type Identity = { hostId: 'local'; threadId: string };
type Binding = Readonly<Identity & {
  bindingRevision: number;
  inputConfirmed: true;
  submitDisabled: boolean;
}>;
type RevisionOptions = {
  bindingRevision?: number;
  signal?: AbortSignal;
};

// mountComposer(container, { ...identity, onState? }) -> one owned handle
interface RebindableComposer {
  ready: Promise<Binding>;
  bind(identity: Identity, options?: { signal?: AbortSignal }): Promise<Binding>;
  activate(options?: RevisionOptions): Promise<Binding & { submitDisabled: false }>;
  deactivate(): void;
  focus(options?: { bindingRevision?: number }): boolean;
  close(options?: { signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}
```

`bindingRevision` 在句柄内单调递增，状态事件也携带身份和修订。加入 `activate/focus` 的可选预期修订，使旧的选择回调无法激活或聚焦新绑定；consumer 应总是传入 bind 回执中的修订。已有固定身份只读字段不能继续保留初始 ID 假装恒定；若保留，应为当前请求身份的 getter，实际确认身份以回执/状态为准。

1. **bind 不自动激活、聚焦、导航、发送或 resume。** 切换只操作自身；校验参数和 already-aborted signal 后，才使当前编辑器不可交互并取代旧绑定操作。新请求接受后，本句柄保持 inactive，直到对应修订的 activate 完成。绑定冷会话的必要读取通过既有 Native/Adapter 机制，不新增后台连接。
2. **回执证明真实绑定。** 原生 thread/route/composer scope、编辑器模型、注册的发送路径都匹配新身份，且旧 epoch 回调失效后才返回。仅外层 props 或有 contenteditable 不足。不能通过向真实会话发送消息验证此条件。
3. **取消不等于回滚或撤销 Native 工作。** 已发出的读取/提交到 React 的工作可能不可独立 abort；Adapter 取消后阻止晚到工作恢复编辑、聚焦或发布成功回执。失败/超时/取消后保持 inactive，不静默导航或回退为另一会话。预先取消的请求不破坏当前有效绑定。
4. **activate 只处理自身。** 它可调用 Native 正常的 resume/ownership 确认路径，只有该修订真正允许输入/提交才成功；writer conflict、不能 resume 或失配明确失败。它不取得其他编辑器的焦点，不停用同 owner 的其他句柄。
5. **IME 和附件操作不靠猜测切换。** 正在组合输入时，bind 应返回明确 `workspace_composer_busy`，由 consumer 决定何时重试；不能拆断组合文本。异步附件结果保留原操作的身份和修订，不可进入新会话；可安全完成、取消和释放的行为由 Native 路径决定并测试。
6. **原生草稿保留仍是硬条件。** bind 离开旧身份、close 和 retirement 都必须以 Native checkpoint/保存语义处理文档和附件，不能由 consumer 搬草稿文本；与现有主编辑器的同步需有冲突/版本校验，不得写回旧快照覆盖新草稿。
7. **close 是唯一必要的额外收尾方法。** close 立即阻止本句柄继续编辑/接收新操作，随后等待 Native 草稿交接及资源释放。同步 dispose 幂等、立即退役并启动同一个收尾过程，不承诺持久保存完成；close 可在退役后再次取得同一完成 Promise。Core `onCleanup` 等待此 Promise，在期限/信号失败时明确报告未完成。没有 Native 保存完成证据时，不能把超时等待当成功；应拒绝交付完整 rebind 能力。

`inputConfirmed` 说明模型/身份已确认，不等于已激活、已聚焦或已绘制。正文 file/review 动作和右侧主路由面板的归属不是 bind 回执覆盖的内容；已有 `mountTranscript` 同时要验证自己的 scope，不能用本回执开启未知归属的全局动作。

错误继续使用现有命名风格，区分 `invalid_argument`、`workspace_composer_unsupported`、`workspace_retired`、`invocation_cancelled`、`workspace_composer_superseded`、`workspace_composer_busy`、`workspace_composer_binding_drift`、ready/bind/activate timeout 和 cleanup incomplete。新契约不增加分屏、选中面板、缓存预算等参数。

## 双方独立推进

分屏侧可用这份契约的 fake Adapter 继续验证一个共享输入器的选择、修订、取消、焦点、实例预算和几何调度；无需等待 Native 测试，也不扩大池。Adapter 侧负责验证直接 composer 的 scope、发送身份、Native 草稿/附件同步、输入法和 cleanup，并优化既有 surface/transcript 重复工作。

Adapter 基准分两层：固定模拟 Native fixture 测包装层调度和资源归零；之后仅在版本钉选、registry/profile/PID/Target/会话数据都属于本次 run 的独立客户端测真正 Native 行为。必须用一次性合成会话/草稿，拒绝旧主窗口 ID。测试点默认关闭、不记录正文，报告 Native keyed 重建时间、就绪到可输入、持久化交接、observer/布局次数、持续 CPU 及关闭后恢复。50ms/100ms 是分屏侧目标，不是本次静态分析承诺。

若单输入器跨身份和存活主编辑器同步任一无法满足，集中交付具体阻塞及证据，由分屏侧重新选方案；不暗中改为多 composer 池。候选类型已注明可选 bind/close 与独立能力标识。协议实现不启用真实 Native 功能，不能把 fixture 的 true 当成支持的客户端 profile。

## 本轮落地和可复现证据

- `workspace-composer-binding.js`：单调修订、取消/取代、IME busy、身份和提交目标回读、仅自身激活、超时、退役后的 close。Native scopes、实际编辑器和草稿保存留给真实 driver，未以 DOM 存在或 props 变化代替确认。
- `workspace-composer.js` / `workspace.js`：句柄 getter 不丢失，能力准备先于 mount；Core onCleanup 等待 Native close；保存失败在 DOM/handle 删除后仍被保留，后续清理不能误报成功。不完整 driver 的资源也进入可等待清理。
- `workspace-transcript.js`：每个正文挂自己的 Thread/Route/Composer scope，主路由变化和 flag 更新保留 root/body/scroller；fixture 检查跨会话动作上下文。真实 file/review 全局面板归属仍待验收。
- `workspace.js`：只按角色节点变化增减 ResizeObserver 订阅；功能状态发布不重复读尺寸；流式正文变更不触发表面扫描/几何刷新。同尺寸替换角色节点仍发布快照，旧 observer 事件被忽略。
- `workspace-metrics.js`：默认关闭，启用时只记录有界事件、耗时、数字别名，不读取会话正文/草稿。默认路径没有测量定时器或时钟读取。

离线命令：`node tests/fixtures/workspace-acceptance/bench-wrapper.mjs`。输出 `.artifacts/workspace-wrapper-benchmark/report.json` 含 runId、Node 版本、bundle SHA256 和明确的非 Native 标识。矩阵 0/1/2/4/5/8 下，每个 provider 的七个稳定角色只订阅一次；200 次流式 fixture 更新没有新增 surface scan/geometry；五批外壳变更各合并为一次扫描/几何刷新；退出后 root 创建/销毁相等，记录的订阅归零。微任务安静不等于持续空闲 CPU 通过，模拟 bind 的耗时不用于承诺 Native 切换延迟。

真实 Native 输入器的具体未决项：local scope/发送链路与附加输入器的运行确认、活主编辑器同步及版本冲突、附件迟到归属、IME、250ms 前端保存队列和 500ms 宿主 debounce 后的落盘确认，以及 keyed controller 清理。现有 atom 更新广播及 sync/get-global-state 只确认内存，没有提供上述持久保存语义；不能用固定 sleep 或旁路写入无关状态补成 ACK。

Core 已完成 **26.1007.2314.0** 的独立 IPC 审核、匹配模板及登录后稳定性修复。Adapter 使用全新的自己的 run/profile，不共用 Core 测试实例，已在用户认证/初始化后重新核验实际所有权。Native 只读探针发现并修复最近文字匹配误停在 EditorProvider 的问题，最终确认主页的实际 composer facade/controller；`kind:new` 的该观察不证明 local bind 或草稿交接成立。

原草稿恢复仍是独立未完成项，准确资料保留在 `.artifacts/workspace-draft-recovery/handoff-2026-10-09.json`。这份评估没有运行新的写入测试，也不覆盖此前恢复失败的事实。
