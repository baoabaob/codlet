# 小粒度 Native 输入器：源码进展与未决项

2026-10-11。直接组件渲染、实际绑定核验、取消和显式 controller 清理已有候选代码。Native 草稿/附件生命周期桥接尚未实现，真实 `composerRebind` 仍为 false；此文不证明 Native 输入器或性能已可交付。

## 当前版本的源码依据

只读提取当前签名安装包 **26.1007.2314.0** 的 app.asar，没有导入或执行提取的模块。可复现工具为 `tests/fixtures/workspace-acceptance/extract-composer-source.mjs`，必须给新输出目录和版本；仅提取 shared/initial/primary/thread 相关资产。manifest 与格式化片段位于 `.artifacts/composer-native-26.1007/`。

| 角色 | 本次静态名称 / 导出 | 依据 |
| --- | --- | --- |
| 通用 composer | `$X` / `xc` | 按 useAsbDirect 选择 runtime/account，再渲染 `rpt` |
| surface 包装器 | `qV` / `lf` | 给子元素注入 surfacePlacement，保留 Native transition |
| Scope facade hook | `hA` / `Fan` | 从 Native context 得到实际 node/chain，提供 get/set/watch |
| Native controller factory | `DBc` / `Zp` | 创建 Native editor view 并返回 controller，保留 Native registry/enter/plain-text 行为 |
| editor provider | `Rhl` / `ft` | 支持外部 composerController；内部创建路径有 dispose 回调和延后 destroy |

上述名称是证据，不写入产品的固定导出映射。候选 discovery 按语义匹配且要求唯一；其运行时唯一性仍要在本次测试实例验证。

## 已落实的直接路径

`workspace-native-composer.js` 使用实际 Native Composer/ComposerSurface，挂自己的 Thread/Route/Composer scope 和单个 React root，正常文档流内渲染。它不挂 Frame、正文、滚动框架或 100vh 尺寸占位；不导航、自动聚焦或停用其他句柄。

绑定核验只读检查 committed ancestry，找到最近实际持有 Native composer facade 的组件、当前 editable 对应的 Native controller，以及 Native registerSubmitHandler 路径。EditorProvider 也命中相同 props 文字，不能直接取最近文字匹配。实际 scope node、conversationId/clientThreadId 和发送组件必须对应请求身份。仅 Adapter props 或 DOM 存在不算确认，也不会调用发送函数验证。

驱动要求生命周期桥接创建一个真正的 Native controller，再传给 `composerController`。当前 `Rhl` 在有外部 controller 时跳过内部创建/文档 dispose/延后 destroy 分支。驱动显式管理该 controller 的释放，避免自己依赖 Native 内部销毁回调保存旧文档；它没有复制或更新 EditorState。跨身份可重建 controller，保留逻辑句柄/container/root。

就绪和激活只在 pending 操作期间观察 owned subtree；提交确认后断开，没有轮询。取消/退役阻止晚到准备分配 editor；bind 先准备新身份再检查旧模型 checkpoint，之后才替换视图。被替换 controller 在实际 detach 后释放，失败路径的 controller 也纳入清理。

## 仍缺少的 Native 生命周期

驱动的私有 `composerLifecycle` 必須实现 prepare/createController/checkpoint/acquire/released；缺任一方法就在创建 editor root 之前拒绝。生产 discovery 目前没有这个 bridge。fixture 的 bridge 只验证调用次序和资源边界，不是 Native 数据实现。

具体待解决点：

1. 用 Native scoped 草稿和完整附件/view state 初始化 controller；附件异步结果的 generation/身份必须保留或正确取消。
2. 同一会话仍存活的主输入器需要同步 Native document、dictation state 和附件，且验证版本冲突。当前 `out` 的恢复 effect 并不证明每次外部草稿变更都会同步活 controller。
3. `rpt` 的内部 dispose 通过 `pYr` 保存传入的旧 controller 文档，`pYr` 同时读取当时的全局 prompt，写整个 retained-document map，没有版本条件。外部 controller 避开 owned editor 的这条路径，但存活主 editor 的风险仍需解决；不能直接宣布 Native 已支持多实例同步。
4. prompt 的 `Kfn.setDraft` 有 expectedValue 分支和 250ms 普通延迟路径；这些函数返回/本地 store 更新仍不证明宿主保存完成。需要找到并验证实际宿主确认及冲突结果。
5. Core cleanup 必须等待真实 checkpoint/释放结果；Native 注册、附件资源和 delayed callback 的归零仍待实测。

## 验证和环境状态

新增五项真实 React + 合成 Native 部件测试：直接 scope/model 绑定、checkpoint 后重绑定、缺 bridge 拒绝、准备中退役禁止晚到 root、checkpoint 失败以及 DOM 仍在时的实际模型失配。它们不使用当前客户端、不读取真实草稿，也不证明当前 Native ABI 或持久化。

重新构建后，相关 Workspace/driver/discovery/Adapter/navigation/distribution 检查 **143 项通过，0 失败、0 跳过**；日志在 `.artifacts/workspace-native-driver-expanded.log`。默认 Native 重绑定门槛未改变。

Core 已完成新版隔离审核并准备了自己的测试实例，见 `X:/codlet/docs/native-isolation-26.1007.2314.0.md`。Adapter 单独的计划为 `adapter-0e9c57df-46a6-4c91-9603-8b20411a52fd`，记录在 `.artifacts/adapter-native/`；不复用 Core 的 PID/Target/profile。

首个 Adapter lab 仅到 prepare 阶段，未启动 Desktop 或后端。工具的关闭 stdin 使准备 Host 无法接收 quit；核对 PID、创建时间、镜像和无子进程后，只停止了本次 Host。随后受支持的 resume 明确拒绝该未记录正常退出的准备报告；保留原始日志，没有修改恢复证据。该目录不算可运行测试实例，没有复用。

此前分屏会话集中回报 Core 登录后 Local Work startup_failure 和 renderer 重初始化阻塞；该历史阻塞已由 Core 在自己的 run 修复并提供稳定性记录。

Core 后续提供了修复及正常模式稳定性证据。本轮准备了全新的 Adapter run `adapter-44f7b16a-5596-4bf0-b079-f70095b71696`。用户完成认证/初始化后，Adapter 独立核验 ready、空数据及重启后的实际 PID/Target；只读探针完成当前组件发现和主页 Native facade/controller 核验，并修正 EditorProvider 误匹配。详见 [测试环境及保存边界](workspace-native-environment-2026-10-11.md)。旧未干净准备目录保持原样，不复用。

Native local 输入器的挂载/重绑定/主编辑器同步/持久化验收和多实例性能矩阵尚未完成；只读发现没有替代它们。日常客户端及真实草稿保持未操作。
