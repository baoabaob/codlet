# 严格导航改用 Native 通用会话动作

本轮核对发现：原 Workspace 严格输入导航直接 `navigator.push('/local/'+id)`，与 Native 侧栏的普通本地会话入口**不完全等价**。现候选通过 Native 已有的通用会话动作和已挂载 AppNavigationSignalBridge 导航。公开 `navigationInput` / `inputApi===1`、ready、receipt、focus、IME 契约不变。没有增加面板、缓存、互斥或新的公开接口，也没有发布到日常实例。

## 源码证据和边界

读取并校验安装包 26.1007.2314.0 的 ASAR header SHA-256：`6b993af172cfc4425644e357856706390067ea457bc76bc11d0d3d5905c3bab5`。缓存副本还与安装包字节哈希逐项匹配：

- initial：`799331dde54905c4df5e360f23a9621141759e2c0acb230aeab909f9904b646f`。
- shared：`a1daa891e89a395b8db399ff6eaa365f12a86880c3d8cf891caf4ccbcb9eebf5`。

run 根下 `native-navigation-source-final/manifest.json` 记录原始行/列和函数范围；其余文件只是 Acorn 按函数范围截取、格式化的静态源码，未执行或修改 Native 源码。

| 位置 | 规范路径中的职责 |
| --- | --- |
| initial `CZo` → `oqo`，3817:125301 起 | 侧栏普通 local row 先 `$tr(scope,localKey,host)`，再 `Qtr` 处理 Native 导航状态，最后调用 `Ere` |
| shared `aIt`，422:67313 | `Ere` 对应的导出；调用当前 scope 的 bridge `navigateToLocalConversation` |
| initial `DF`，1627:22581 | 已导出的通用 thread-key 导航动作；复用 `$tr`、`Qtr` 和本地/其他路由分派。生产发现其语义签名，未硬编码 minified 导出名 |
| initial `zHa`，3578:322539 | 安装 bridge；本地入口处理离开设置页的检查、取消 retained navigation / Orbit prewarm，再调用本地导航 hook |
| initial `iJ`，1741:86278 | 处理本地 host/访问参数、同路由 replace 状态及 `zp.start` 启动追踪，再调用 React Router navigate |
| shared `Vk`，294:119173 | signal 使用 `node.signalBindings`，cached query 使用另一张表；不能以 cachedBindings 核验 bridge |
| shared `hA`，294:146557 | 挂载的 AppScope hook 将 Native imperative facade 放在 ref，提供真实 get/set 和当前 chain |

侧栏自身的导航状态提供器、行回调、菜单和选中 UI 属于侧栏策略。本通用动作使用 Native 默认状态处理，不复制侧栏组件或强加分屏策略。只接受同一 local thread/host 的 Native 回调；其他 route kind 或拒绝导航明确失败。

`$tr` 调用的 `Op.abortConversation` 在本版本终止导航离开的待完成响应追踪；**不是停止模型任务**。本 profile 为零 turn，它不能被当成此次 React 185 消失的已证明原因。此前对此处“撤销启动”的粗略描述在此更正。

## 实现

- 从唯一 bridge 缺失 marker 后的有界 initializer AST 找到 signal 导出，不执行源码、不按固定压缩名取值，不解析完整大模块 AST。
- 要求 signal 属于现有 local connection 的 AppScope 且已经在 `signalBindings` 中绑定；读取已挂载 bridge，不解析未绑定默认值，也不创建连接、scope、router 或 editor。
- 从经过 committed ancestry 证明的 Native 导航祖先链取得真实 AppScope facade，核对 token、node、chain。与 composer 无关，因此从没有输入器的设置页也能准备和导航；不借用旧编辑器模型。
- 调用 Native 通用动作，传入本版本已核验的 `local:` thread key 和 bridge 本地回调，保留 Native 返回的 host/options。每次使用当前 bridge/facade，避免保存过期闭包。
- 严格 `inputApi===1` 缺少规范入口时拒绝 ready；不静默退回 raw router。旧 `inputApi=0` 的兼容路径保留。此变更只针对 Workspace 严格候选，未改 Desktop Adapter 的其他导航入口。

既有同步 IME 接受前检查、冷读取后检查、完整 binding pin、显式 focus 修订和退役检查均保留。能力名、types 和 SDK 消费方式没有变化。

