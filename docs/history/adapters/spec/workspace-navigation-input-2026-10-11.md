# Native 主输入器导航候选：接口与验收

本轮候选保留 Native 主输入器、零额外编辑器、独立缓存正文；允许通过 `createNavigation` 切换主路由。布局、选中、缓存和实例预算属于分屏插件。Adapter 只补通用归属核验、显式聚焦和 IME 边界，Core 现有能力可以直接调用。`composerRebind` 仍为 false，独立可重绑输入器 driver 仍是研究项。

这些改动属于未发布的 UI Adapter 0.1.12 候选。没有更新日常实例或发布包。功能验证通过不等于分屏体验已经达到发布要求。

## 最小接口

- `await navigation.ready` 只返回 `undefined`，不暴露 Native 对象。
- `features.navigationInput` / `navigation.inputApi === 1` 标识准备后的严格输入契约。旧版可能省略；`features.navigation` 或包版本不能代替它。
- `open({threadId},{signal})` 返回既有 `executed`、`committed`、`dispose`。提交确认核验实际 Native local facade、Thread/Route scope、controller、editable 和提交回调，而不是外层 props。
- `focus({revision})` 单独调用。只有本 session 最新成功提交且完整路由、模型、scope、controller、editable、提交回调均未变化时才能聚焦；过期/漂移/操作已销毁返回 false，session/owner/provider 已退役抛 `workspace_retired`。`open` 不主动聚焦。
- 准备后，IME busy 在接受、替换旧操作、导航或可能的焦点变化之前同步抛 `workspace_composer_busy`。冷元数据读取结束后、实际导航之前再次检查。插件只能在 `open` 成功返回后应用 inert lease。

IME 跟踪共享两个 capture-phase 监听器，最后一个 navigation session 退出时移除。确认 observer 仅在已执行但未确认的操作期间连接，超时五秒，结束时取消 frame/microtask。没有周期轮询。模型对象和句柄修订只在 Adapter 内部保存，不给插件添加选中策略。

实际 Native 的 ProseMirror 节点可以直接附在 composer DOM 下，其 controller/提交组件却在该 host 的 React 后代分支。核验在已证明 committed 的当前输入 host 下做最多 2048 fiber 的有限检查，避免扫描正文树。导航复用已检查的输入描述，减少一次重复 ancestry/分支检查。

## 独立环境与数据边界

- Run：`adapter-44f7b16a-5596-4bf0-b079-f70095b71696`，根目录 `.artifacts/adapter-native/<run>/`。
- Native Windows 包：26.1007.2314.0。测试 lab SHA-256：`89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`。没有自动切换到后来 Core 提供的新 lab。
- 用户完成本 profile 认证/初始化后，核验了实际 coordinator、PID/创建时间/镜像、registry scope、Target、专属 loopback 后端、data/home/web profile 和只读配置。
- 测试创建八个专属、零 turn 的元数据会话，记录在 `synthetic-threads.json`。只有两个合成草稿使用 Native `setText` 写入；没有复制 EditorState、真实数据或认证。
- ledger 存在时必须显式 `--synthetic` 核验，不能因 `thread/list(useStateDbOnly)` 不返回空会话而称其为空 profile。Native resume 返回 Windows extended path；路径比较按同一 namespaced 形式核验。
- 所有临时 Host 只声明 `host.process` / `cdp.raw`，从已经验证的精确 Target 取会话，不选第一个 page，不替换生产 Workspace API。只在该 profile 注册，完成后通过其专属 CLI 移除。

第二次启动 coordinator 为 `1791713757017-31524`，Target 为 `28576E31029BCD8EA3C918849AAEAAE5`；正常重启后的第三次启动为 `1791719702118-17536`，Target 为 `762C194260C469341072B3B850D670C2`。这些只是历史证据，不能作为下次运行的常量。

最终 scoped 插件清单为空；通过 `Stop-TestClient.ps1` 正常关闭第三次启动。`retirement-1791719702118-17536.before.json` / `.closed.json` 复核 24 个已捕获 PID/创建时间身份全部退役，coordinator 为 closed，剩余所属身份为 0。保留 profile 的认证、合成数据和报告，没有删除或强杀其他实例。

后续 [进程归属审计](process-ownership-audit-2026-10-12.md) 发现旧 capture 缺子/父创建时间检查。此份未发现早于 manager 的成员，但缺父链，不能将捕获身份全部退出扩写为完整组归属认证；原报告保留。

## 已完成的 Native 功能验证

报告都位于上述 run 根目录：

| 报告 | 证据与范围 |
| --- | --- |
| `navigation-local-branch/report.json` | actual local facade/controller/提交路径通过，显式聚焦成功，旧修订拒绝；程序化 composition busy 保留路由 |
| `navigation-drafts/report.json` | 两个合成草稿通过 Native `setText` 更新 document/dictation，并通过普通导航保留；快速替换只确认最新操作 |
| `navigation-attachment-20261011-1/report.json` | Native selected-text attachment 切走/切回后保留，另一会话不串入，测试附件已移除；未测试文件/图片上传 |
| `navigation-bench-20261011-2/report.json` | 正常关闭并重开独立客户端后，两份合成草稿仍匹配；完成下面的暖导航对照 |

附件探针只在精确校验当前 Native initial asset SHA-256 后使用该版本私有的 Native helper；不是生产接口或通用附件封装。它不上传文件。草稿/附件测试没有声称宿主 durable-save ACK。程序化 composition 事件不等于真实系统 IME；冷读过程中开始 composing 的边界还由协议测试覆盖。

