# 26.1007.2314.0 独立测试环境适配

2026-10-11。已完成精确版本源码审核、匹配 lab 构建及真实隔离启动。首次认证已完成，登录后的刷新故障另见 [修复记录](native-refresh-2026-10-11.md)。本页下表保留初次启动证据，PID/Target 不代表当前实例；尚无 Native 性能矩阵验收结果。

## 源码及修复

只从当前签名安装包的 app.asar 提取主进程构建；未导入或执行提取的模块。20 项静态检查及各文件 SHA256 保存在 [审查证据](native-isolation-26.1007.2314.0.json)。重点核对：BUILD_FLAVOR 优先级、userData 在单实例锁之前设置、Windows 不注册默认协议、显式 WS 路由、四处 IpcClient 创建的门槛、shell 保留指定 CODEX_HOME、更新关闭、SQLite 迁移退出，以及当前严格功能 schema。

Windows 仍使用固定 codex-ipc 名称，因此仅隔离目录不够。必须使用本次进程拥有的 literal-loopback WebSocket 后端；新版 Native 在此配置下不创建本地协调 IpcClient。旧版和未知版、错误包身份/架构、无 WS 和非 literal-loopback 地址继续拒绝。

真实试启动暴露并修复三处 lab 差异：

- 旧实验入口直接给 Owl 传入 `\\?\` 路径，客户端退出 13；现在复用生产路径转换和包身份校验，仍保留实验环境与 cwd。
- 包身份 helper 会重新进入同一个启动器；lab 现在处理已有的认证内部 helper 协议，错误管道前缀仍在连接前拒绝。未新开通通用远程启动入口。
- 新版功能 schema 为严格 partial 对象，已删除 quickChat/computerUseNodeRepl；仅当前审核版本移除这两个失效字段，其他禁用项和旧版本策略保持一致。该差异曾使 main bootstrap 在创建 renderer 之前失败。

实验启动失败现在可读取自身新建客户端的有界 stderr，成功后立即停止 startup 缓冲。生产启动调用的默认 cwd/行为不变。

## 实际运行证据

控制资料目录：`.codlet-artifacts/core-native/core-e674f238-bc43-483c-bdb1-8b90802cbe3e/`。

| 项目 | 核验结果 |
| --- | --- |
| 安装包 | OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0 |
| Lab SHA256 | 8a40f7fd10da47a3e7c58b7a8bcf4a1f50a2f0502004b1bf6c7e0d6224f238b0 |
| 官方 CLI SHA256 | d13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec |
| Node | 随测试包固定 24.21.0，构建时校验 executable/LICENSE hash |
| coordinator runId | 1791704983639-44168 |
| manager / Core / backend / Desktop PID | 44168 / 56944 / 21092 / 59936 |
| Target | F0862BDC2063CBAA5873312CB47A37C9，来自本次 owned CDP pipe 的 renderer_attached/snapshot |
| registry scope | f6ef8c381b75d06ec7c456385393c66383c368ee8e8f652efbdca000bf461847 |
| Native startup | development、updates disabled、shell loaded、WS transport、initialize success 全部成立 |
| 后端 | 专属 loopback listener PID/创建时间/镜像一致；file credential store、read-only、Desktop app tools disabled、外部 Origin 拒绝 |
| 数据 | 新 profile；CODEX_HOME、SQLite、registry、userData 和实际创建的 web profile 都落在本 run 目录；未复制日常数据/凭据 |
| 会话 | 只读 thread/list 确认活动及归档均为空；没有发送消息 |
| 日常实例 | 启动前后 PID、创建时间和镜像均匹配 |
| 待办 | authenticated=false，Windows sandbox=notConfigured；明确 awaiting_authentication |

完整控制证据在该目录的 `owned-runtime-evidence.json`、`profile/logs/coordinator-1791704983639-44168/state.json` 和本次 run report。路径只用于隔离控制证据；性能样本仍不记录正文、草稿或路径。这里的 Target 是本次运行的证据，不是下次可以复用的常量。

此前退出 13 的试运行已结束；bootstrap 失败且无 renderer 的所属窗口通过核对 PID/创建时间后发送正常关闭请求，随后所属 Core/后台结束。失败目录保留证据，未改写恢复日志或删除未知数据。

## 验证与后续

- Rust lab 38 项、Windows process 7 项通过；匹配 lab 构建成功。
- 启动器 11 项、readiness 3 项、Native plan 3 项、quit bridge 2 项通过。
- 新增 `-Onboarding` 仅允许隔离条件仍成立的待认证/待 sandbox 窗口，明确保持未就绪；正常启动要求完全未降低。待办期间每 5 秒探测就绪，不作为空闲 CPU 样本。

首次认证/初始化现已完成并重新验证空 fixture。仍需执行 0/1/多 root、Native 按钮、帧/长任务、60 秒 CPU 和退出资源恢复。启动及故障修复后的稳定观察不证明整窗性能，也不证明 Native 草稿同步。另：主进程 feature overrides 不等于 renderer 的所有后台功能都被禁用；登录后实际启动了 Local Work executor。后续性能样本须计入这些所属后台进程，不得将静态 false 字段当作它们不存在的证据。

复现静态审核：

```text
node scripts/extract-isolation-source.mjs <当前包app.asar> <新目录> src-BJv5Mk7n.js src-CP7XXlpZ.js
node scripts/audit-native-isolation.mjs <该目录> <报告.json>
```

准备和启动流程见 [runbook](core-native-runbook.md)。
