# 1.0.0-rc.1 本地候选验证

日期：2026-10-15（Asia/Shanghai）。本轮完成 Core SDK、权限边界、兼容在线更新与消费者迁移的实现；交付只在本机生成，没有公开发布，也没有安装到日常 Native 环境。独立 Native 的最终功能与连续流验收仍在收尾，下面只记录已有证据。

## 源码与交付身份

| 项目 | 实施提交 | 版本 |
| --- | --- | --- |
| Core | `9a405465b0308e004e3bd820c5e086452dc58a0f` | `1.0.0-rc.1` |
| GUI 与完整功能测试插件 | `dcdf5166ba10acb54086f95ac28fefed556b560e` | `1.0.0-rc.1` |
| 分屏 | `9ab77299cd5acb685f048ae859e57a939c7d1236`（基础迁移 `d60a7be3bdcad2ae14331d30b67055726b850068`） | `1.0.0-rc.1` |

三个仓库均使用本地 `codex/unified-core-v1` 分支。接手时的 Core 与官方插件工作区先分别保存为 `520f581c81b2ad336a0aa45b0ad0cb4341ff5271`、`af7694d63e1ca391e0c924f6f3db9f718659e055`，之后才提交此次迁移；已有修改和旧验证记录均保留。

Windows 制品位于 `.codlet-artifacts/major-v1-delivery-20261015-a/`。其中 Core 安装器、便携 ZIP 和运行时更新 ZIP 绑定表中的 Core 实施提交。私有验收工具随后在 `b2695c35bab435fa50641eaa630822824c38f4ae` 修复 Windows 路径规范化和有界拒绝回执；它仅在 `desktop-acceptance` 下编译，不改变生产程序。后续验收文档或测试控制工具的提交不会改变这些已生成包的源码身份。最终交付目录的清单列出全部文件大小与 SHA-256。

## 自动检查

| 范围 | 结果 | 证据文件（相对 Core 仓库） |
| --- | --- | --- |
| 仓库 CI 配置的 Rust 全目标、全功能 | 801 通过，0 失败，9 忽略 | `.codlet-artifacts/major-v1-rust-ci-verified.log` |
| 默认生产 Core：库与七个重点集成 suite | 609 通过，0 失败，8 忽略 | `.codlet-artifacts/major-v1-rust-default-core-verified.log` |
| 组合生命周期、GUI 别名、CLI、doctor 的两种模式 | 默认 21/21；全功能 21/21，顺序执行 | `.codlet-artifacts/major-v1-selected-cli-verification-20261015.md` |
| Core Node 测试 | 341/341 | `.codlet-artifacts/major-v1-core-node-final-verified.log` |
| Core 内置 UI/Desktop 模块 | 341 通过，0 失败，2 跳过 | `.codlet-artifacts/codex-adapter-owned-tests-final.log` |
| 官方插件源仓 | 454 通过，0 失败，4 跳过 | `.codlet-artifacts/major-v1-plugins-final-verified.log` |
| 分屏消费者 | 147/147 | `.codlet-artifacts/major-v1-split-onboarding-full.log` |
| TypeScript | 通过 | `.codlet-artifacts/major-v1-typecheck-verified.log` |
| Rust 格式与严格 Clippy | 全目标、全功能、`-D warnings` 通过 | `.codlet-artifacts/major-v1-fmt-verified.log`、`.codlet-artifacts/major-v1-clippy-source-commit-verified.log` |
| runtime skill 校验 | 通过 | `.codlet-artifacts/major-v1-skill-validation-verified.log` |
| macOS 打包逻辑的 Python 检查 | 6/6；在 Windows 执行 | `.codlet-artifacts/major-v1-macos-package-python.log` |

私有验收工具补充修复后，全目标/全功能严格 Clippy 与格式检查再次通过，日志为 `.codlet-artifacts/major-v1-clippy-fixture-e.log`、`.codlet-artifacts/major-v1-fmt-fixture-e.log`。没有据此改写上表生产实施提交的测试计数。

上述范围有重叠，不能把各行相加作为独立测试总量。Rust 的完整合成集成测试使用仓库规定的 `test-fixtures` 功能；默认生产检查单独列明范围。早期同时构建两种功能组合的诊断轮次可能覆盖共享 CLI 输出，未计作最终通过证据；最终 CI 和重点双模式检查均顺序执行。官方插件的四个跳过项涉及额外运行环境或真实 AppServer；不计为通过。

关键回归包含：旧 Adapter 注册、授权与文件保留；固定 Core 提供者不与旧注册竞争；普通 SDK 不借用 Core 的原始权限；原始 Host、CDP、主世界及指定程序边界；跨代状态恢复；已接受调用与流的清理；迟到回执只查询、不重放；并发模块更新和未知结果保留所有权。

实际前台协调器测试使用 VM Renderer、真实 Node Host 与真实鉴权桥接传输，验证 Applied/NextStart、丢失首个 source/release 回执、Host 计数状态恢复、唯一接管与各层写入门禁释放。它属于组件集成证据，不能替代 Electron Native 的实际会话验收。

