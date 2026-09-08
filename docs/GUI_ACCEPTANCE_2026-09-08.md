# GUI 验收记录 — 2026-09-08

**结论：本轮 GUI 验收未通过。** Windows 设置循环已恢复；真实窗口暴露了插件通信与刷新恢复问题。Codlet 入口及面板可以出现，但插件列表持续停在 `Loading plugins...`，原生窗口刷新后入口消失。依赖插件列表的管理操作无法验收。

本轮依据用户的验收指令，在独立测试实例中进行。用户确认当时可以使用鼠标，并亲自完成登录和 Windows UAC；自动化只操作本次创建、核验过身份的 `ChatGPT (Dev)` 窗口。没有发送模型任务。

后续状态：下述失败记录保留为修复前证据。当天的[根因修复与复测](GUI_REPAIR_2026-09-08.md)已解决 GUI-001/GUI-002；保留登录状态的独立客户端通过列表、重载、主题、窄窗、新窗口及跨窗口停用检查。生产验收边界仍按后续记录单独标注。

## 实例与准备

- 被测提交：`6b7d91b`；工作区没有产品代码改动。
- 官方包：`OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0`，应用版本 `26.901.51231`。
- 从该提交重新构建的 lab 程序 SHA-256：`D68FFAA6FA26988AE7DF90814827865392B29186DC1EA272A97353197E41DFE1`。
- 独立目录：`C:/Users/cccake/.cache/codlet-lab/20260908-acceptance-a`。
- Lab Host PID `42264`；Desktop PID `49148`，创建于 `2026-09-08T02:08:46.0076370Z`，父进程为该 Host。
- Computer Use 返回的测试窗口 HWND 为 `4656384`；与该 Desktop 的 `MainWindowHandle` 一致。
- 初始测试后台 PID `10756`，父进程 `36884`；端点为 `ws://127.0.0.1:54718`。已核验监听者及 Desktop 到该后台的连接。

准备阶段通过空账号、文件凭据存储、只读沙箱和外部 Origin 返回 HTTP 403 的检查。自动启动检查耗时 **1799 ms**，开发模式、禁用更新、WebSocket 初始化和 Shell 加载条件全部通过；随后两个内置插件报告确认激活。这些启动结果不代表登录后的 GUI 可用。

## Windows 设置循环：本轮已恢复

用户完成 UAC 后，设置页反复出现。独立目录的沙箱日志记录了 `setup binary completed` 和 `read ACL run completed`，并存在版本为 5 的 `setup_marker.json`。配置查询返回 `windows.sandbox = "elevated"`，但同一后台的 `windowsSandbox/readiness` 仍返回 `notConfigured`。

现有官方源码快照 `8d32abc` 的 `app-server/src/request_processors/windows_sandbox_processor.rs` 中，readiness 使用构造时保存的 `Arc<Config>`；setup 路径则重新加载配置。该快照不是已证明与本机 CLI 二进制完全对应的源码，因此它只作为原因定位的支持证据。

协调者保留同一个 Desktop、端点、测试目录和登录状态，仅通过原后台的终端句柄停止它，再使用相同官方 CLI 和干净环境启动测试后台。新后台 PID 为 `7528`，父进程 `57240`，创建于 `2026-09-08T02:23:00.3379530Z`。随后：

- readiness 从 `notConfigured` 变为 **`ready`**。
- 配置仍为 `elevated`、`read-only`、`file`。
- 设置标记的 SHA-256 前后相同：`D0372490894C8923A427AA589AC6681D311902573E261809F291A292F1A5BBFB`。
- 原测试窗口自行进入主界面；没有再次运行设置程序或请求 UAC。

这些实测结果支持“独立后台未重新读取设置结果”的判断。本次只恢复了该测试会话，没有修改官方客户端或加入产品级后台重启行为。

