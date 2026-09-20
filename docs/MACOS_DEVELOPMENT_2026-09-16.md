# macOS 开发适配与验收

本轮只做 Windows x64、Windows ARM64 和 macOS Apple Silicon（ARM64）。Linux 明确暂缓；macOS Intel 不在目前确认的官方发行范围。图标、安装包、签名发布与更新分发继续延后。

## 状态

macOS 已加入原生源码、CLI 和开发构建入口。目前执行环境是 Windows，交叉编译检查只证明目标代码能够通过编译器检查；尚未在 Mac 运行真实客户端，也没有 macOS 视觉验收。适配版本清单按系统和架构独立记录，未验收的目标保持空清单。

后续复审已补齐 Mac `26.908.70816 / 9275` 的 UI adapter、Desktop adapter 和 runtime skill 构建映射，统一到 `compatibility/client-profiles.json`。此前三处仍只识别 Windows 构建，原生 Core 编译通过并不表示这些功能可用；此缺口已在源码和模拟模块回归中修复。详细资源、导出和后端证据见 [架构复审](ARCHITECTURE_REVIEW_2026-09-16.md)。Mac 实机验收仍待执行。

## 官方客户端依据

2026-09-16 从[官方下载入口](https://learn.chatgpt.com/docs/app)所指向的 `Codex.dmg` 读取了应用元数据和主进程代码，未修改或运行官方包：

| 项目 | 读取结果 |
| --- | --- |
| Bundle ID | `com.openai.codex` |
| 应用/可执行文件名 | `ChatGPT.app` / `Contents/MacOS/ChatGPT` |
| 版本 / build | `26.908.70816` / `9275` |
| 最低系统 | macOS 13.0 |
| 架构 | ARM64 Mach-O |
| CodeDirectory Team ID | `2DC432GLL2` |
| ASAR header SHA-256 | `340b778018913d33af444b975309b8f7eae8c532c366b5f4138d502911752ed8` |

运行时重新读取 `Info.plist`，通过系统 `codesign` 验证 Apple 签名链、Bundle ID 和 Team ID，并复核所选应用在准备期间没有改变。不会只按显示名称猜可执行文件，也不修改 ASAR、重新签名官方包或连接现有日常实例。

Windows 继续固定 Node 24.21.0。该版本的官方 Mac 二进制最低要求 13.5，因此 macOS 选择仍处于 [LTS 维护期](https://nodejs.org/en/about/previous-releases)的 [Node 22.23.2](https://nodejs.org/download/release/v22.23.2/)。实际 Mach-O 最低版本为 11.0，可覆盖官方客户端的 13.0 要求。各目标的归档、二进制和许可证均有独立摘要；插件使用 Node 专属 API 时需要考虑此版本差异，跨平台插件优先使用 Codlet Host API。

## 平台边界

- 共用插件命令解析、注册、权限、依赖、生命周期、RPC、更新事务和控制回执校验
- macOS 使用继承的 Unix socket pair 提供 CDP fd 3/4；取消通过持有的 socket 中断阻塞读写
- 控制端点使用私有 Unix socket 目录、registry 文件锁、对端 UID/PID/启动时间及可执行文件检查；只有连接阶段确认不存在端点，才能报告未运行
- 文件访问逐级使用 `openat` / `O_NOFOLLOW`，读取目录和移除内容基于已打开的目录描述符；不会沿符号链接进入其他目录
- 删除回执统一为 SHA-256；POSIX 路径保留大小写与字面反斜线；目录移动后的清理会在删除内容前拒绝
- 受管 Node 执行私有、已校验的副本，保留至最后一个使用它的 Host 退出；不依赖 PATH 中的 Node
- 原生文件夹选择和打开目录接入原有管理 GUI；安全模式沿用同一恢复会话和权限规则
- 插件自动检查、单个更新和全部更新使用原有 GitHub 服务与队列
- 插件回收进程使用独立进程组，终端向 Core 发送 Ctrl+C / SIGHUP 时仍能处理 lease 断开并回收插件
- Core 接收 SIGINT / SIGTERM / SIGHUP 后走常规停止流程，移除运行时 skill、停止插件，并请求本次客户端正常退出；超时只清理本次启动且尚未回收的子进程
- 启动后的身份检查、CDP 初始化或插件初始化失败时，由进程所有者清理本次启动的客户端，避免留下无法管理的窗口

macOS 为插件进程增加独立的 Core lease 观察进程，在 Core 连接消失后回收它创建的进程组。进程组不是 Windows Job 的完全等价物：自行脱离组的后台守护进程不在这一回收保证中，插件不应通过 `setsid`、脱离组等方式延长生命周期。返回结果用 `ownershipScope` 区分平台，保留 Windows 的 `jobReaped` 字段兼容性；不把进程组报告成 Windows Job。

Codlet 自身的 Mac 更新安装/自动重启交接尚未开放，`installAvailable` 保持 false；检查配置可用。Mac 更新分发需要后续原生包、签名与恢复验收，本轮不发布更新源。独立 Dev/WebSocket 启动器仍属于 Windows 实验工具，Mac 当前使用原生 Core 入口。

## 在 Mac 构建和试用

需要 Apple Silicon Mac、macOS 13.0+、Xcode Command Line Tools、Rust 1.97+ 和 Python 3。若修改了前端，先按 README 重建前端产物。源码已包含 Core 所需的生成文件。

```sh
bash scripts/build-macos.sh
sh scripts/test-macos.sh
target/aarch64-apple-darwin/debug/codlet doctor --json
target/aarch64-apple-darwin/debug/codlet launch
```

构建脚本读取 Cargo 的实际输出目录，兼容 `CARGO_TARGET_DIR` 和 Cargo 配置中的 `target-dir`；上面的默认路径以脚本最后打印的路径为准。

如果有多份官方应用，使用 `launch --app /Applications/ChatGPT.app` 指定。先正常退出原有官方客户端，保持 Core 所在终端运行，最后正常关闭本次客户端，或在终端按 Ctrl+C 结束本次 Codlet 会话。恢复模式使用同一可执行文件的 `launch --safe-mode`，不增加独立安全模式快捷方式。

配置默认位于 `~/Library/Application Support/Codlet/config.json`。插件、错误日志和运行时 skill 均放在此 Codlet 目录下，Core 不写入用户或项目的技能文件夹。创建插件所用的 skill 会提供实际 CLI、解释器和目录信息。

Runtime skill 先生成完整的临时目录再发布，临时文件位于 extra skill root 之外。可确认属于同一 registry 的中断暂存目录会在下次启动清理；不把缺少所有权信息的目录当作可删除的垃圾。

## 尚需原生验收

1. `sh scripts/test-macos.sh`，执行严格 Clippy 和全部原生 Rust 测试，包括真实 socket 取消、进程身份、目录链接以及新增进程生命周期回归
2. 实际客户端启动、已有实例拒绝、正常退出、Core 异常退出与插件进程组清理
3. 本地导入、GitHub 导入/更新、全部更新、依赖移除、撤权和故障恢复
4. 正常模式与关闭管理 GUI 后的唯一 `/codlet` skill、创建插件草稿和 CLI 注册
5. 浅色/深色、侧栏选中、页宽与间距、窄窗、提示和菜单层级、原生文件夹选择
6. 安全模式、配置损坏恢复、诊断导出，以及启动日志/后台进程无残留

这些步骤通过后才能把对应平台和客户端版本写入适配清单。交叉检查和 Windows 的验收不能替代它们。

### 进程回归用例

`tests/macos_native.rs` 通过独立的 `codlet-fake-child` 驱动实际 `HostSupervisor` 和 Mac 回收进程；回收进程重新执行同一文件，保留生产环境中的父进程身份检查，不给测试开放跳过认证的入口。覆盖合作退出、拒绝退出的子进程、Core 被 SIGKILL 结束、整个终端进程组收到 SIGINT/SIGHUP、正常信号处理、错误协议和阻塞输入，并确认无关进程存活。`lifecycle` 单元测试另外覆盖启动失败时只回收所持有的直接子进程。

这些用例不启动官方客户端，不读写日常注册表、不连接外网，也不进行 GUI 操作。目前已通过 ARM64 目标编译和严格 Clippy，尚未在 Mac 上执行。真实客户端的退出提示、窗口激活和视觉表现仍按上面的清单单独验收。
