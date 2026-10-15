# Native 导航错误与分段耗时调查

本轮沿用独立 Adapter profile 和八个合成、零 turn 会话，回应首个 Native 错误页及暖导航耗时两个缺口。公开接口保持原候选不变：`features.navigationInput` / `inputApi === 1`、`ready: void`、两阶段 receipt、显式 `focus({revision})`、同步 IME busy。分屏继续独立选方案、测上层成本；Adapter 负责其检查和资源成本。没有发布、推送或安装到日常客户端。

后续已确认 raw router 与 Native 通用会话入口并不完全等价，并修改严格候选使用既有 Native 动作；源码、受控对照和保留边界见 [2026-10-12 入口核对](workspace-native-navigation-action-2026-10-12.md)。本文件的原始测量和失败报告继续保留，不能将后续修正倒推为这些样本的性能收益。

## 首个错误页：异常和调用路径已定位，初始触发仍未隔离

历史运行 `1791713757017-31524` 的 Native PID 34516 日志在 **2026-10-11T11:48:51.307Z**、第 15775 行记录 `AppRoutes` error boundary，错误为 **Minified React error #185**。React 官方说明是嵌套更新超过深度限制：[React 185](https://react.dev/errors/185)。原始完整 stack、component stack、日志行哈希和源码片段保存为 run 根下的 `native-error-185-evidence.json`。

关键帧：

```text
Er / Cr / mo / xte                  app-shared-737655e1fb23.js:90
Native anchor effect               app-shared-737655e1fb23.js:171:35587
component: PopperAnchor             app-shared-737655e1fb23.js:171:35361
component: PopoverAnchor
component: N                       toggle-thread-summary-panel-20b6a6d27c1c.js:1:556
component: thread-app-shell-chrome → local-conversation-page → AppRoutes
```

核验原版本 Native shared 源码 SHA-256 为 `a1daa891e89a395b8db399ff6eaa365f12a86880c3d8cf891caf4ccbcb9eebf5`。该帧所在的 `PopperAnchor` effect 比较 `virtualRef.current`，引用变化时调用 `onAnchorChange` 更新 Popper anchor state。调用方是 Native 会话摘要按钮的 virtual anchor。`native-anchor-source/manifest.json` 保存两份只读提取源码的哈希；没有修改或执行替代 Native 代码。

这证明异常参与原生 anchor 更新路径，尚未证明 virtual anchor 持续换引用的初始原因，也未排除组合探针的导航节奏/状态交错。不能将错误简单归为“Adapter 检查慢”，也不能声称它是脱离本测试序列的纯官方 bug。

| 独立报告 | 变化 | 结果 |
| --- | --- | --- |
| `investigation-replay-1/report.json` | 复用历史 `navigation-perf-20261011-1/probe.js`，验证冻结 bundle 哈希；仅新 Host 使用当前 owned Target/coordinator | 再现 React 185；Native baseline 五秒超时，主输入器消失 |
| `investigation-no-ime-1/report.json` | 同一冻结序列，只跳过程序化 composition 测试阶段 | 再现 React 185；说明该 IME 测试阶段不是必要条件 |
| `investigation-no-rapid-1/report.json` | 同一冻结序列，只跳过 rapid replacement 阶段 | 没有捕获 React 异常，但 paired 阶段先被 `desktop_navigation_superseded` 拒绝；不能据此证明 rapid 是根因 |

三个报告均保留失败。最后一个不能当作完整通过的反例。原错误页报告/截图也仍保留。临时 Host 增加按精确 owned CDP session 筛选的异常捕获，最多 32 条、message 最多 4000 字符，保留真实 stack；在退出时 unsubscribe 并 detach。它不进入生产 activation。

## 分段测量：主要间隔位于 dispatch 后，背景调度是实测限制

计时入口为 `native-navigation-timeline.js`，构建时直接引用生产私有 discovery/navigation/input inspector。每次先切到另一合成会话，等待稳定，再从真实切换开始计时；每组四轮，交替顺序。Native 与 Adapter 使用同一个准备好的 router 和真实模型核验。

三种路径：

- `native-strict`：直接 Native 路由，在 DOM 变化时核验实际 facade/scope/controller/提交归属。
- `adapter`：生产导航实现；额外 DOM observer 只记录时间，实际核验由生产 provider 完成。
- `native-dom-only`：切换期间只记录 DOM，不连续扫描模型；请求等待 250ms 后才做实际归属核验。这是诊断路径，其后验模型时间不是最早就绪时间，不能用来削弱生产检查。

**观测器修正：** `investigation-timeline-1` 曾误取缓存的 inactive composer，导致 DOM-only deadline；`timeline-2` 的旧 DOM identity 也不足以证明复用。已保留报告，并修正为排除 owned/inactive page，优先当前唯一 Native main composer，上一实例取自 actual inspector。`timeline-3/4` 中实际 active composer DOM 和 controller 均发生更换，撤回“外层 DOM 被复用”的早期判断。

下表均为中位数，单位 ms。`timeline-3` 为优化前，`timeline-4` 为最后一轮。最终汇总为 `investigation-timeline-4/summary-final.json`。

