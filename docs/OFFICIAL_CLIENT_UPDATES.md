# 客户端版本信息与官方更新边界

版本信息仅展示 Codlet 版本、当前客户端版本、Codlet 适配版本。客户端检查、下载和通知交由官方客户端；2026-09-19 增加官方安装后的 Codlet 重启接管，以及用户明确确认的“同时更新”。具体实现见 [更新交接记录](OFFICIAL_UPDATE_HANDOFF_2026-09-19.md)。

## 当前行为

- Core 在启动时记录当前客户端的本地包版本；只有收到自己启动的官方进程的安装重启信号后，才等待本机包升级，不请求公开更新清单
- Codlet 适配版本来自内置 UI Adapter 的 `client-versions.json`，与当前客户端使用相同的 Windows 包版本格式
- 不增加官方检查按钮、渠道或检查时间；“同时更新”仅使用官方现有状态，并在确认后通过 Core 调用官方安装入口
- 首页只提示 Codlet 自身已有更新，或当前运行版本未通过 Codlet 适配验证；不会因远端清单数字更大而提示客户端可更新
- 未配置 Codlet 自身更新源的开发版本不会虚构更新状态

### 隔离 Dev 启动器

`src/lab.rs::lab_environment` 将 `BUILD_FLAVOR` 设为 `dev`、`CODEX_SPARKLE_ENABLED` 设为 `false`。官方 `.vite/build/file-based-logger-C6QKdHxk.js` 的更新启用判断会读取这个开关。因此，日常客户端显示下载/更新按钮时，同一个安装包启动的隔离 Dev 窗口也不会显示它。这是测试启动配置，并非 Codlet 的插件更新检查遗漏了客户端版本。

Codlet 设置仍只显示三项本地版本信息；不要为了模拟官方更新通知，重新接入公开清单或给 Dev 伪造更新状态。

以下保留此前核对官方代码与发布来源的审计依据，用来解释移除公开清单判断的原因。

## 核对的代码

本机包 `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0`；应用版本 `26.908.40834`，build `8881`。

| 位置 | 依据 |
| --- | --- |
| `app-initial-d9bed9d614d8.js` | `Iq as TW` 为现有服务，`TW.appUpdates.checkForUpdates()`；`tJ as rU` 为更新信号，`q3i as iU` 为组织禁用标志 |
| 同一 Native 模块 | `JMt` 接收 `stateChanged` 并由 `Jao` 写入更新信号 |
| `.vite/build/main-D8abTQQE.js` | `oA.checkForUpdates()` 转发到 SparkleManager；`getAppUpdateViewState()` 定义真实推送字段 |
| `.vite/build/window-all-closed-BxbCP6YG.js` | `Gw` 只用公开清单决定是否向 Store 检测；`performCheck` 必须根据 Store 结果判断；无更新会显示官方“已是最新”对话框 |
| `.vite/build/file-based-logger-C6QKdHxk.js` | Prod 使用 `codex-app-prod` / `9PLM9XGG6VKS`，PublicBeta 使用独立的 `codex-app-beta` / `9N8CJ4W95TBZ` |
| `.vite/build/src-CCXHtyvY.js` | `Du` 导出 `une`，将应用版本的构建日期/时分编码转换成 Windows 包版本 |

以上名称属于 2026-09-15 的审计版本；新的安装交接使用另行核对的 26.915.31945 / 9922 配置，不根据这些历史名称猜测新版本接口。

## 为什么原先的清单提示与官方客户端不同

以下均为只读核验，没有触发官方检查、暂存或安装：

1. 公开清单返回 `26.908.9136.0`，HTTP Last-Modified 为 `2026-09-14 19:45:01 UTC`
2. 日常官方客户端日志在 `2026-09-14 23:52:41 UTC` 记录本机 `26.908.4834.0` 与清单 `26.908.9136.0`；约一秒后记录 `hasUpdate=false`、`overallState=NoUpdates`
3. 按官方回退代码拼出的 `releases/26.908.9136.0/ChatGPT-x64.msix`，本次 HEAD 和限定 Range GET 均返回 404
4. [官方 Windows 部署文档](https://learn.chatgpt.com/docs/enterprise/windows-deployment)的固定 x64 链接可读取；只读取 ZIP 目录和 XML（约 787 KiB），包内身份版本为 `26.903.8094.0`，并非 `9136`

因此，地址属于正式渠道；把它当成当前已向所有用户开放的最新可安装版，是语义错误。已证实本机 Store 没有提供该更新，以及本次核验的 CDN 路径与清单不一致；不能据此认定所有用户、架构或地区都不能更新，也不能把具体原因未经验证地归为灰度、审核或同步延迟。

### 数字为什么看起来相差很大

同一 `26.908` 基准下，官方转换公式为：`(构建日序号 - 1) × 1440 + 小时 × 60 + 分钟`。

`26.908.40834` 转为 `26.908.4834.0`：`3 × 1440 + 8 × 60 + 34 = 4834`。按同一规则反推 `9136` 是第 7 日的 08:16 编码，两者相差 4302 分钟，即 2 天 23 小时 42 分钟，不能解释成几千次产品发布。

复核脚本与证据保留于工作区 `.codlet-artifacts/version-source-2026-09-15/`。历史审阅源码位于原工作区 `.codlet-artifacts/official-update-audit-2026-09-13/` 和 `.codlet-artifacts/desktop-compatibility-2026-09-13/`。
