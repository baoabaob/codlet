# M5b：GitHub 发布包与托管版本

日期：2026-09-12。实现范围：公开 GitHub release 资产的预览与导入、来源记录、显式更新/回滚、发布格式和社区发现入口。所有原生界面验收按 [M5b 手测指南](GITHUB_PLUGIN_MANUAL_TEST_2026-09-12.md) 记录；本阶段不关闭 [M0/M1 发布门禁](REMAINING_ACCEPTANCE_MANUAL_2026-09-12.md)。

2026-09-12 基线验证：270 项 Rust 单元测试与 232 项集成测试、153 项 JavaScript 测试、五份公开类型的严格检查、Clippy 和 7 组分发检查通过；显式启动真实 Codex 的旧门禁测试保持 ignored。

2026-09-15 新增真实远程验收：按用户授权发布了[临时测试仓库](https://github.com/baoabaob/codlet-update-smoke-20260915)，在隔离 Native 客户端完成 1.0.0 导入并启用、冷启动自动发现 1.1.0、界面显式审核与热更新；随后经同一 Core 管理入口回滚到 1.0.0 并停用，保留两个版本的来源历史。下载摘要与 GitHub 提供的摘要一致；界面中的 v1 标记被唯一的 v2 替换，更新完成后列表提示消失。具体分支见[手测记录](GITHUB_PLUGIN_MANUAL_TEST_2026-09-12.md)，未执行的分支不记为通过。

## 用户流程

1. 在 Codlet 的 **Import GitHub** 输入仓库或 release 链接，读取发布列表。
2. 明确选择一个 release 和 `.zip` 构建资产，下载并预览。
3. 核对仓库、release/tag、资产、插件 ID/版本、SHA-256、兼容性声明、权限和依赖。
4. 逐项授予所需权限并确认信任。默认不启用；勾选启用后才在注册完成时激活。

准备下载不会执行 JS，也不会安装依赖或运行仓库脚本。没有 release、只有源码归档、资产超限或包结构错误时返回具体原因；可由作者提供合规构建包，或手动下载检查后走本地文件夹导入。M5b 不提供 npm 式依赖自动安装。

只支持 `https://github.com/owner/repository`、`/releases`、`/releases/tag/tag`、`/releases/latest` 以及对应 release asset 链接。路径中的 tag 可以按 URL 编码。URL 不接受凭据、查询串、片段、非 GitHub 域或 GitHub Enterprise。公开 API 不使用本机 GitHub 登录、token 或浏览器会话；私有仓库和限流会明确失败。

公开 release 可通过未认证 API 读取；资产接口提供下载地址、大小及可选摘要。具体 release/资产仍由用户选择，不根据版本字符串静默更新。[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)、[Release assets API](https://docs.github.com/en/rest/releases/assets)

仓库列表最多读取前 100 个 release，达到上限会标记截断；需要更早版本时使用对应 tag/release URL。GitHub 的自动 Source code ZIP 不作为插件资产选项。

## 来源、所有权与生命周期

| 类型 | 保存位置与行为 |
| --- | --- |
| 本地开发目录 | 继续引用作者选中的原目录；明确授权；可选择 watch |
| GitHub 托管包 | 位于当前 registry 同级 `packages/github/` 下的独立目录；Core 创建来源回执，记录整包内容摘要；不启用 watch |
| 插件数据 | 与上述源文件分开；本阶段未新增自动清理数据操作 |

来源记录包含规范化仓库 URL、owner/repository、release ID、tag、asset ID/名称/URL/大小、下载 SHA-256，以及是否核对 GitHub 给出的摘要。摘要用于识别内容，不能替代对作者的信任。来源不会由调用者提交的 JSON 字段直接赋予。

正式注册前重读 Core 回执、包树和 manifest，并比较预览时的源内容、登记、权限、启用偏好和历史摘要。包内容或注册状态变化会要求重新预览。已安装托管包在启动、启用和 Reload 时也检查固定内容；需要编辑的作者应另用本地开发目录。

**更新与回滚都是用户主动操作。** 更新先下载候选，展示当前/候选版本、权限/依赖/兼容声明变化，再明确授权。回滚从已保留历史中选择一个版本，重新检查包与授权。使用相同的 `prepare → submit → operation` 管理回执；提交响应丢失只查询原 operation ID，不重放变更。

运行中的版本通过已有代次替换机制切换。候选激活失败时尝试恢复原登记和旧版运行；并发撤权等情况不允许恢复旧权限，则报告降级并保持安全停止。`RolledBack` 表示此次更新失败且已恢复，不能当作更新成功。

不同仓库不能因为插件 ID 相同就继承信任。必须先移除当前登记，再明确审核新来源。本地开发目录和托管来源也不能静默互换。**Remove plugin 只停用并取消登记，保留作者文件、托管文件和历史；不自动删除插件数据。** 当前最多保留 64 个登记过的版本，达到上限会拒绝新增历史，不暗删旧包。下载缓存暂不提供自动清理和去重；重复准备会得到独立目录。

## 作者发布格式

发布的是包含预构建入口的 ZIP，解压后的根目录必须直接有 `codlet.json`。不要把外层项目文件夹套进 ZIP，不要上传仓库源码归档作为替代。

```text
codlet.json
codlet-package.json     可选的发布与兼容信息
renderer.js             或 manifest 中声明的 renderer 入口
host.js                 如果声明 Host 入口
assets/...              实际需要的资源
README.md               使用方法、权限解释、来源与反馈入口
LICENSE.txt             适用许可证
```

`codlet.json` 仍使用原 schema，记录插件版本、权限、入口和 capability 的 API 版本/依赖。本阶段没有给这个既有 schema 加任意新字段。新增可选文件 `codlet-package.json`：

```json
{
  "schema": 1,
  "runtimeApi": 1,
  "platforms": ["windows-x86_64"],
  "author": "Your name",
  "adapters": {
    "codex.desktop": {
      "declaredBuilds": [],
      "testedBuilds": [],
      "limitations": ["Fill in actual evidence before claiming support."]
    }
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `schema` | 必须为 1 |
| `runtimeApi` | 可省略；声明时本版只支持 1，其他值拒绝 |
| `platforms` | 可省略；非空数组，如 `windows-x86_64`、`windows`、`any`；必须包含当前目标或更宽的平台声明 |
| `author` | 可省略，最多 512 字节 |
| `adapters` | 可省略，展示作者给出的 JSON；Core 不解释 Codex 私有构建规则 |

没有 metadata 或字段缺省时显示未知，不代表已通过兼容性验证。文件最大 64 KiB，未知顶层字段拒绝。README 中另外写明实际源码/反馈地址、许可证、维护状态、版本改动和测试日期；作者声明与真实测试结果分别填写。示例中的空 testedBuilds 不能替换成未经验证的支持声明。

ZIP 的当前限制：压缩文件 ≤32 MiB、展开总量 ≤64 MiB、文件/目录合计 ≤2048 项、相对路径 ≤240 字节、目录深度 ≤16。使用普通 ASCII 文件名、`/` 分隔的相对路径；不允许链接、Windows 设备名/别名、大小写冲突、重复路径、路径穿越、加密 ZIP 或 ZIP64。支持 Stored/Deflate。不要包含 `.codlet-source.json`；该文件由下载器生成。

仓库内提供 [Build-PluginPackage.ps1](../scripts/Build-PluginPackage.ps1)，仅把准备好的文件打包，不执行插件或作者构建命令。先在作者自己的构建流程中生成入口，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-PluginPackage.ps1 -PluginDirectory .\examples\github-release-check\v1 -OutputPath .\.codlet-artifacts\github-release-check-v1.zip
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-PluginPackage.ps1 -PluginDirectory .\examples\github-release-check\v2 -OutputPath .\.codlet-artifacts\github-release-check-v2.zip
```

脚本拒绝覆盖已有 ZIP。把两个 ZIP 分别上传到自己公开仓库的两个 release 资产，填写版本说明，再把 release URL 交给使用者。上述两个样例已于 2026-09-15 用于经用户授权的临时仓库验收；它们不是 Codlet 产品发行版。

## CLI：先准备，再明确安装

以下示例的 OWNER/REPO、数值 ID、目录和插件 ID 都要替换为实际值；在测试客户端目录使用 `Test-Plugins.cmd github ...` 可确保指向同一隔离 registry。

```powershell
codlet plugin github releases https://github.com/OWNER/REPO --json
codlet plugin github preview https://github.com/OWNER/REPO --release 123 --asset 456 --json
codlet plugin github install "预览返回的 path" --trust --grant ui.dom --enable --json
```

preview 只下载和检查，输出来源、权限和托管目录。install 不带 `--trust` 时只显示新鲜预览并返回未授权错误，不写 registry。根据实际 manifest 显式传每项 `--grant`，若使用 Host OS broker，还需相应 `--read-root` / `--network-origin` / `--executable`；这些仍按现有 [权限规则](LOCAL_PLUGINS.md) 校验。

更新与历史回滚：

```powershell
codlet plugin github preview https://github.com/OWNER/REPO --release 789 --asset 987 --update dev.example.github-release-check --json
codlet plugin github update dev.example.github-release-check "预览返回的 path" --trust --grant ui.dom --enable --json
codlet plugin github history dev.example.github-release-check --json
codlet plugin github rollback dev.example.github-release-check "历史中的 versionKey" --trust --grant ui.dom --enable --json
```

更新/回滚不带 `--trust` 可先检查候选。`--enable` 每次明确指定；省略会保存为停用。运行时使用原管理回执，离线时持有既有 Host 不存在租约并原子保存登记与版本历史。收到不确定结果时用 `codlet plugin operation 原ID --json` 查询。

## 社区发现

GUI 的社区链接打开 [GitHub Topic：codlet-plugin](https://github.com/topics/codlet-plugin)，CLI `codlet plugin github community` 输出同一网址。这是仓库标签约定，不是已建立的专属市场，也不保证已有可用插件。GitHub Topics 用于按主题分类与发现仓库。[Topics 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)

可复用的 Markdown 目录条目和维护规则见 [社区目录模板](COMMUNITY_PLUGINS.md)。目录只提供介绍、来源和维护状态；安装仍进入同一预览与授权流程，下架条目也不会在用户机器上自动停用或删除插件。