## 制品检查

- Core 以生产功能构建 release 可执行文件；没有打入合成测试插件或独立验收入口。
- MSI 只读结构检查通过：Core、GUI、开始菜单、桌面快捷方式、PATH 五个选项；没有单独 Adapter、Node 或插件载荷；不自动关闭正在运行的应用。没有执行 MSI 安装。
- 便携包 CLI 在独立 `CODLET_HOME` 中显示两个 `owner: core` 的内置提供者和空普通插件列表。GUI 包预览与离线注册通过，只声明 `ui.dom`、`runtime.manage`。
- GUI 生成发布目录绑定干净的官方插件源仓提交，重新编译的字节与包中 bundle 一致。完整测试插件 ZIP 排除测试凭据、服务器数据和报告。
- 运行时 ZIP 为未发布的 preview/portable 首次迁移包，不带在线组件元数据，下载 URL 为空。它不能冒充已上线的更新通道。

## 实机证据与前置条件

Windows Native 包为 `26.1007.9446.0`，前端 `26.1007.71326` / build `20398`，独立后端 `0.162.0-alpha.17.2`。每个测试 run 均使用独立 profile、项目、合成服务和精确 PID/创建时间核验；没有向日常会话发送测试输入。

验收程序 D 的 SHA-256 为 `81db432cb72f05b73d1c9162cd9aa6707fae56ff6cedb07114c9f7af4c367fc9`。其构建前后源码清单一致，`source-inventory.json` SHA-256 为 `e4b15de7902653560054b59487e54470568a3f1f3ad7db349aecc01c2a146b49`。它是带 `desktop-acceptance` 的私有验收程序，不是安装器中的生产程序。

早期 C run `230705d5-0a10-4821-94f4-1b9a883b21a4` 的 Host 10 项通过，Renderer 7 项通过、3 项失败、1 项人工待验；分屏导入超时。探测与 DOM 证据表明它停留在 `/welcome`，没有 Native 导航栏、主工作区或输入器，不能算 UI 已就绪。修复后的分屏初始化允许欢迎页上的导航准备继续异步完成，进入分屏仍检查真实能力；相关两项真实消费者控制器回归通过。原始失败与回执均保留在该 run 目录，不把后端 ready 当作工作区 ready。

D run `49ccb623-caab-42ca-98cd-9e2e46dc0aca` 通过正常欢迎流程进入主工作区后，完整测试插件的 Host **10/10**、Renderer **10/10** 自动检查通过；包括存储冲突、事件、任务取消、文件、进程、网络凭据、HTTP/SSE/WS、自有流量拦截、Desktop 读取、原生页面/工具栏/控件及未发送草稿。单独的模型操作仍标为人工待验。GUI 与最新分屏导入均 `applied`、无 target failure；GUI 页面实际显示普通插件，未把 Core 提供者当作可管理插件。此时没有合成会话正文，尚不能据此认定分屏会话进入/选择已验收。D 于 2026-10-15 02:30:54（Asia/Shanghai）正常关闭，Core exit 0，五个已核验根进程身份全部不存在。

D 的合成流量 source 描述因测试工具将 Windows 普通路径与 verbatim 路径作字符串比较而被拒绝；原输入已消费，不重放。E 使用上述私有工具修复和新的独立 run。E 验收程序 SHA-256 为 `d232f7bc2c9c7f1416ec0c7580cb796224ca47fa98fec77eac9e78b4b82a7967`；源码清单 SHA-256 为 `3e70606a277ce4b8ea283e8f40bf3b88cc77051795e7bb143d7325bcdede8e69`。D/E 均使用固定 bundled Node pin，避免用生产 managed pin 冒充已备齐的在线组件安装布局。

## 更新与兼容边界

兼容更新可替换十一项声明的 JavaScript 模块及 Native source，并恢复显式插件 JSON 状态。Rust 可执行程序、Node、固定桥接/注入与转发层仍属于 Core；这些常驻组件的变化，以及首次从旧架构升级，需在下一次自然启动生效。存在活动的插件自有 Host 流量资源时会延后，保留原调用与资源。

真实 Native 流量验收使用明确标为 `fixture-explicit-source` 的本地合成源。它不能证明自动 backend-spawn 适配、真实 OAuth 服务或任意外部后端的迁移。普通插件仍是可信代码模型，Node `vm`、共享 DOM 与权限标签均不是恶意代码沙箱。返回 Native 函数、React 上下文和本地 DOM 句柄的 Workspace API 仍需要主世界权限；一般数据、页面和标准服务接口不因此继承该权限。

没有本轮 macOS 桌面、Windows ARM64、全新设备安装/升级/卸载或签名验收。附件、IME、系统快捷键冲突及真实剪贴板交互也必须按实际场景单独记录，不能从 jsdom、IPC、旧版记录或 Native 只读探测推断通过。
