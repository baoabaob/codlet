# 2026-10-11 Core 独立 Native 测试准备记录

以下 profile、授权、进程和待办状态属于当日实验记录。现行开发入口与存储、隔离要求见[开发指南](development.md)；旧 run 不能作为新一轮启动或设备验收的授权与归属依据。

2026-10-11。用户已授权独立测试客户端。当前版本隔离审核和匹配 lab 已完成，用户已完成独立 profile 的认证和 Windows 初始化。登录后的重复刷新故障及修复见 [故障记录](history/core/native-refresh-2026-10-11.md)。所有运行必须使用自己的 profile 和合成数据。

当前 profile：`core-e674f238-bc43-483c-bdb1-8b90802cbe3e`。窗口为 **ChatGPT (Dev)**；PID 59936 是已停止的历史故障实例。后续重开保留这个 profile 的登录与设置，运行 `verify-core-native-run.mjs` 核对实际 PID/Target，不能复用历史编号。登录及 sandbox 已验证通过，无需重复登录。

最新状态：用户选择后台测量后已完成 [后台矩阵](history/core/core-native-background-2026-10-11.md)，release 测试实例已正常关闭且临时插件注册移除。重开时使用现有 client/Start-TestClient.cmd；匹配 release lab SHA 为 `748db69aebd09ba61de97b1487aeb6c9a52dc0b398e51fdc2bf04657f9c563c3`。Native 窗口可能不与逻辑 document 的 visibility 一致，真实显示帧须另行建立呈现证据。

运行目录为 `X:/codlet/.codlet-artifacts/core-native/core-e674f238-bc43-483c-bdb1-8b90802cbe3e/`。`client/Stop-TestClient.cmd` 可请求此实例正常退出；重开使用 `client/Start-TestClient.cmd -Onboarding`，已就绪后可使用普通启动。不要并发启动第二份，coordinator 会拒绝活的 pending/ready owner。

实际版本审核、兼容修复和进程/Target 证据见 [适配报告](native-isolation-26.1007.2314.0.md)。

## 已完成的只读预检

```text
node scripts/prepare-core-native-run.mjs
```

每次生成新的 `core-<uuid>` 计划目录，只检查安装包元数据、官方 CLI 签名、文件 hash 和源码的隔离版本门槛。脚本不会启动进程、连接 CDP、复制凭据/草稿或读取会话。性能报告不记录路径；控制 manifest 为后续核验保存明确的测试目录，计划值和实际值分开。

首次只读计划 `core-cb8e637c-daf8-498b-8365-433dcae5ce9d` 记录了当时的版本阻塞，保留为历史证据。当前实例使用上面的新 run，并保存准备、失败试运行及成功启动的独立记录。

| 项目 | 本轮证据 |
| --- | --- |
| 安装包 | OpenAI.Codex 26.1007.2314.0，x64，包身份已记录 |
| 官方 CLI | 包内 app/resources/codex.exe 存在，签名 Valid，SHA256 已记录 |
| Core | 匹配二进制已真实启动；当前 SHA 和 PID 见本 run 的 lab-config.json、owned-runtime-evidence.json |
| 当前门槛 | 26.1007.2314.0 已按精确源码审核并加入版本门槛；其余未知版本仍拒绝 |
| run/profile/registry | 当前 Core 新 run 已准备并真实启动，registry scope 与目录已确认 |
| PID/Target/数据 | owned-runtime-evidence.json 已记录；活动/归档会话为空，认证和 sandbox 初始化通过 |

## 启动前仍需完成

1. 审核当前包的 Dev 路径、单实例/IPC 名称、loopback app-server 初始化与退出行为，形成证据后才扩展 src/lab.rs 的审核表并重建实验二进制。当前版本已完成。安装存在或生产兼容清单通过，不等于实验隔离审核通过。
2. 对新 profile 运行 codlet-lab 的 prepare 阶段，使用明确的新 root、审核版本及保留的 loopback port；在收到 `prepared` 后先保留环境 manifest 和本次报告，不发 `start`。其中 registry、userData、CODEX_HOME、SQLite、project 必须全部落在本次 root；不得复制旧 lab 或日常数据。
3. 为此 run 启动专属后端，核验 listener PID、创建时间、可执行 hash、有效配置和合成会话归属，再允许 `start`。正常测试仍要求已认证、file credential store、read-only、禁用 desktop app tools、sandbox ready 等。显式 `-Onboarding` 可在隔离条件满足时打开该空 profile 的登录/初始化窗口，但状态保持 awaiting_authentication/awaiting_sandbox，不得运行正式性能验收。若固定回放后端替代官方后端，须单列其覆盖范围，不能当作 Native 草稿同步验收。
4. 只有本次启动产生的 `child_created`/startup/runtime ready 证据齐全后，记录 Core/backend/Desktop PID+创建时间、endpoint 和动态 Target。以进程归属绑定 Target，拒绝旧 ID、默认 endpoint 或“第一个 page”。将实际证据写入 effective 字段后才能测量。
5. 稳定 fixture 下测 0/1/2/4/5/8 root；render、commit、可输入和可见帧分阶段，配对测无副作用 Native 按钮、帧间隔、长任务、60 秒空闲进程组 CPU/内存，以及退出后资源恢复。记录窗口可见性；hidden rAF 不作为实际帧证明。禁止发送真实消息。
6. 通过本次 coordinator 的 quit bridge 关闭，确认同一组 owned PID 退出及 Native 资源恢复。不得按进程名关闭应用。Adapter 使用自己的 run/profile，不同时操作这个实例。

当前第 1–4 步已完成。每次重开仍运行 `node scripts/verify-core-native-run.mjs <本run目录>` 重新核验。首次设置写入后外置 app-server 缓存可能过期，协调器会在 onboarding 中正常重启所属进程一次；不得把该过渡期列入性能样本。Native 性能矩阵尚未测试。
