# 独立 Dev 客户端登录后重复刷新

2026-10-11。所属 profile 为 `core-e674f238-bc43-483c-bdb1-8b90802cbe3e`，未修改日常客户端。用户正常登录及 Windows 设置均已完成。

## 复现与原因

初次 Native PID 59936 在 08:35 UTC 登录后反复请求 app-server restart，同时 Local Work executor 出现 startup failure、隐藏主窗口反复初始化。Desktop 主进程并没有重启。用户完成 Windows 设置后，profile 中已写入 `windows.sandbox = "elevated"`，外置 app-server 的 readiness 仍为 `notConfigured`。

使用单独空目录和所属官方 CLI、stdio 连接复现：初始 readiness 为 `notConfigured`；写入模式后 `config/read` 已读到 elevated，但 readiness 仍为 `notConfigured`；重启该 CLI 后变为 `updateRequired`，正确反映这个空目录还没有初始化文件。原来已完成初始化的 profile 重开后则为 `ready`。证据保存在 run 目录的 `backend-reload-evidence.json`。说明 WebSocket 重连不会重启由协调器持有的后端、也不会加载新的 startup config。

同时 Core 在窗口销毁竞态中遇到不带 sessionId 的 CDP 错误，把整条 pipe 判为不匹配并关闭，随后 quit bridge 无法送达。Chromium 的 browser router 对已不存在的 flattened session 会返回此类错误，见 [Chromium 源码](https://chromium.googlesource.com/chromium/src/+/refs/tags/143.0.7475.6/content/browser/devtools/devtools_session.cc)。原始日志没有保存错误正文，因此该具体错误类型属于基于源码的解释；新增处理仅接受精确的 -32001 / `Session with given id not found.`，不放宽成功响应和其他跨 session 错误。

## 修复

- Onboarding 检测已保存 sandbox 模式而 readiness 仍为 notConfigured 时，最多正常重启自己持有的客户端和后端一次。失败退出不触发新一轮；重开后重新执行隔离、认证和 readiness 检查。
- CDP 已销毁 session 的精确错误只使对应 session 失效，保留其他窗口的连接；错误仍交给原请求方。
- 明确恢复开关允许“插件干净回收、Desktop 异常退出且 CDP worker 已回收”的旧 run 进入已有恢复检查。仍核对最近 coordinator 与全部记录 PID 已退役，不修改旧日志，不把异常退出标成干净退出。

异常实例正常退出请求失败后，核对 PID、创建时间和镜像，终止唯一所属 Desktop 句柄；Core 随后回收 CDP worker 和所属后端。认证数据未删除或复制。之后安全模式 PID 31656 观察 60 秒无 app-server restart、无 Local Work startup failure，正常 quit 退出码 0。

本次 lab SHA256：`89c5c94d100d1e97b6d42b9bdfe4f4ddaa0abec2d0af065f3a0f8bf290340e47`。

## 检查

CDP 客户端 19 项、恢复逻辑 13 项、启动器与 readiness 15 项，共 47 项通过；lab 构建通过。其中覆盖 detached session 错误后另一 session 仍可用、无 session 成功响应和其他错误继续拒绝、异常退出恢复仍要求明确开关和干净回收，以及 onboarding 不绕过隔离门槛。

正常模式 PID 55832（coordinator `1791708515630-38864`）在 08:48:44–08:50:35 UTC 连续观察 111 秒：app-server restart、Local Work startup failure、MCP account-changed、root error boundary 均为 0，三个 renderer ID 保持稳定；Core report 无 renderer/CDP 故障。归属重验 authenticated=true，活动/归档会话各 0。当前 Target 为 `EC226D1684ECBCF94C3B177C87D8E0EB`，仅是本次运行证据。

安全模式、正常模式、最终归属证据分别在 run 目录的 `stability-safe-mode.json`、`stability-normal-mode.json`、`owned-runtime-evidence.json`。`ready` 仅代表启动/认证条件通过；不等同于 Native 性能矩阵或草稿同步验收。
