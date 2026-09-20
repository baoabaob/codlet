# Codlet 页面布局、设置与版本信息

2026-09-14。本轮在已迁移的 Apps SDK UI 上统一原生页面尺寸，增加持久运行设置，并将版本详情与更新操作合并到设置页。旧版本弹出层和独立更新子页已移除。

## 原生参照与页面结构

参照已安装的 Codex `26.908.40834` / build `8881` / MSIX `26.908.4834.0`。Plugins 与 Scheduled 都使用 `app-initial-d9bed9d614d8.js` 的同一 SectionedPage（导出 `dD`，可读提取中的 `Z5a`）。本地提取只用于源码核对，运行时仍由限定构建的导航适配器加载实际原生组件。

| 项目 | 原生来源与 Codlet 使用值 |
| --- | --- |
| 标题、搜索、内容共同最大宽度 | `--thread-content-max-width: 48rem`，正常缩放下 border-box 768px |
| 共同横向内边距 | `--padding-panel: 20px`，可用内容宽 728px |
| 标题 | 工具栏下方 20px；28px、500、行高 1.2；按最新反馈取消额外内缩，与搜索、筛选和列表共用左边缘 |
| 副标题 | 14px / 24px，与标题间距 8px |
| 搜索 | 上 20px、下 8px；32px 高，全圆角；背景 `--color-background-page-search`，边框 `--color-border-primary-outline` |
| 正文 | 搜索区域后上间距 20px；与标题/搜索相同宽度包装 |
| 页面滚动 | 标题、搜索、正文共用一个 `overflow-y:auto` 和稳定 scrollbar gutter；搜索可吸顶 |
| 顶部导航 | 真正的 `AppShell.Header` / `HeaderToolbar`，46px 高、左右 8px inset |

宿主的宽度、padding 和语义颜色在 SDK 作用域之外解析，然后写入自有容器变量，避免同名 SDK 默认变量覆盖宿主值。控件本身继续使用实际 `@openai/apps-sdk-ui@0.2.2`、React `19.2.0` 和 Tailwind `4.1.13`，没有复制控件内部样式。新增的搜索边框映射只影响搜索框。

`ui.page({ toolbar: true, render({ toolbar }) { ... } })` 使页面的同一个 React 树通过 portal 渲染顶部“插件管理 / 设置”和操作按钮。页面主体不再叠加一排工具栏。原生 Header 分组采用懒初始化：`Uxa as hB` 初始化 `fQ as mB` 后才有 memo Header/Toolbar；导航适配器在精确构建检查之后调用原生幂等 initializer 并校验导出。

新增“全部 / 已启用 / 未启用”轻量筛选，与 ID、名称、描述搜索组合。筛选只使用后端确认的 `enabled` 布尔值；旧列表刷新失败仍显示错误并禁止状态变更。筛选、搜索和操作 receipt 不随进入详情或设置而丢失。确认页返回恢复原触发控件；筛选导致焦点行消失时把键盘焦点交还当前筛选。

## 真实持久设置

设置页包含自动检查 **Codlet** 更新、检查间隔、启动时检测插件更新和本地源码保存后自动重载。检查间隔只用于 Codlet 自身更新，插件启动检查不使用此间隔。界面没有语言覆盖项或更新源编辑项。

新公开方法 `getSettings(null)` 和 `saveSettings({expectedRevision, values})` 使用既有 `runtime.manage` 权限和 Core caller/generation 校验。`values` 是完整四个偏好：

```json
{
  "automaticUpdateChecks": true,
  "checkPluginUpdatesOnStartup": true,
  "updateCheckIntervalSeconds": null,
  "localSourceAutoReload": null
}
```

`null` 的间隔继承受信通道默认值，`null` 的重载开关继承原启动参数。显式间隔支持 300–86400 秒整数。返回值同时包含保存值、有效值、默认值、可用性和 revision；未配置 Codlet 发布源时相关更新控件不可用，版本区域说明开发状态。

偏好保存在 `<registry-path>.preferences.json`，与插件注册文件、grants、发布源和认证文件分离。读取缺省值不创建文件。保存使用有界文件锁、revision CAS 和原子替换，拒绝未知字段、链接/重解析文件、超大文件或错误 schema；跨 owner 同时写入不会覆盖较新的 revision。Host 在启动、停止或已有生命周期工作排队/执行时拒绝保存。响应不确定时界面只重新读取，不自动提交第二次。