用户确认的 Windows 设置涉及系统级沙箱用户和防火墙准备，这也符合[官方 Windows 沙箱说明](https://learn.chatgpt.com/docs/windows/windows-sandbox)。本轮不用于证明所有共享操作系统状态均未改变。沙箱秘密文件的内容没有被读取或记录。

## GUI 检查结果

| 检查 | 结果 | 观察 |
| --- | --- | --- |
| 登录后菜单挂载 | 通过一次 | `Codlet` 位于“文件、编辑、视图、帮助”之后，同一行显示。 |
| 打开管理面板 | 通过 | 直接鼠标点击打开原生 `dialog`；1280 px 宽窗口中面板约 600 px 宽。 |
| Escape 关闭 | 通过 | 面板关闭，原页面重新可用。 |
| 插件列表 | **失败** | 多次后续快照仍为 `Loading plugins...`，没有列表结果或错误提示。 |
| 原生窗口刷新后的恢复 | **失败** | 从“视图 → 重新加载窗口”刷新，官方主界面恢复，Codlet 入口缺失。 |
| 刷新列表、禁用确认、自我禁用与卸载 | 阻塞 | 依赖可用的插件列表和管理 RPC。 |
| 完整焦点循环、真实设置行、主题与窄窗布局、多窗口 | 未验收 | 空加载面板不足以代表这些条件通过。 |

索引点击后的即时快照曾没有显示面板，随后重新观察并进行直接坐标点击，确认面板可以打开。因此没有把最初的输入现象单独认定为产品缺陷。

## 阻塞问题与修复要求

### GUI-001：页面切换后的 renderer 通信恢复失败

登录切换后，Host 记录中的两个插件从确认激活变为 `activation_confirmed=false`，随后 `context_present=false`；目标 session 仍然存活。打开面板后列表一直等待。原生窗口刷新再次出现上下文存在后又失效的记录，最终入口未恢复。

当前 [renderer 事件处理](../src/renderer.rs) 在 `Runtime.executionContextsCleared` 时清空上下文 ID、取消激活确认；绑定路由在上下文 ID 缺失时直接返回，不发送响应。该实现与现场的等待现象一致，但尚未通过修复后的实机复测证明完整根因。

后续修复必须明确处理当前文档的上下文重新识别、真实就绪确认、请求 ID 生命周期和 provider/consumer 恢复顺序，同时保持旧上下文、旧请求及错误会话的拒绝条件。不能仅把 `context_present` 或 `active` 强制设为真。

### GUI-002：无响应的管理 RPC 缺少等待上限

[renderer bootstrap](../bundled/runtime/bootstrap.js) 将请求放入 pending 表后，没有客户端等待期限；[GUI 列表加载](../bundled/codlet/dist/renderer.js) 一直等待该 Promise。底层请求被丢弃时，用户看不到错误，也无法判断刷新是否有效。

后续修复需要有界失败、可重试的界面状态及迟到响应的处理；窗口导航和卸载后应清理挂起请求。应补充相应协议回归，再用保留的独立测试配置复验登录后列表、刷新恢复和自我禁用。

这些问题阻塞本轮 GUI 通过结论；生产 M0/M1、`DEFECT-001` 和 Host 崩溃契约 `DEFECT-002` 均继续开放。

## 退出与证据

测试 Desktop 通过固定 `quit-app` 入口退出，退出码为 `0`，从请求到观察退出为 **1168 ms**；Host 回收 CDP 工作线程并退出。两个测试后台分别通过各自保留的终端句柄停止，没有使用强制终止。

最终检查记录：原 Desktop PID `13460`、原后台 PID `27176` 的路径、父进程和创建时间未变；四个 Chrome native-host 注册名称和路径未变；记录中的测试进程及其直接子进程均已退出，测试端口 `54718` 没有监听者。鼠标自动化会话已重置。

用户登录后的认证状态保留在独立测试目录。该目录在登录后存在 `plugins` 目录，因此本轮不延续首次未登录检查时的“插件目录不存在”结论；没有主动执行插件安装操作。没有复制生产配置、会话或凭据，也没有自动回滚用户确认的系统设置。

机器本地证据保留于 `.codlet-artifacts/isolated-client-acceptance-2026-09-08/`：`before.json`、`build.json`、`backend-identity.json`、`backend-probe.json`、`active.json`、`windows-readiness-before.json`、`backend-restart-before.json`、`backend-resumed-identity.json`、`windows-readiness-after.json`、`gui-after-reload.jpg`、`after.json` 和 `acceptance-result.json`。测试目录另保留原始 `logs/report.jsonl` 及 Desktop 日志。上述机器文件、登录状态与截图不提交 Git。
