# Windows 测试客户端：26.915.3509.0

2026-09-19 续：本机更新到 26.915.4065.0（应用 26.915.31945 / build 9922），已重新核对原生模块及前端导出并增加精确 x64 启动允许记录。34 项隔离启动测试、45 项适配器/技能测试通过；主窗口启动并加载插件成功。另一辅助 target 仍报告路由/连接未就绪，不将进程 ready 视为所有辅助窗口均已适配。此次已同步标签交互和补全功能，其 7 项测试、6 项搜索/焦点回归及类型检查通过，并检查了浏览器预览的深浅色与窄窗口布局。最新启动配置使用签名有效的 `247581e40ee272fb/codex.exe`（0.155.0-alpha.9.2），旧启动配置与可执行文件保存于 `.codlet-artifacts/tag-search/client-backup/`。官方安装重启的另行审查见 [更新启动交接核对](OFFICIAL_UPDATE_RESTART_REVIEW_2026-09-19.md)。

系统升级后，旧测试配置仍引用已移除的 `12219cbfbcbddde7/codex.exe` 和 26.908.9136.0。启动器现固定使用本机签名有效的 `cdef5aaf3e41ab53/codex.exe`（0.155.0-alpha.9），保留每次启动的文件哈希验证。

本次只读核对 `OpenAI.Codex_26.915.3509.0_x64__2p2nqsd0c76g0`，应用版本 26.915.31029，构建号 9771。ASAR SHA-256 为 `8227f6234cf2cc418ec8bbdeedec03f8d777f85520929ff2d9d38e774f681dfd`；提取材料保存在忽略目录 `.codlet-artifacts/dev-start-2026-09-18/client-audit/`。

## 隔离条件

- `bootstrap-CqlvPvwP.js`：显式 userData 仍在单实例锁前设置；Windows 协议注册仍直接返回；dev flavor 和禁用更新选项仍有效
- `src-BO6ySiRL.js` 的 `vK`、`main-CIvjSspu.js` 的 `z5/U5`：专属 loopback WS 选择独立 transport，FORCE_CLI 仍须排除
- 主进程 `localClientCoordinationEnabled=z5(ms)==null` 控制全部四处 desktop IPC 构造；host manager、read state、access invalidation 和各窗口的协调客户端均受该条件约束
- dev feature override 仍最后合并，26 个现有禁用字段均通过当前严格 schema；原 shell/profile、SQLite home、进程身份及后端 Origin 检查保留
- 只新增该精确 x64 包的允许记录和 `26.908.9136.0 → 26.915.3509.0` 的恢复转换，不放宽其他版本或架构

## 界面适配

新版将 React、React DOM、消息桥集中到 `app-shared-81f1324f1b97.js`。适配配置记录了实际模块及导出，继续复用客户端已初始化的连接。原生 Route 在本版增加 Fragment 包装；导航探测现支持这一结构，并保留原 Route 身份和登录后路由集合。回归覆盖插件页加入、原生返回、toolbar 和移除恢复。

开发适配器通过现有 CLI 将注册路径迁移到当前工作树，保留源文件及数据，并恢复此前启用的依赖插件。旧启动器和插件配置已备份到本轮忽略目录。

## 本机结果

隔离启动 33 项测试通过；适配器及运行时技能的 43 项测试通过，随后加入新版 Fragment 路由回归，12 项界面适配测试全部通过。最终测试窗口标题为 `ChatGPT (Dev)`，启动检查、独立 WebSocket 后端和插件初始化成功；新进程日志不再出现此前的 `ui_host_pending`、`gui_ui_unavailable`。日常客户端继续运行。未进行打包发布。