`RuntimeUpdateService` 在保存后重新排程，关闭自动检查会清空 `nextCheckAt`；已配置但尚未检查的服务显示 `idle`。更长的显式间隔不会被六小时重试上限缩短。自动检查不能覆盖手工检查、下载、已下载或安装中的候选。关闭自动检查仍可手工检查、下载和安装。

源码 watcher 在当前 Host 真实启动或停用，沿用源码指纹校验、授权、依赖关系和既有生命周期队列；不会取消或重放已有操作。下次启动读取相同设置。2026-09-15 起，版本区仅保留三个本地版本字段，[客户端更新交由官方机制](OFFICIAL_CLIENT_UPDATES.md)；Codlet 自身的更新开关和间隔不影响官方更新器。

## 版本状态与可访问性

`versionStatus(null)` 独立返回 Codlet 版本、更新状态/错误和客户端状态，不读取整个插件列表。Codlet 页面可见时轻量轮询，通常五秒一次，更新工作进行时一秒一次；隐藏或离开停止版本轮询。即使未配置 Codlet 更新源，官方客户端监测结果也能到达管理页。

管理页正常只显示 Codlet 和版本号。只有已确认的新 Codlet 候选、官方客户端更新或不匹配才显示官方 `ExclamationMarkCircle`、宿主黄色语义色、tooltip 和可访问名称；未知、健康和普通开发状态不显示提示图标。已有候选在重新检查或失败时仍保留提示。

提示按钮打开设置，等待设置读取完成及布局稳定后滚动、聚焦并短时高亮版本区域。高亮状态文本只供屏幕阅读器使用；reduced-motion 下不进行平滑滚动。版本详情展示运行/安装/最新客户端版本、通道、检查时间、下一次检查、兼容性和实际更新阶段，并提供原有检查、下载、安装确认流程。插件列表、生命周期操作、设置和版本操作错误独立保存。

## 验证与隔离部署

- Node 全量：173 项通过；随后新增并通过 lazy AppShell 导出回归，导航专项 9/9。
- Rust `cargo test --all-targets --no-fail-fast -- --test-threads=1`：551 项通过，1 项原有手工集成测试 ignored，无失败；`cargo build --bin codlet-lab`、类型检查和 `git diff --check` 通过。
- 新增实际设置 API、持久化/CAS、失败 worker 设置恢复、真实 watcher 开关和重启恢复、调度间隔及下载候选保护回归；前端覆盖可见状态轮询、异常分离、设置保存不确定性、顶部/主体共享状态、离开清理、定位高亮及焦点恢复。
- 父任务在浏览器预览中验证 light/dark、640px 窄窗口、原生 768px frame / 728×32px 搜索几何、筛选搜索、导入授权、设置与手工更新操作、版本定位、页面回到顶部、筛选/间隔焦点和 portal 清理。

部署仅更新指定隔离测试安装的 `codlet-lab.exe` 和其 `labBinarySha256`。部署前原 registry、二进制、launcher config、run state 与精确进程身份已备份；原 preferences 文件不存在，已在备份 manifest 中记录。每次停启均重新校验当前 lab run/PID/创建时间，使用原 Stop/Start 脚本正常退出；旧 lab 进程全退出后才替换。原有客户端进程保持不变。

修正 lazy initializer 后的 run 为 `1789367915797-7408`，Desktop PID `60984`，Host PID `23548`，ready at `2026-09-14T06:39:01.085Z`。二进制 SHA-256 为 `73754D23E9A57BC5CFE8F2D23720D2AD9534F0BFE1AA2D3A8E1CAFB678E4D698`。启动后的 Doctor 为 fresh / ready / activation_ready；Codlet、UI 适配器和控件示例均 active，近期事件没有 UI 错误。Doctor 静态 passed 不替代后续原生页面操作验收。

父任务准备读取窗口列表进行最后一轮原生验收时，收到用户物理 Esc 停止信号，已停止电脑操作。新部署后的原生 light/dark、四页布局与设置实际生效的最终交互验收尚未完成，不能记为最终通过。按停止通知保留当前 ready 实例，不继续重启或改动 lab 设置；代码保持未提交，待用户恢复操作后再补验收结果。

本地完整日志、截图、原生源码尺寸核对及部署备份在被忽略的 `.codlet-artifacts/layout-unification-2026-09-14/`。没有发布正式版本或修改日常客户端。

## 后续细节修正

用户自行测试后提出的对齐、末尾句号、浮层裁切、添加菜单和插件启动检查，记录在 [UI 细节与插件更新检查](UI_POLISH_AND_PLUGIN_UPDATES_2026-09-14.md)。本节以前的测试数和原生验收限制描述的是上一轮部署。
