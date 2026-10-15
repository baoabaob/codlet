# Adapter 独立 Native 测试环境

2026-10-11。使用 Core 修复后的源码模板和 lab，SHA256 为 `89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`。Core 登录后稳定性记录在 `X:/codlet/docs/native-refresh-2026-10-11.md`；其证据没有替代本次实例核验。

新 run：`adapter-44f7b16a-5596-4bf0-b079-f70095b71696`。控制目录为 `.artifacts/adapter-native/<run>/`。没有恢复旧的未干净准备目录，也没有复制日常或 Core 测试 profile 的数据/凭据。固定 Node 分发文件取自已经审核的 runtime 源缓存，构建时校验 executable/LICENSE。

## 准备与实际状态

`prepare-native-run.mjs` 只创建新计划及版本/签名/hash 预检；`prepare-native-profile.mjs` 通过真实 stdin pipe 到 prepare 后正常 quit，未启动 Desktop/后端。随后用更新的 Build-IsolatedClient 和 Start-TestClient `-Onboarding` 启动本 run。

`verify-native-run.mjs` 只读核对 PID+创建时间+镜像、专属 loopback listener、registry/data 路径、owned pipe 的动态 renderer Target、实际后端配置及活动/归档空列表。完整控制证据在本 run 的 `owned-runtime-evidence.json`；PID 和 Target 是历史采样，后续每次重开都重新核验，不作为常量。

初次核验为 `awaiting_authentication`。用户正常完成认证和 Windows 初始化后，协调器按审核模板重启了自己的 Desktop/后端；再次只读核验得到 **ready、authenticated true、sandboxReady true，活动/归档各 0**。专属 listener、file credential store、read-only、禁用 Desktop app tools、registry/data 路径和新的动态 Target 均一致；没有复用重启前的 PID/Target。

认证只经过本 run 的测试入口，账号内容没有记录。等待期间的 onboarding readiness 检测不列入 idle CPU 性能样本。任何初始化重启后都重新读取 state 和动态 Target。

## 当前客户端的只读探针

`build-native-discovery.mjs <owned-directory> [discovery-label]` 只为已核验的空数据 run 生成新包，不覆盖既有探针。Host 再核对 ready/run/registry scope 和指定 Target，然后使用该 Core 的 CDP 会话执行自己的只读模块发现；不选任意第一个 page、不调用 Adapter activate、不新建后端连接。

三个已完成探针依次核对组件、模型定位和修复结果，报告在本 run 的 `discovery-probe/`、`discovery-model-probe/`、`discovery-binding-proof/`。小粒度 Composer、ComposerSurface、Thread/Route/Composer scope、useScope 和 Native editor factory 均唯一可发现；既有 Native manager/requestClient 保持同一对象。三个临时插件均已通过专属 `client/Test-Plugins.ps1` 移除，保留源码/报告。

实测发现 `EditorProvider` 与真正 composer 都命中 onDocumentChange/onDocumentDispose/composerController 文字条件。旧 inspector 取最近的文字匹配，误停在没有 composer facade 的 EditorProvider。现改为取最近实际持有 Native composer facade 的组件；合成 React fixture 增加真实形状的 EditorProvider，五项 driver 回归通过。修复后的 Native 探针确认当前主页输入器为 `kind:new`，committed facade 与一个未销毁的实际 controller 可读。它没有本地会话 ID，**不证明 local 绑定、附加输入器、activate 或 rebind 已通过**。

探针的 mountedRoots/draftWrites/sentTurns 均为 0，`composerCapabilities.rebind` 仍为 false。读取和导入的发现阶段耗时受冷模块初始化、源码解析及 hidden 页面状态影响，不解释为输入切换或绘制延迟。

生成的 runtime CLI 包装器将 namespaced root 传给 lab 的严格预检时被拒绝；使用已审核客户端模板自带的 `Test-Plugins.ps1`，其参数直接从 `list`、`preview`、`add` 等子命令开始。该入口回执的 registry scope 与本 run 完全一致，未改 Core 源码或注册表。

## 程序化空页面基线

移除临时探针后，旧 `measure-native-baseline.mjs` 报告五个区间、跨度 35.03 秒、25 个身份无新增/退出、CPU 总量 2.719 秒（单核 7.76%、20 核整机口径 0.388%）。原 `empty-home-baseline.json` 保留。**后续发现旧进程归属算法缺陷，且这份报告没有父链和每区间原始进程数据，已撤回上述数字作为独占测试组 CPU/内存或 Adapter 成本证据的资格。** 逐份审计及新算法见 [进程归属审计](process-ownership-audit-2026-10-12.md)。

这是当前测试客户端发现模块已加载、最后探针 visibility 为 hidden、没有 Adapter 根节点的短时空主页基线，包含 Native 背景服务。没有 1/2/4/5/8 根节点的对照，没有前台输入/绘制延迟，不能归因 Adapter 增量或宣称分屏不卡。子进程若退出则最终 CPU 不可获取，脚本将进程变动明确标记为非稳定，不把它解释为稳态通过。

绑定核验修复并重建后，相关检查再次 **143 通过、0 失败、0 跳过**，日志 `.artifacts/workspace-native-auth-suite.log`。临时 Native 探针成功与这组模拟检查均不启用 `composerRebind`。

结束前再次核验 ready/认证/初始化、活动和归档空列表及 registry 无临时插件。随后通过本客户端的 `Stop-TestClient.ps1` 正常请求退出，协调器记录 closed、Host exit 0，专属后端在 Desktop 退出后停止；按旧基线所记 PID+创建时间复查，25 个捕获身份均已退出，该清单的完整组归属未能在后续审计中复核。独立 profile/认证和报告保留，后续重新启动必须再核验新 run/PID/Target。

## 新确认的持久化边界

Native 当前保存链路为：frontend `bI/yI/hI` 发布 atom → 主进程 `updatePersistedAtomState` 调用 GlobalState.set → 广播 `persisted-atom-updated`。该广播不等待文件写入。

主进程 GlobalState 的 `persistForKey('electron-persisted-atom-state')` 使用 **500ms debounce**，随后进入自己的 persistQueued；其 `flushOrThrow()` 能等待并传播保存失败，但不是上述 atom-update 广播的语义。`persisted-atom-sync` 和 `get-global-state` 读取内存状态，同样不是落盘证明。源码片段在 `.artifacts/composer-native-26.1007/{updatePersistedAtomState,HostGlobalState,hI}.txt`；已核对当前 26.1007.2314.0 包。

因此，真实 composerLifecycle checkpoint 不能把收到广播、读取相同值或固定 sleep 当成 durable ACK。仍需核对现有 Native 主进程可等待的保存入口，以及 UI Adapter 当前授权范围如何访问它。测试可观察专属 profile 的文件保存结果，但该测试观察不会自动变成产品可调用能力；也不应改写无关全局状态来强迫刷盘。

重绑定能力继续关闭。Native 生命周期桥接、存活主编辑器同步、附件/IME/版本冲突、真实保存确认和稳定性能矩阵仍未完成。
