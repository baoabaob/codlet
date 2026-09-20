# 平台支持目标与当前证据

2026-09-16 重新核对官方桌面客户端文档。Codlet 的完整适配目标跟随官方桌面客户端提供的系统与 CPU 架构，按每个组合分别实现和验收。用户此前要求暂缓 Linux，因此它属于后续目标，本轮继续 Windows 与 macOS 开发试用。

| 系统 | CPU 架构 | 官方依据 | Codlet 当前状态 |
| --- | --- | --- | --- |
| Windows | x64（x86_64 / AMD64，适用于 Intel 和 AMD） | [官方 Windows 部署文档](https://learn.chatgpt.com/docs/enterprise/windows-deployment)提供 x64 MSIX | 正在 Dev 试用，已有本机功能、回归和运行证据 |
| Windows | ARM64（aarch64） | [官方 Windows 部署文档](https://learn.chatgpt.com/docs/enterprise/windows-deployment)提供 Arm64 MSIX | 已有独立运行时 pin 和严格编译检查，待 ARM64 Windows 实机验收 |
| macOS | ARM64（Apple Silicon） | [官方桌面应用页](https://learn.chatgpt.com/docs/app)列出 Apple Silicon 下载 | 原生 Core、管理与前端 profile 已实现，待 Mac 功能和视觉验收 |
| Linux | x64 | [官方 Linux 桌面文档](https://learn.chatgpt.com/docs/linux/linux-app)列出 x64 预览包 | 已列入完整目标，按用户要求暂缓实现 |
| Linux | ARM64 | [官方 Linux 桌面文档](https://learn.chatgpt.com/docs/linux/linux-app)列出 ARM64 预览包 | 已列入完整目标，按用户要求暂缓实现 |

官方 Linux 预览覆盖 Ubuntu 24.04 / 26.04 LTS、Debian 13、Fedora 43 / 44 和更新到当前版本的 Arch Linux；每个发行版均提供上述两种架构。恢复 Linux 工作时按此范围建立发行版与桌面环境验收项。原生 Wayland 在官方客户端中仍为实验状态，需分别记录 XWayland 与原生 Wayland 的结果。

当前核对的 macOS 下载为 Apple Silicon；macOS Intel 未列入已确认的官方下载范围。x64/AMD64 是架构名称，不表示仅支持 AMD 处理器。

## 验收规则

- 官方提供下载意味着进入 Codlet 的目标矩阵，不自动意味着 Codlet 已兼容
- 每个系统和架构分别记录官方安装身份、前端构建、后端版本、受管 Node、启动/退出、插件管理、IPC、故障恢复和 UI 验收
- 源码 profile、交叉编译、模拟协议测试与真实客户端验收分开记录；只有实机验收通过才更新对应适配版本清单
- 官方后续增减平台时先更新此矩阵，再安排实现和验收；不因只补了一个枚举值或运行时包就显示支持
- 当前继续开发试用，打包发布、安装交付和最终图标设计延后

实现与验证见 [架构复审](ARCHITECTURE_REVIEW_2026-09-16.md)、[开发运行记录](DEVELOPMENT_REVIEW_2026-09-16.md)和 [macOS 说明](MACOS_DEVELOPMENT_2026-09-16.md)。
