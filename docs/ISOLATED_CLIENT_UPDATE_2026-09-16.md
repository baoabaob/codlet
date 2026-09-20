# Windows 隔离测试客户端：26.908.9136.0

标签功能实机验证前发现，系统已更新官方客户端，并删除原来引用的 CLI 和 MSIX 目录。旧测试启动配置仍记录 26.908.4834.0，因此需要重新核对新版隔离条件。

本次只读检查当前安装的 `OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0`。归档 SHA-256 为 `7a46bd6fe162050afbac27d7d5271d19524e887fa0cdd06c0f2d3fa9b606a31d`。安装文件未修改，提取材料位于忽略的 `.codlet-artifacts/tag-ui-2026-09-16/client-audit/`。

| 源码位置 | 核对结果 |
| --- | --- |
| bootstrap-Ddmo4Ahv.js，w / setPath(userData) | 显式测试数据目录仍先于单实例锁设置 |
| main-D8abTQQE.js，W5 / G5；src-CCXHtyvY.js，DH / EH | 独立 loopback WS URL 选择 WebSocket transport；FORCE_CLI 仍必须排除；本地连接无隐式 stdio 回退 |
| main-D8abTQQE.js，registerIpcClientForWebContents / u0e / accessInputs | 三个直接 desktop IPC 构造点均要求 stdio |
| main-D8abTQQE.js，DCe / VCe / HCe / hostAppServerManagers | 第四个延迟 desktop IPC 构造点只由 HCe 创建；外层选择与 HCe 构造函数均检查本地 transport 为 stdio |
| main-D8abTQQE.js，$n / nte / Bn | 全部 26 个已有 false override 键仍有效，dev override 最后合并；Chrome 候选仍受 externalBrowserUseAllowed 限制 |
| main-D8abTQQE.js，ik / CODEX_SQLITE_HOME | 交互 shell 环境恢复和显式 SQLite home 行为未变，保留每次启动的 shell/profile 校验 |
| file-based-logger-C6QKdHxk.js；main-D8abTQQE.js，startUpdatePolling | dev flavor、禁用应用更新、手动 runtime update 模式仍有效 |
| main-D8abTQQE.js，quit-app 外层消息分派 | 固定 quit 请求仍调用当前应用 app.quit，不要求 relaunch |
| window-all-closed-BxbCP6YG.js，ee | Windows 仍在协议注册前返回 |

当前由日常客户端创建的官方 CLI 位于 `12219cbfbcbddde7/codex.exe`，Authenticode 有效，签名主体为 OpenAI OpCo, LLC，SHA-256 为 `960C111D47AFD61669954B9DF9E56083E302EDBFA3EF6962D81DCC14A30051DC`。

只增加该确切 x64 版本的启动允许记录和 `26.908.4834.0 → 26.908.9136.0` 的恢复转换；不放宽未知版本、架构、目录/进程归属、后端 Origin 检查或已有启动门槛。实际启动结果另外记录，不把源码检查视为已经启动成功或全部界面功能适配完成。
