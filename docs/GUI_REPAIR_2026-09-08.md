# GUI 根因修复与复测 — 2026-09-08

**GUI-001/GUI-002 已修复；本轮隔离客户端的 GUI 复测通过。** 插件列表、刷新、两次原生窗口重载、主题变化、窄窗布局、新窗口和跨窗口自我停用均完成实测。无响应请求的 15 秒上限及迟到响应拒绝由确定性自动化测试验证，未在真实客户端中人为注入断线。

这是[首次 GUI 验收失败](GUI_ACCEPTANCE_2026-09-08.md)后的修复记录，针对官方 Windows 包 `26.901.6511.0` 的实验性 Dev/WebSocket 路径。普通 `codlet launch` 的生产 M0/M1、`DEFECT-001` 及 Host 崩溃契约 `DEFECT-002` 继续开放。本轮没有重新执行初次登录/UAC，也没有发送模型任务。

## 根因和实现

1. **同名子 frame 覆盖了主页面的执行上下文。** 旧事件处理只按 isolated-world 名称接收 `Runtime.executionContextCreated`，没有核对 `auxData.frameId` 和 `isDefault`。CDP 的新文档脚本会在每个 frame 创建指定名称的 world；即使脚本在子 frame 内立即返回，这个上下文仍会产生事件。子 frame 的创建和销毁因而可把插件主上下文覆盖后清空，留下还在显示的入口和无法路由的管理请求。新增协议夹具在旧实现上复现失败，修复后通过。依据：[Page.addScriptToEvaluateOnNewDocument](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument)、[ExecutionContextDescription](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#type-ExecutionContextDescription)。
2. **导航缺少受 Host 确认的重新激活。** 现在从主 frame 树绑定所有者，忽略子 frame/default-world 的同名事件；支持的主文档导航会撤销旧作用域和资源，再按 provider → consumer 顺序重新授权、等待激活完成。重载保持插件 generation，但 world 和 binding 使用新的 `.d2`/`.d3` 名称，旧 binding 即使遇到回收复用的数字 context ID 也不能通过。只保留带顶层守卫的通用 bootstrap，不再让持久脚本自行重放插件激活。
3. **RPC pending 表没有失败期限。** bootstrap 现在为每次请求设置 15 秒定时器；回复、同步绑定失败及卸载都会清除定时器。超时拒绝 Promise 并移除 pending，迟到回复无法复活请求。GUI 将 `rpc_timeout` 显示为可刷新重试的错误。

恢复使用有界请求预算，激活失败不会伪造 `active=true`，也不会自动无限重试；后续主文档导航可以再次尝试。状态只记录实际激活结果，仍不等价于 DOM 挂载证明。

## 保留隔离登录状态的复测

新增 `codlet-lab --resume-from <closed-run-report>`，仅复用已标记实验目录。必须持有独占 Host 租约、使用该目录最新且完整的运行报告，并核对根目录、官方包及旧 Desktop 的 PID/创建时间和已退出记录。报告缺失/未关闭、路径链接、并行 Host 或外部报告均不会成为普通启动的绕过路径。

恢复模式保留该实验目录中的登录状态、配置与历史，每次建立独立 `logs/run-*/` 日志和环境清单。认证文件只做文件属性/链接检查，不读取认证字节；配置字节在 prepared/start 之间复核。已有运行时缓存校验了 4,684 个文件的结构和三项官方标记哈希，复制数为零。当前新进程的启动日志还必须满足创建时间条件，防止旧日志与复用 PID 造成假通过。

本次进程和产物：

- 被测源代码基于 `b1be249` 加本次修复；lab 二进制 SHA-256 为 `BDF635AF697EFEA7992ADF744463525EACDDC839B620ED4AE37E561C5299FF12`。
- 测试目录：`C:/Users/cccake/.cache/codlet-lab/20260908-acceptance-a`；新日志：`logs/run-1788840495217-51696/`。
- Host PID `51696`；Desktop PID `37448`，创建 FILETIME `134333141866036374`；后台 PID `23460`，父进程 `20688`。
- 后台端点 `ws://127.0.0.1:54718` 的监听者、官方 CLI 路径及 SHA-256 已核验。只记录账号已登录这一布尔结果；有效凭据存储为 `file`、沙箱为 `read-only`、Windows readiness 为 `ready`，外部 Origin 返回 HTTP 403。
- 启动检查 **2910 ms**，五项条件全部满足。Computer Use 返回的窗口 `6555876` 和新增窗口 `55578830` 均通过 Windows 窗口所有者查询绑定到 Desktop PID `37448`。

## 实测结果

| 检查 | 结果与证据 |
| --- | --- |
| 登录后菜单与插件列表 | Codlet 位于帮助之后；列表返回 `codex.ui.adapter 0.1.0 Active` 与已启用的 `Codlet GUI 0.1.0`。 |
| 刷新 | 点击刷新后仍显示完整列表，无持续等待或错误。 |
| 停用确认与取消 | 开关先进入确认界面；第一次 Escape 取消确认并返回列表，第二次关闭面板。 |
| 关闭与焦点 | 关闭按钮与 Escape 均有效；设置页关闭后能看到 Codlet 入口的焦点环。完整 Tab/Shift-Tab 遍历未单独实测。 |
| 原生重载两次 | 两次“视图 → 重新加载窗口”后均恢复入口及完整列表；Host 记录两组 `document_recovering` / `document_recovered`，插件在原 generation 重新确认 active。 |
| 设置页/菜单重建 | 进入设置、外观及返回主页面后，入口仍可打开并取得列表。 |
| 明暗主题和布局 | 1280 px 与 782 px 宽窗口内真实设置行完整显示；深色主题下背景、文字和开关可辨。检查后恢复原“系统”主题。 |
| 新窗口 | 官方“文件 → 新建窗口”创建第二个空窗口，入口与列表正常；没有提交聊天。 |
| 自我停用 | 在第二窗口确认停用，注册表写入 `enabled=false`，两个窗口的入口和面板均移除，Host 的三个目标中只剩 adapter。 |
| 正常退出 | 固定 `quit-app` 请求后 **1174 ms** 观察到 Desktop 退出码 0，CDP 工作线程回收，Host 退出码 0。 |

后台随后通过它自己的终端句柄接收 Ctrl+C 退出；其包装终端返回 1，记录为主动停止结果，没有将它误记为后台自然成功退出。清理核对未发现测试进程或直接子进程、端口 54718 监听者。原 Desktop `13460` 与后台 `27176` 的创建时间、路径和父进程未变。鼠标自动化会话已重置。

保留停用配置作为验收证据后，通过 CLI 仅对该实验目录重新设为启用，方便下次启动。未修改正常客户端的 Codlet 注册表；登录状态保留，没有读取或复制认证内容。

## 自动化验证与证据边界

- `cargo fmt --all -- --check`、Clippy `-D warnings` 通过。
- Windows 全部目标/功能的 Rust 测试 **255 通过，1 项外部真机 gate 忽略**；其中 fake-child 协议测试 38 项。新增覆盖同名子 frame/default-world、导航后真实确认、旧 binding 与复用 context ID、恢复超时及下一次导航重试。
- Node VM 测试 **63 通过**；包括真实 bootstrap 的超时/迟到回复/清理和 GUI 错误重试。
- 实验目录恢复测试覆盖旧报告与身份拒绝、存活进程识别、独占租约、配置和认证夹具保留、配置变更拒绝、运行时缓存篡改/链接及旧 PID 日志过滤。

机器证据位于 `.codlet-artifacts/gui-repair-2026-09-08/`，包括 `build.json`、`before.json`、`backend-identity.json`、`backend-probe.json`、`window-identities.json`、`active-processes.json`、`gui-disable-registry.json`、`lab-report.jsonl`、`cleanup.json` 和复测摘要。截图在本次交互记录中；机器日志、登录资料及产物不提交 Git。实验 Harness 的 `gui_mount_verified=false` 保持原语义，GUI 通过来自上述独立实测观察。
