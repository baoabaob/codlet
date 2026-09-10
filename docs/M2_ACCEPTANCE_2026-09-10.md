# M2：开放 Core、Host RPC、OS broker 与权限撤销验收

本记录对应源仓库 `docs/PRODUCT_TECHNICAL_PLAN.md` 第 15 节 M2 的全部验收条件。M2 的对象是插件公开原语、受管理调用和 Core 持有的资源。Codex 私有 UI 与 App Server 业务适配分别属于 M3、M4。

当前状态：M2 已完成。本记录中的运行时定向验收、严格类型检查、Clippy、格式检查、locked release 构建与便携分发专项核验全部通过。

## 交付与验收映射

| M2 条件 | 实现与公开接口 | 验证 |
| --- | --- | --- |
| 关闭所有可选官方插件，单一自带实现的 Host 可以工作 | `examples/raw-m2` 只有 `host.entry`，申请 `host.process` 与 `cdp.raw`；不声明 renderer、官方 capability 或 requires | `m2_raw_vm_tests` 3 项通过；完全不构造 RendererRuntime/TargetController |
| Host 自行注入、恢复导航并建立消息通路 | 公开 `Target`/`Page`/`Runtime` CDP 请求与事件；示例自己的 binding、新文档脚本、请求 ID 和文档 token | 真实 Node VM peer 执行示例页面代码，多窗口、导航、新增/销毁窗口、旧请求与停用通过 |
| 第一方与第三方使用同一开放接口 | 通用 Core RPC、公开版本化类型；Runtime 与 Target scope，Host↔Host、Host↔renderer，renderer ABI 作为消费方 | Core RPC VM 3 项、scope 内核 3 项、能力内核 22 项通过 |
| 可选 Host 进程、JSONL、独立 Job Object | Native Host executor；每代独立进程、有限队列、退出与 worker 回收 | Host capability/cleanup/lifecycle/runtime/local loader 27 项、Native supervisor 5 项通过 |
| 独立高风险权限 endpoint | `cdp.raw`、`host.fs`、`host.network`、`host.process`、`host.system`；目录/origin/executable 显式范围 | OS broker 10 项、policy 3 项、registry 22 项、路径大小写边界 1 项通过 |
| 首次使用前授权、持久记录与撤销 | CLI 显示 requested/granted/policy；`plugin permissions`；receipt 管理动作 `revoke`；外部完整授权记录变化使旧代失效 | `m2_management` 4 项、CLI 8 项、真实控制管道 revoke 1 项通过 |
| 公开 `runtime.manage@1` 支撑 GUI | `list`、`prepare`、`submit`、`operation`；查询、启用、停用与重载；一次提交后只读查询原 receipt | Runtime manage 4 项、撤销 DTO 1 项、GUI 33 项通过；正常与窄窗口预览已检查 |
| 异常有确定结果并清理 Core 资源 | deadline/cancel/parent budget；退役 generation 与 Target lease；Host Job、订阅、raw session 归还 | 15 项 VM 合并回归全部通过，含 5 项 attach 退休和 128 会话回收；Host 阻塞时的独立 OS 短预算也通过 |
| 固化通用 RPC 语义 | request/response/notification/server-request、generation、错误、scope、嵌套截止时间与取消 | 15 项 VM、scope 内核 3 项、订阅过滤 1 项、协议 2 项及 SDK 36 项通过 |
| 示例完成获准目录读取与网络请求，撤销拒绝 | `examples/host-os-broker` 使用公开 SDK；真实文件、loopback HTTP、已批准子进程与系统信息 | OS broker 10 项中包含示例真实 Host SDK 执行与撤销；通过 |

## 授权和失败语义

上表按验收条件引用证据，同一测试可以覆盖多条条件，数量不相加为一个总测试数。

本地登记保存完整 path、grants 与 brokerPolicy。OS endpoint 在请求准入、执行和结果交付时检查当前记录；托管 RPC 与 renderer 调用同样检查调用者与 provider 的当前 generation、权限和 scope。`revoke` 先持久化减少后的权限，使旧权限失效，再退役受影响插件及声明依赖者；清理失败不恢复被撤销授权，也不把不确定退出报告为完全回收。插件 enabled 偏好保留，恢复运行需要用户另行授权与启用。

Host 具有普通用户权限，运行 Node 或已批准的子进程不构成 OS 沙箱。撤销能阻止后续受管理调用并清理 Core 持有的进程、订阅和连接；无法撤回程序已经完成的任意外部副作用。自建 raw 页面代码的任意修改也没有通用回滚保证，正常示例负责清理自己的全局、binding 和新文档脚本；失败清理仍须归还 Core 跟踪的 raw session。

