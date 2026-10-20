---
name: codlet
description: Explain and operate Codlet desktop extensions. Use for Codlet questions, onboarding, finding, installing, updating, enabling, disabling or removing Codlet plugins, permissions, troubleshooting, and creating plugins with codlet.json. Uses the running Core's scoped CLI and public APIs
---

# Codlet

本技能随 Codlet Core 运行提供，用于介绍、管理、排查和开发 Codlet。先读取同目录的 `runtime.json`，取得当前 Core 的版本、实际插件目录、CLI 包装脚本和支持的命令。操作当前实例，不猜路径，不调用 PATH 中另一个 `codlet`，不修改用户的技能目录。

## 根据需求选资料

- 了解 Codlet、快速开始、版本/安全模式/适配层问题：读 [使用说明](references/overview.md)
- 查找、安装、启停、更新、卸载、权限和故障排查：读 [插件管理与 CLI](references/management.md)，使用其中的真实命令完成用户已经请求的操作
- 创建或修改插件：读 [创建流程](references/creation.md)，根据功能选取合理默认值，按需读 [开发契约](references/plugin-api.md)
- 需要与客户端一致的控件时，读 [官方 UI 参考](references/official-ui.md) 和它链接的详细资料

不必一次加载所有开发文档。询问用法或更新现有插件时，不要启动创建插件的需求问卷。

## 工作方式

- 用户的操作请求就是对该范围的授权。先检查当前状态，完成能够确定的工作；仅在目标不明确、新来源/新增权限未授权、额外级联停用或删除源文件不在已授权范围时询问
- 使用 CLI 返回的实际 ID、来源、版本、权限和回执。区分“已注册/允许启用”和“正在正常运行”，不要把列表中的 enabled 当成成功运行证据
- Codlet 插件采用 `codlet.json`，与 Codex 官方 `.codex-plugin/plugin.json` 插件是两套体系；先辨认用户管理的是哪一种，避免在错误目录安装
- 执行后读取结果、必要时复查列表或运行状态；遇到不确定提交只查询原 operation ID，不能重放安装/更新
- 输出用户理解得了的结果、必要的下一步和未验证的限制，不倾倒内部字段；回答一般问题时引用本地事实，未知功能不要臆造
- Core 提供本技能，无须启用 Codlet 管理界面。运行时目录由 Core 管理，不能用来存插件项目或持久数据
- 源项目写入 `runtime.json.defaultPluginProjectsDirectory` 或用户指定的工作区；`defaultPluginsDirectory` 是安装副本目录。修改源码后重新构建并 `plugin add <source> --update`；`reload` 只重启已安装的副本
- Core 1 提供统一 `context.codex` SDK，UI/Desktop Adapter 已内置；不要要求用户安装或升级同名旧插件。旧注册可能以 `legacyAdapterRegistrations` 保留，实际能力查看 `coreProviders` 和独立探针
- 在线更新只以回执中的实际 `activation` 范围为准；模块生效、保留的常驻组件与下次启动生效项分别说明。不要用窗口或 PID 未变代替会话/流式请求连续性的证据