## 独立 Native 验证

沿用 `adapter-44f7b16a-5596-4bf0-b079-f70095b71696` 及原 lab SHA `89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`。只使用 ledger 八个合成会话、0 turn；没有改写已有合成草稿、真实数据、认证或 Native 代码，没有模拟点击、关闭浮层或发送模型请求。

| 报告 | 结果和解释 |
| --- | --- |
| `investigation-canonical-local-1` | 第一版误用 cachedBindings，准备时拒绝，未执行导航；保留报告 |
| `investigation-canonical-local-2` | 构建产物，未激活；在修正错误路径的探针清理后换干净进程继续 |
| `investigation-canonical-local-3` | 仅通过 bridge 替换冻结序列的两处 dispatch；依然 React 185 / Native baseline timeout，因此仅换 bridge 不足 |
| `investigation-canonical-local-4` | 使用完整 Native 通用动作；冻结序列全部通过，无 Native 异常。此中间实现从 composer 获取 facade，后来设置页场景揭示限制 |
| `navigation-canonical-contract-1` | 当前实现的 cold/warm/focus/IME/replacement/idle 六阶段通过，但从设置页打开因缺 composer scope 失败；无 Native 异常，失败保留 |
| `navigation-canonical-contract-2` | 修正为实际 AppScope facade 后，全部七阶段通过；开始时无 controller/editable，inputApi=1；从设置页准备/打开、再次进入设置页并打开均成功，nativeErrors=[]，额外 editor=0 |
| `investigation-canonical-local-5` | 最后干净进程，用最终 AppScope 实现替换冻结序列的两处 dispatch；cold/warm/focus/IME/replacement/paired 全部通过，16 个 paired 样本完成，nativeErrors=[] |

canonical 对照保留历史 bundle 哈希核验，只修改被审阅的两处 dispatch，未 monkeypatch Native router 或组件。最后一轮显式跳过错误发生点之后的旧 inspection/body/idle 矩阵。第四轮因冻结原序列在错误未出现后继续执行，附带完成旧矩阵；报告如实保留，不将它扩写为新的性能结论。最终 contract-only 入口跳过草稿写入和全部性能/正文矩阵。

这些结果支持修正已有通用导航的规范入口，并提供两次成功的完整动作对照。但尚未做逐步骤消融来隔离 virtual anchor 引用循环的最初触发；进程、时序和缓存条件也不同，不能宣称 React 185 已被严格根因修复。raw / bridge-only 原失败仍保留。没有长历史、真实 IME、流式负载或前台 paint/输入延迟验收。本轮不对性能前后差或前台延迟下限作结论。

## 回归和清理

bundle 重建，相关 **155/155 测试通过，0 失败、0 跳过**，日志 `.artifacts/workspace-navigation-canonical-suite-final.log`。新增回归覆盖未绑定 signal、错误 scope/退役、最新 bridge、Native 拒绝/改变 host/任务/route kind、严格入口缺失和真实入口调用；原有 IME/输入归属测试继续通过。

最后 coordinator 为 `1791737424886-54696`。最终 scoped plugins=[]；正常关闭后 `retirement-1791737424886-54696.closed.json` 确认 25 个捕获身份全部退出，remainingOwnedProcesses=0。前面三次本轮已关闭运行的捕获身份也分别 25/23/25 全部退役。profile、认证和所有报告保留，未触碰日常客户端。既有真实草稿恢复事项没有在此操作或解决。

后续 [进程归属审计](process-ownership-audit-2026-10-12.md) 逐份读取上述旧 capture。没有发现早于 manager 的成员，但因未保存父链，不能把捕获身份退出当作完整组归属认证。旧数据继续保留，新的 capture 已修正算法。

新增静态入口 `extract-native-navigation-source.mjs <owned-run> <fresh-native-navigation-source-label>`；受控对照 `build-native-investigation.mjs <verified-owned-run> <fresh-investigation-label> replay canonical-local`；当前生产路径功能验证 `build-native-navigation.mjs <verified-owned-run> <fresh-navigation-label> --contract-only`。临时 Host 错误/异常退出也会核验 owned control 状态并清理已完成状态；未完成状态只能取消并报告 failed，不能声称已清理。