attach 已写入 CDP 后，即使调用者取消、超时或进程先退出，Core 仍保留有限退休等待，收到晚到 session 后直接 detach。已知会话按队列容量分批回收；队列暂满会在同一绝对预算内重试。若 attach 永不返回、无法确定对应远端资源，Core 报告 `cleanup_incomplete` 并终止共享 CDP 连接，因此这类传输失败会影响本次 Codlet 会话。不会把它报告成成功停用或只影响单个插件。

## 验证边界

使用临时 registry、独立 Node 子进程、Windows Job Object、真实命名管道、临时文件和本机 HTTP 服务。VM peer 实际执行 Host SDK 与 renderer JavaScript，覆盖真实请求/Promise/通知和文档生命周期；它不等同于 Chromium DOM 或某个 Codex build 的兼容验证。GUI 使用浏览器预览验证交互和两种窗口宽度。本轮不重新执行已经结束的 M0/M1 全套门禁，也不启动或修改用户的日常 Codex 会话。

Host、renderer 与 runtime.manage 的三份类型声明使用官方 npm `typescript@5.9.3` 通过 `--noEmit --strict --lib ES2022,DOM --target ES2022 --module Node16 --moduleResolution Node16` 编译。编译器 tarball 按 registry 的 SHA512 integrity 校验，仅保存在私有工具目录；没有全局安装或新增工程依赖。

另行提供用户请求的 [隐藏额度提示插件](../examples/hide-usage-banner/README.md)。其六项真实浏览器 DOM 检查和候选目录检查独立记录，不混入 Core RPC 的功能验收数量。

## 相关交付

- [Core RPC 契约](CORE_RPC_2026-09-10.md)
- [OS broker 与范围授权](OS_BROKER_2026-09-10.md)
- [公开运行时管理](RUNTIME_MANAGE_2026-09-10.md)
- [Host 开发流程](HOST_DEVELOPMENT_2026-09-10.md)
- [单 Host raw 示例](../examples/raw-m2/README.md)
- [OS broker 示例](../examples/host-os-broker/README.md)
- [便携分发](DISTRIBUTION.md)

最终构建使用 `cargo build --locked --release --bin codlet`，可执行文件 SHA256 为 `649b5ffd3e10d676e2d9de36d93d8e546d1e9122d1ee35e8930cbc0692b1ba5a`。`cargo clippy --locked --all-targets -- -D warnings`、`cargo fmt --all -- --check` 与 `git diff --check` 均通过。

`scripts/Test-Distribution.ps1` 用该可执行文件与固定 Node 运行，7 类检查全部通过，覆盖 11 个不授信候选、完整授权查询、中文/空格路径、逐文件与 ZIP 摘要、重复打包一致性及错误输入拒绝。两次包装的 manifest/ZIP 分别一致。最终开发包另写入源码 commit；源码与产物的完整对应记录位于源仓库 ignored 的 `.codlet-artifacts/m2-completion-2026-09-10/verification.json`，包装专项原始报告位于同目录的 `packaging-check/packaging-acceptance.json`。

运行时定向检查包括以下分组；失败后只复验受影响的组，不重复计入通过数量：

| 分组 | 最终通过 |
| --- | --- |
| `cargo test --locked --lib vm_tests` | 15 |
| scope、订阅方法过滤、通用 capability kernel | 3 + 1 + 22 |
| Host capability、cleanup、lifecycle、runtime、local loader | 6 + 5 + 5 + 4 + 7 |
| combined package lifecycle | 5 |
| OS broker、policy、registry、路径大小写 | 10 + 3 + 22 + 1 |
| management、scoped CLI、真实 revoke pipe | 4 + 8 + 1 |
| runtime.manage 单元/旧 GUI self-disable、revoke DTO、JSONL 协议 | 4 + 1 + 2 |
| doctor、GUI identity、Host control/watch/development flow、CLI、Native supervisor、renderer→Host、runtime list | 13 + 4 + 7 + 9 + 1 + 6 + 5 + 5 + 1 |
| Node bootstrap/Host/provider/SDK/local-example | 36 |
| Codlet GUI | 33 |

最终兼容修复保留原测试的行为要求：renderer 的 Core 路由必须匹配它已获得的 provider lease；加载器保存完整原始授信记录，单独保存规范化源路径；无效 registry 的管理查询仍返回可诊断错误。Runtime requirement 已实现后的历史 scope 拒绝测试，改为专门检查尚未提供生命周期的 backend-session/thread。