## 空历史 Native 正文矩阵

`navigation-body-20261011-2/report.json` / `summary.json` 全部通过。每个正文是独立 Native root/scroller；主会话正常导航两次后保留原 body 节点。总计创建 20 个 root、销毁 20 个 root，所有场景退出后受管 root 为 0，错误列表为空，额外编辑器为 0。

| 正文数 | 本次全部 ready（ms） | 同步清理（ms） |
| --- | ---: | ---: |
| 0 | 0 | 0 |
| 1 | 174.2 | 3.2 |
| 2 | 44.8 | 4.4 |
| 4 | 100.1 | 7.2 |
| 5 | 89.2 | 7.2 |
| 8 | 153.1 | 12.4 |

按此顺序测试且复用同一批会话，包含不同程度的缓存/冷历史读取；这些单次值不能推导线性每实例成本。所有历史为空，没有长消息、代码块、流式更新或真实消息动作负载。

每场景观察五秒 idle，用 CDP Performance 取同一 renderer 的 task/script/layout/style 和 heap 样本。可用同阶段窗口约 4.2 秒；task busy 分别约 33.0、11.2、93.7、8.8、11.6、9.5 ms/s，全部正文移除后一次窗口为 88.7 ms/s。波动不随实例数单调增长，当前不足以归因每实例稳态成本。它包含 Native 和探针流量，是 renderer task 时间，不是 OS 进程 CPU；不能与早前整个进程组的空主页基线相减。

## 暖导航对照与性能评价

最终报告为 `navigation-bench-20261011-2/report.json` / `summary.json`。两组各八次，顺序交替；每次都先到另一个会话并稳定 250ms 后，再计时真实切换；两组用相同实际 binding inspector。Adapter 使用与生产 Workspace 一致的已准备 host，不在每次调用中重新做 `locateHost()`。

| 路径 | 模型就绪中位数（ms） | 最小 / 最大（ms） |
| --- | ---: | ---: |
| Native 直接路由 | 318.45 | 269.4 / 353.1 |
| Adapter 导航确认 | 347.55 | 292.9 / 479.4 |

中位数相差约 29ms，不是纯 Adapter 成本的严格因果估计；八次也不足以建立稳定 P95。50 次稳定输入 inspection 的中位数为 6.5ms，P95 9.6ms，有一次 112ms 离群值，原因未定位。报告保留原始样本。

**目前不能宣称达到 50/100ms 的切换目标。** Native 主路由本身的模型就绪已需数百毫秒。此候选通过复用主输入器避免额外编辑器，但不能消除 Native 路由的输入器生命周期成本。分屏应独立评估即时正文选择与随后输入器确认的体验，或者选择另一个有证据的方案。Adapter 继续对必要归属检查、监听和挂载成本负责。

Chromium document 为 hidden，没有验证 HWND/Target 的前台 presentation 关系。所有这些数字都不是 Native paint、前台帧率、物理输入到画面延迟或拖动响应。

## 保留的失败与发布前缺口

第一次组合导航对照 `navigation-perf-20261011-1/report.json` 在 Native baseline 五秒超时；随后 `navigation-shell-20261011-1/report.json` 及 `native-shell.png` 显示 Native 错误页，导航栏/主 surface/input 全部消失。后续已找到实际 React 185 / Native PopperAnchor 更新 stack，并在冻结组合序列与跳过 IME 阶段的版本中复现；初始引用循环的触发仍未隔离。分段成本、观测器修正和后台调度限制见 [后续调查](workspace-navigation-investigation-2026-10-11.md)。不能因为重开后分离正文/导航测试通过就抹掉该失败。重开前后都重新核验了精确 owned 运行边界。

尚需长历史/持续流式正文、真实 IME、异步附件、前台 input/paint、持续空闲/交互和导航错误页复现/原因分析。当前交付是通用接口候选、协议回归及限定范围的 Native 证据；不是正式发布验收通过。既有真实草稿恢复事项没有在本轮操作或解决。

## 程序化入口

正式 bundle 重建成功；Adapter/Workspace/discovery/navigation/distribution 相关测试 150 项通过、0 失败、0 跳过。日志为 `.artifacts/workspace-navigation-input-suite-final.log`。新增回归覆盖完整 pin 漂移、IME 接受前/冷读后检查、同 ID controller 更换、旧版不声称新能力和退役操作撤销聚焦 pin。

`verify-native-run.mjs <owned-run> --synthetic` 核验当前实际身份。`build-native-navigation.mjs <owned-run> <fresh-navigation-label>` 构建私有 Host；模式包括 `--navigation-bench-only`、`--body-only`、`--attachment-only`、`--performance-only`、`--inspect-only`、`--shell-only`。包先 preview，再只通过专属 `Test-Plugins.ps1` 注册/移除。控制台 import applied 只证明激活；以独立最终 `report.json` 为测试结果。

长测量以 owned symbol 保存临时状态，Host 用短 CDP 请求等待，避免单次请求跨过 Core 的 15 秒期限；取消信号进入探针并清理资源，结束后删除状态、关闭 Performance 记录并 detach。`summarize-native-navigation.mjs <explicit-report>` 只离线分析自己运行的报告，不连接客户端。测试点与探针都默认不在生产 activation 中运行。
