# 架构复审与 macOS 功能接续

本轮按用户要求保持开发试用阶段。先处理影响现有功能和平台一致性的缺陷，再推进 macOS；图标、安装交付、签名与发布暂缓。平台范围仍为 Windows x64 / ARM64、macOS Apple Silicon，Linux 暂缓。

## 审查范围与结果

| 范围 | 核对重点 | 结果与处置 |
| --- | --- | --- |
| 注册、权限与依赖 | GUI / CLI 使用同一授权记录；操作前后复核注册；撤权不会被失败恢复覆盖 | 保留现有 registry、ControlBroker 和生命周期回执；上一轮更新事务修复继续纳入全量回归 |
| GitHub 安装与更新 | 网络有期限、后台线程不保活 Core、来源和版本复核、更新不增加权限、旧包清理 | 保留单版本永久目录和事务恢复记录；新增权限或依赖继续返回 reviewRequired，不自动重放已提交操作 |
| 运行时 skill | 生成中断、冷文档、关闭 GUI、提前停用、文件所有权 | 修复正式目录部分写入、未就绪连接清理和未完成等待；发布完整目录后才注册 skill |
| UI / Desktop 适配 | 已核对构建的资源、导出名、现有连接、路由和组件 | Mac 被 Windows 固定构建拒绝的问题已修复；三处使用同一份构建清单，Desktop 源码纳入统一构建 |
| 文件删除 | 预览回执能够往返；删除只作用于确认的目录；路径替换后保留新目录 | 修复 Mac 的 dev:inode 回执被公共 SHA-256 校验拒绝；移除前复核原目录位置，保留 POSIX 路径语义 |
| 进程与 IPC | Core 退出、阻塞读写、插件子进程、身份与来源 | 保留原生 Windows Job 和 Mac lease / 进程组实现；上一轮 Mac 终端信号与启动错误清理继续保留 |
| 设置、安全模式、诊断 | 配置错误不扩大权限；诊断不覆盖文件、不导出凭据 | 共用当前服务与错误模型；不重新引入官方客户端版本检查 |
| 开发与验收说明 | 发布计划、已实现功能、平台源码检查与实机证据一致 | 更新过时的“未开始移植”和“保留历史回滚”等当前计划描述，保留历史证据原文的时间属性 |

## 已落实的结构调整

### 构建信息由一份清单维护

`compatibility/client-profiles.json` 记录已经核对的客户端构建、入口、模块、后端版本与所需导出。UI adapter、Desktop adapter 和 Core runtime skill 各自只消费所需的部分。角色仍有各自的可用性判断，旧版 Desktop profile 不会自动获得整页 UI 或 runtime skill 支持。

Desktop adapter 的可编辑源码现在位于 `frontend/src/desktop/entry.js`，与 UI adapter 一起构建；插件入口仍为 `bundled/codex-desktop-adapter/renderer.js`。作者和测试读取的公开插件入口、权限和 capabilities 保持兼容。

Core 只为用户明确要求的 authoring skill 保留有限的原生连接桥接。任务、回合、审批和导航等通用业务映射仍在可选适配器中，不扩大 Core 的私有客户端 API 面积。

清单中的源码核对与 `bundled/codex-ui-adapter/client-versions.json` 中的实机验收是两项独立证据。Mac 已加入源码 profile，但对应实机版本清单仍为空。运行时继续检查入口、导出、已有 local 连接和后端版本；遇到不一致即拒绝该能力，不建立第二条 Desktop 连接。

### 目录所有权下沉到平台接口

`platform::directory` 提供持有目录身份、祖先和删除能力的资源对象。Windows 实现移至 `windows::owned_directory`，Mac 继续使用逐级 `openat` 和文件描述符。注册移除和 runtime skill 清理共用这一层；删除授权、是否保留插件数据等业务规则仍属于各自上层。

Windows 继续保持防替换句柄、立即删除名称和旧文件系统回退。Mac 回执由路径、设备、inode 与创建时间生成 SHA-256，满足公共协议；不会把 `dev:inode` 当作可以提交的回执。POSIX 路径比较保留大小写和字面的反斜线。已移动的 Mac 目录在清理开始前被拒绝，原内容和替代目录均保留。

### Skill 文件以完整目录发布

Core 在注册目录外的临时位置生成 runtime metadata、SKILL.md、类型和文档，完成后替换 `runtime-skills/codlet`。临时 metadata 指向最终路径；临时目录不会成为 extra skill root，也不产生第二个 codlet skill。下次启动在持有同一注册作用域锁时清理可确认属于自己的中断暂存文件。无法确认所有权的目录保留。

Core 退出时清理的是持有的原目录，而不是仅按字符串路径递归删除。原生桥接在冷文档等待正确入口，提前停用会取消等待、清理请求，并在连接尚未建立时安全返回。

## macOS 源码依据

官方 `ChatGPT.app` / `com.openai.codex`，版本 `26.908.70816`，build `9275`。从之前保存的原始 DMG 中提取所需文件，逐文件核对 ASAR 的 SHA-256，未运行或修改官方包。

| 内容 | 核对结果 |
| --- | --- |
| 前端入口 | `index-53d76a96a6f3.js` |
| 原生连接与 AppShell | `app-initial-4d7ea7f81c2d.js`；scope e6t、manager cDt、client lDt、services TW；hB 初始化 mB 的 Header / HeaderToolbar |
| 侧栏 | `app-primary-4af6ed7f68d1.js`；ov 是同一 SidebarItem，支持 label、icon、isActive、animatedIcon |
| 新任务 | rN 初始化 oN；返回原生新任务函数，接受现有草稿参数 |
| 路由 | `/avatar-overlay`、`/connector/oauth_callback`、`/inbox` 的结构存在 |
| postbox | `get-trusted-message-for-view-eee599500f15.js` 的 i 导出；与已有已核对资源一致 |
| 后端 | 原始 ARM64 codex 中的版本与 provenance 为 `0.154.0-alpha.6.2`；实际启动时仍要求连接返回此版本 |

本地证据位于 `.codlet-artifacts/review-2026-09-16/mac-reference/frontend-evidence.json` 和 `backend/evidence.json`。不将官方源文件或二进制加入发布内容。

## 验收与剩余事项

本轮增加 Windows/Mac 构建选择、skill 冷文档和提前清理、生成中断恢复、Mac 删除回执和目录替换测试。构建检查、全量回归与 Dev 验收结果记录在 [开发复审记录](DEVELOPMENT_REVIEW_2026-09-16.md)。Mac 的源码核对、编译与模拟原生模块测试不能代替 Mac 上真实的窗口、后端连接、文件选择器和视觉验收。

目前保留的边界：Mac 进程组不保证回收主动脱离组的守护进程；Core 被强制杀死不保证官方客户端退出；官方入口可能复用已经扩展的主实例。Codlet 自身的 Mac 更新安装和签名分发仍属于延期的交付阶段。它们继续作为明确的门禁，不标为已解决。

接续顺序是 Windows Dev 继续试用、真实 Mac 的功能和视觉验收，以及实机发现的问题修复。发布、安装器和最终图标在用户确认试用体验后安排。
