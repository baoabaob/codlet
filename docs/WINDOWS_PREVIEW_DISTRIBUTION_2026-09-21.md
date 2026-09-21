# Windows 本地 Preview：Core / 官方插件分仓与安装交付

用户要求先提供本地便携版和 MSI。源码仓库保持私有；本轮不发布公开 release。

## 代码边界

- `codlet`：Core、CLI、公开 SDK、通用 renderer UI helper、运行时 codlet skill、官方客户端启动/更新集成、构建和验收工具
- `codlet-plugins`：Codex Desktop Adapter、Codex UI Adapter、Codlet GUI 的源码、manifest、独立构建产物与插件测试
- Core 普通发行构建不内嵌、默认启用或保留官方插件 ID；选装插件使用相同的本地目录注册与权限机制
- 旧生命周期回归所需的两个模拟插件是明确的测试 fixture，不能进入发行构建，也不代替独立插件的真实测试

## 本地发行形式

- Windows x64 便携 ZIP：Core 与固定 Node、可选插件离线载荷、启动及插件选择入口；Codlet 数据使用包内独立目录，官方客户端数据位置保持由官方客户端决定
- Windows x64 MSI：当前用户安装，可选择 UI Adapter、Desktop Adapter、GUI；选择 GUI 时必须同时选择 UI Adapter
- 安装器管理 Core 与离线载荷；首次启动通过 CLI 将选定插件注册到用户的插件目录，不在 MSI 事务里运行插件或启动客户端
- MSI 卸载移除安装器拥有的程序与快捷方式，保留用户插件、配置和数据；插件更新不被 MSI 的 repair 操作覆盖
- 选择与初始化必须幂等，用户移除、停用或撤权之后不会因下次启动自动复原

## 验收

1. 独立 Core 无官方插件也能构建、列出空插件表并运行 CLI
2. 官方插件独立构建，依赖关系、GUI 自身保护及现有功能回归
3. 便携版首次配置、重复启动、Core-only 与 GUI 依赖选择、路径包含空格和中文
4. MSI 数据库及载荷核验、真实安装/修改/卸载，用户数据保留，测试不操作现有 dev 或日常客户端
5. 最终二进制与 ZIP/MSI 摘要记录；未签名、支持平台及尚未关闭的发布前问题如实说明

## 实施与候选验收

- 官方插件已迁到私有仓库 `https://github.com/baoabaob/codlet-plugins`，当前插件提交 `7d7d54d`；主仓普通发行构建没有内嵌插件
- Core 保留 124 项 Node 测试，全部通过；插件仓库的 136 项测试中 134 项常规检查通过，另两项使用隔离官方 AppServer 的 HTTP/WS 测试在本机补验通过
- Rust 全量分组回归完成；独立插件 ID 不再保留，相关旧断言已同步并通过定向复验，Clippy 将警告视为错误的检查通过。一次既有清理超时状态测试出现 `Failed/TimedOut` 时序差异，单独复验和后续整套运行均通过；没有放宽断言或修改生产期限
- 真正的无测试特性 release 二进制验证：空清单、Core-only、GUI 自动依赖 UI Adapter、三插件注册、重复初始化、停用/撤权/移除保持、CLI 移除 GUI，均通过
- MSI 候选已实际完成当前用户安装、维护追加 Desktop Adapter、卸载；自定义安装目录的卸载定位问题已修复，程序文件被移除，插件和用户数据保持原样
- 运行时技能的 PowerShell 与 Python 包装脚本通过实际 Core CLI 验证，都会覆盖无关的继承 `CODLET_HOME`，选择 runtime.json 中的正确 registry；skill 校验器通过
- 新增 MSI 安装标记，禁止使用便携 ZIP helper 替换 MSI 拥有的 Core 文件；本地 Preview 的更新源仍为空，MSI 通过下一份 MSI 升级

Windows UI 自动化读取 `msiexec.exe` 被产品策略拒绝，原因为 `product policy blocks this app`。组件行为和真实安装事务已经验证，安装器视觉观感没有计为通过。当前打开的候选安装器仅供用户手动查看，未通过它提交安装。

最终 ZIP/MSI、摘要和额外验收报告位于用户原项目的 `.codlet-artifacts/local-preview-2026-09-21/`；不上传真实运行配置或这些本地测试产物，不创建公开 release。

## 最终本地交付

源码实现提交为 `35e8d86f75054d21b01cca17811be7e636626c9e`，Codlet 版本 `0.2.0-preview.1`，独立插件提交 `7d7d54d`。最终产物均未签名：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Codlet-0.2.0-preview.1-win-x64.zip` | 43167869 | `33a184f57abec537fd25d9feb9962d0feed5bbfbad40408d027385663367718b` |
| `Codlet-0.2.0-preview.1-win-x64.msi` | 35610624 | `a181dbdbee21c6f6eccc9739a75ad4204c342ecf22d51d71a121bc61ebf1d693` |

`portable-final-acceptance/report.json` 通过五组验证，补充确认旧 GUI 禁用偏好不会被重新启用，省略 plugins 字段的有效 registry 也能初始化。`msi-final-acceptance/report.json` 通过实际 Core-only 安装、追加 GUI/UI Adapter、追加 Desktop Adapter、卸载及用户数据保留。测试安装已全部卸载；最终包未包含 config.json、auth.json、运行日志或数据库。

这次未启动或替换用户的日常客户端和原有 dev。实际已安装的官方 Windows 包为 `26.915.4065.0`，对应本次说明的已研究前端 `26.915.31945 / 9922`。先正常关闭已有官方/Dev 实例，再用便携包的 `Start-Codlet.cmd` 或 MSI 的开始菜单入口试用。