| 路径 / 阶段 | 优化前 timeline-3 | 最后一轮 timeline-4 |
| --- | ---: | ---: |
| Native strict：router.push 同步调用 | 0.30 | 0.45 |
| Native strict：首个当前输入 DOM | 204.95 | 287.10 |
| Native strict：实际 model/controller 被核验 | 206.05 | 308.80 |
| Native strict：累计 inspector 成本 | 4.55 | 27.00 |
| Adapter：router.push 同步调用 | 0.20 | 0.35 |
| Adapter：首个当前输入 DOM | 204.05 | 322.70 |
| Adapter：实际 model/controller 被核验 | 210.35 | 343.20 |
| Adapter：committed receipt | 210.45 | 343.55 |
| Adapter：累计 inspector 成本 | 11.20 | 34.85 |
| Adapter：canonical scope validation 总成本 | 0.10 | 0.00（计时精度内） |
| Native DOM-only：首个当前输入 DOM | 196.75 | 292.35 |

最后一轮 Adapter owner/native connection check 累计中位数 0.45ms，分别每次 7 / 5 次；不是主耗时。router promise 的时间相对整次操作起点，含 Adapter dispatch 前检查，不能把它全部当作 router 内部耗时。

dispatch 返回后 microtask 的中位数 Native strict 为 0.05ms、Adapter 为 0.15ms、DOM-only 为 0.05ms；多数零延迟 timer 也很快。但 DOM-only 有一次 timer 延后 **308.80ms**；请求 250ms 的 settling wait 实际为 **677–722ms**。Adapter 有一条零延迟 timer 在操作结束前未回调，已取消，汇总保留 n=3，不能填成零。

因此，dispatch 后到 Native DOM/model 出现之间确实有较长间隔，且在切换期间不连续 inspector 的诊断路径仍存在。最后一轮也观测到后台 timer 延后；尚未把 Native 生命周期、后台调度与其他 renderer 工作严格做因果分解。前后两轮 Native baseline 自身显著变慢，**不能用总耗时前后差宣称优化收益，也不能给前台建立固定延迟下限**。

这些运行的 Chromium document 是 hidden。没有验证前台 HWND/Target 的 presentation 关系，没有 paint、真实输入响应、长历史或流式负载证据。每路径四轮也不支持稳定 P95。

## 唯一生产优化与验证

`open` 的同步 IME preflight 已取得真实输入描述，紧接着的 started binding 核验复用这个描述，省掉一次重复 DOM/fiber 检查。两步间没有 await；canonical scope validation 仍执行。显式 null 也保留，不偷偷再扫一次。run 前和冷 metadata 返回后的 IME 检查、后续完整 binding pin、路由漂移、退役和 focus 检查全部保留。

协议回归新增断言，确认开始 binding 使用相同的 preflight 描述。公开 types/features 没有扩展。Native 整次操作记录的 inspector 次数在两轮为 8 / 6，但其中还包含 pending observer 和最终诊断核验，**不能把全部次数变化归于这一个优化**。

bundle 重建成功，相关测试 **150/150 通过、0 失败、0 跳过**；日志 `.artifacts/workspace-navigation-investigation-suite.log`。最后两份修正后的 timeline 均 12/12 通过，`nativeErrors=[]`，额外 editor=0，最终 owned roots=0。通过只覆盖这些明确场景，不解除组合序列的 React 错误缺口。

## 运行边界与清理

run 为 `adapter-44f7b16a-5596-4bf0-b079-f70095b71696`，Native 26.1007.2314.0，继续使用 lab SHA `89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`。核验 ledger 八个独占合成会话、0 turn；没有改写既有两份合成草稿、真实数据或认证，也没有发送模型请求。旧草稿恢复事项未在本轮操作或解决。

最后 coordinator `1791725232382-4856`，Target `B4B1DBBE210F2256B25C979FA1BA5876`，这些身份只用于本轮证据，不是下一次常量。最终 scoped 插件清单为空，正常 `Stop-TestClient.ps1` 后 `retirement-1791725232382-4856.closed.json` 确认 25 个已捕获 PID/创建时间身份全部退役，剩余 owned processes=0；保留 profile 和所有报告。

后续 [进程归属审计](process-ownership-audit-2026-10-12.md) 修正旧 capture 的 PID 复用缺陷。此份没有发现早于 manager 的成员，仍因缺父链不能完整认证组归属；捕获身份退出与全部属于该组是两个不同结论。

可重用程序入口：先 `verify-native-run.mjs <owned-run> --synthetic`；再 `build-native-investigation.mjs <owned-run> <fresh-investigation-label> replay|timeline [exact|no-ime|no-rapid]`，通过专属 CLI preview/add/remove。离线 `summarize-native-timeline.mjs <explicit-report> [fresh-summary-name.json]` 不连接客户端，不覆盖旧报告。下一步需要隔离 virtual anchor 引用循环的触发条件，并建立有证据的前台交互测量；不增加面板数量、自动选择策略或常驻 editor 抽象。
