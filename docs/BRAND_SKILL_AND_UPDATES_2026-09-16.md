# Codlet 图标、运行时技能和更新入口

后续调整：底部技能说明改为标题旁问号弹窗，侧栏改用专门的小尺寸图标，见 [更新记录](HELP_DIALOG_AND_SMALL_ICON_2026-09-16.md)。

本轮按用户批准的 B 款图标资产接入侧栏、页面标题和入门说明；原始 SVG/PNG/ICO 位于 `assets/codlet`，不重新设计或改变图形。界面使用 currentColor SVG，随客户端颜色变化。skill 元信息使用同一几何的深浅适应 SVG；官方技能列表/输入框是否显示自定义图标由客户端控制。

## 行为

- 插件页的“检查更新”只发现 GitHub 托管插件的候选；“全部更新 (N)”仅提交当前显示为可更新且仍注册的插件 ID。扫描、安装和不确定状态有重复操作保护；手动检查跳过自动检查的短期缓存
- 单个“更新”和“全部更新”使用 Apps SDK UI 的 info/soft 样式，保留原生按钮大小和交互
- 设置移除检查间隔控件和插件更新区，保留启动时检查偏好；显示已安装、正常运行、未启用、需要关注四项数量。正常运行需要 active、enabled、validation ok 且没有执行错误
- 版本区提供“检查更新”并调用 Codlet 自身的更新服务。未配置发布源的开发版明确显示原因，不检查官方客户端更新，也不伪称已是最新
- 插件列表底部提供 skill 用法及“快速开始”。创建插件与快速开始分别打开创建/入门草稿，不提交模型任务

## 真正选择运行时 skill

Core 在管理列表中发布当前运行时 skill 的实际名称和路径。GUI 用客户端已经支持的 `[$codlet](path)` prompt-link 格式填入草稿；路径按官方 serializer 转义反斜杠和右括号。官方 composer 将它恢复为 skillMention。技能不可用时报告错误，不退回看似成功的 `/codlet` 文本。

Windows 26.908.40834/8881 和 macOS 26.908.70816/9275 的已安装/下载官方前端中均确认了该 parser/serializer 契约。Windows app-initial 文件 SHA-256：`7c3a89e7e224f76031b45a88f72af8cd60f0c3d47aac9ca34b2c70e11dfe9867`。

`runtime/skills/codlet/SKILL.md` 现在按介绍、管理、创建、排障分流，管理参考涵盖实际 CLI 语法、来源/权限、保持启用状态更新、级联停用影响和不确定操作回执。CLI 支持范围随 runtime.json 发布，测试客户端不错误调用正式 Core 的 doctor/status。创建流程保留用户要求的名字、目录、官方 UI、依赖和权限确认。

## 验证

- 76 项相关 JavaScript 测试通过，包括两个草稿入口、同一扫描去重、扫描期间禁止安装、明确的批量 ID 范围、运行统计和设置入口
- 583 项 Rust 测试通过，1 项已有真实客户端门禁保持 ignored；技能资源和 scoped CLI 测试通过
- TypeScript、Windows x64 Clippy、macOS ARM64 / Windows ARM64 测试编译及 Clippy 通过
- skill-creator 校验通过；实际 Core 的 skills/list 发现唯一 Codlet skill，新描述、界面元信息、图标路径可用，无技能解析错误
- 浏览器对真实生成的 UI 做浅色/深色、1280/640/480 宽度视觉验收，更新强调、筛选换行、设置统计和入门入口正常，控制台无错误
- Windows 隔离客户端实际显示 B 款侧栏/页面图标、可更新数量和柔和蓝色更新按钮；“创建插件”和“快速开始”均显示原生橙色 Codlet 技能标签及各自文案，没有发送任务

构建部署到现有隔离测试入口，备份位于 `.codlet-artifacts/version-source-2026-09-15/brand-skill-ui-backup`；启动 run `1789530825766-24328`，二进制 SHA-256 `88E7E331048EE9866165FA358CEDD28C92FB9BFD2580471C9F56147AB44B168C`。部署核对插件登记、偏好文件和日常客户端进程未改变。

本轮没有发布安装包，也没有进行 macOS 真机验收。原生技能选择验证停留在编辑草稿阶段，没有发送模型任务。
