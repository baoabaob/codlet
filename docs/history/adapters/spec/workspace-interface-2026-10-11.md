# Adapter 分工与本轮交付

用户目标是流畅、轻量、低开销的分屏体验，接近原生；是否自行渲染正文、复用 Native 组件或采用独立渲染视图，由分屏方案评估决定。隔离不是预设要求。官方另开窗口可以并行响应，但它带来的进程、内存、初始化和通信成本，不能直接等同于单窗口分屏的最佳方案。

## 已对齐的边界

| 层 | 负责内容 |
| --- | --- |
| 分屏插件 | 选定整体方案；布局、拖动、选中、缓存、预热、实例数量、渲染调度和输入器协调 |
| Adapter | 本次暴露出的真实缺口中，适合其他插件复用的 Native 适配、身份绑定、通用生命周期、错误和资源清理 |
| Core | 已有的控件、挂载、存储、生命周期、主题和诊断等公共能力；分屏可直接调用，无需为了统一形式经过 Adapter |

性能问题优先检查分屏层的实例策略和更新调度，同时测量 Adapter 的每实例、订阅、尺寸读取和挂载成本。不能未经测量把责任全部归到任何一层。双方先约定最小接口，随后各自在自己的仓库实现、评测和优化；在接口变化、具体阻塞或交付时集中同步，不持续串行指挥联调。

分屏会话最新选择是保留 Native 主输入器、零额外编辑器、独立缓存正文，通过 `createNavigation` 切换主路由。主路由切换是该候选方案允许的操作；Native 负责正常导航中的草稿/附件生命周期。已停止扩大常驻输入器池。自绘和独立嵌入视图仍可作为有证据的替代方案；不因复用接近原生而忽略它的成本。

## Adapter 当前结果

- 删除激活一个 composer 时自动停用同 owner 其他句柄的策略。独立句柄只影响自身。
- 实现候选 bind/activate/focus 的身份修订、取消、IME busy、超时和 close/清理边界；公开句柄保留身份 getter。能力准备可在 mount 前通过现有订阅观察到。
- 每个正文提供自己的 Thread/Route/Composer scope；主路由和只改 flags 时保留已有正文/root/scroller。
- ResizeObserver 只处理变化的角色节点；流式正文更新不引发 surface 扫描/尺寸刷新；纯能力状态发布不读取布局。
- 增加默认关闭的有界测试点和独立离线基准，记录耗时和资源计数，不记录会话正文、草稿或附件。

**单逻辑 Native 输入器尚不能交付给真实客户端。** 已发现直接 composer 和 surface 包装器的静态接入路径，协议层也已实现，但 Native driver 未完成。硬条件是活主编辑器的草稿/附件同步、禁止退出时旧快照覆盖新值，以及宿主保存确认和 keyed controller 清理。真实 `features.composerRebind` 保持 false；fixture 中的 true 不代表支持任何 Native profile。详细约定见 [workspace-composer-contract.md](workspace-composer-contract.md)。

最新导航候选补的是三个通用缺口：实际 Native local 模型/controller/提交路径的确认，修订号绑定的显式聚焦，以及接受导航前和冷读后的 IME 检查。以 `features.navigationInput` / `navigation.inputApi === 1` 标识，`ready` 不暴露 Native 私有对象。它不增加输入器、正文缓存策略或选中策略，详见 [严格导航验收记录](workspace-navigation-input-2026-10-11.md)。

## 验证范围

最新导航候选和 Native 分支核验加入后，相关 Adapter/Workspace/discovery/navigation/distribution 测试 **150 项全部通过，0 失败、0 跳过**，正式 bundle 重建成功。聚焦协议/Workspace/测量测试包含清理失败在句柄删除后仍传给 Core、IME 冷读竞态、controller 同 ID 替换、旧修订聚焦和操作退役的回归。实际 Native 又暴露 ProseMirror DOM 与 React 分支不一致，已按当前 committed 输入 host 做有限检查并加入 fixture。

`node tests/fixtures/workspace-acceptance/bench-wrapper.mjs` 的 0/1/2/4/5/8 正文矩阵中，稳定的七个角色只各订阅一次；200 次流式 fixture 更新没有额外 surface scan 或 geometry；五批外壳变更合并为五次刷新；退出后记录的 root 和订阅归零。报告：`.artifacts/workspace-wrapper-benchmark/report.json`。

上述离线矩阵只证明包装层调度和资源生命周期。新的独立 Native 空历史正文矩阵 0/1/2/4/5/8 也全部通过，20 个 root 创建/销毁对称；主输入器普通导航保留两个合成草稿和一个选中文本附件。暖导航仍需数百毫秒，首次组合探针还触发过 Native 错误页。前台绘制、持续空闲 CPU、长历史/流式负载、真实 IME 和异步附件仍未完成发布验收。详情与失败记录见 [严格导航验收](workspace-navigation-input-2026-10-11.md)。不能沿用历史 Target 或真实草稿；默认关闭的程序化测试点作为性能验证主入口。

Core 已完成 26.1007.2314.0 的隔离审核及登录后稳定性修复。Adapter 独立 run 已完成用户认证/初始化；本轮新增八个专属元数据会话并显式核验实际运行/数据边界。Native 主输入器的严格导航确认已验证；独立可重绑输入器、活主编辑器同步与草稿/附件 bridge 仍未交付，详见 [driver 进展](workspace-native-driver-2026-10-11.md)。

只读探针仅注册在自己的测试实例，完成后通过专属 CLI 移除，保留报告。没有安装到日常实例、发布或修改真实草稿。既有草稿恢复仍是独立未完成事项，保留 `.artifacts/workspace-draft-recovery/handoff-2026-10-09.json` 的准确记录。
