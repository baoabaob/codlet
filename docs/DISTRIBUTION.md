# Windows x64 本地 Preview 分发

Core 与官方插件分别构建。普通 Core 发行构建不包含任何官方插件；`codlet-plugins` 仓库提供 UI Adapter、Desktop Adapter、GUI 三个独立包。运行时 skill 与公开 UI SDK helper 仍属于 Core。

官方插件集中在 `codlet-plugins` 开发，自动同步到 `codlet-ui-adapter`、`codlet-desktop-adapter`、`codlet-gui` 三个分发仓库，各自拥有 topic、标签与 Release。开发与分发流程见 [官方插件分发说明](https://github.com/baoabaob/codlet-plugins/blob/main/docs/DISTRIBUTION.md)。Core 安装包仍消费统一 catalog，并记录每个插件的独立仓库、版本和包摘要，不需要在主仓复制官方插件源码。当前私有草稿阶段继续使用本地离线载荷；已有预装的本地来源不自动转换为 GitHub 来源。

## 构建

先构建 Core、固定 Node 和插件仓库的 `dist/`：

```powershell
node frontend/build.mjs
cargo build --locked --release --bin codlet --no-default-features
./scripts/Install-JsRuntime.ps1 -Destination target/release
./scripts/Build-Distribution.ps1 -CodletExecutable target/release/codlet.exe `
  -NodeDirectory target/release/runtime/node-v24.21.0-win-x64 `
  -PluginDistribution C:/checkouts/codlet-plugins/dist `
  -OutputDirectory .codlet-artifacts/codlet-preview -Zip
node scripts/build-msi.mjs .codlet-artifacts/codlet-preview C:/tools/wix-3.14.1 .codlet-artifacts/codlet-preview.msi
```

示例目录须替换为实际路径。工具只复制校验后的明确载荷，不携带真实 registry、账户、缓存、开发日志或 `node_modules`。打包不启动插件或官方客户端。Node 按项目固定摘要验证；插件按独立 catalog 的每文件摘要验证。

WiX 3.14.1 的官方工具归档：`https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip`，SHA-256 `6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31`。使用原生 MSI 特性和标准 WixUI，不运行安装自定义动作。ICE91 的当前用户目录警告和 ICE61 的同版本 Preview 重装警告是明确的设计选择；其余验证不得跳过。

## 使用与所有权

- 便携版先完整解压，运行 `Start-Codlet.cmd`；首次启动选择官方插件，默认推荐三项。`Choose-Plugins.cmd` 可补装；选择 GUI 自动包含 UI Adapter
- 便携版 Codlet 数据在 `data/`。`Codlet-CLI.cmd` 使用同一数据目录，原生 CLI 也接受绝对目录的 `CODLET_HOME`
- MSI 为当前用户安装，安装页可选择三个官方插件；选择 GUI 会包含 UI Adapter 的实际文件，即使单独的 UI Adapter 功能未勾选
- MSI 不在安装事务中运行插件或改用户 registry；首次启动通过正常 CLI 导入所选离线载荷。之后的插件启停、授权、移除和源码由 Codlet 管理，MSI repair 不覆盖用户插件
- MSI 维护可追加尚未安装的离线载荷，用户已移除、停用或撤权的插件不会因启动而恢复。取消 MSI 中的载荷选项不删除已经导入用户目录的插件；卸载插件使用 GUI 或 CLI
- MSI 卸载只移除安装器拥有的程序、快捷方式和安装记录，保留插件、配置及数据。当前 MSI 版通过后续 MSI 升级，不使用便携 ZIP 更新器替换 Windows Installer 管理的文件
- 程序支持的客户端构建、真实官方跨版本更新、Core crash 和官方入口实例复用仍按各自的发布前条件验收；本地 Preview 不是公开稳定版

## 验收

```powershell
./scripts/Test-Distribution.ps1 -Distribution C:/output/portable -ArtifactsDirectory C:/output/portable-test
./scripts/Test-MsiDistribution.ps1 -MsiPath C:/output/codlet.msi -ArtifactsDirectory C:/output/msi-test
```

所有输出目录必须新建。MSI 测试发现已安装的 Codlet Preview 会拒绝，避免改变用户已有安装；测试自己的安装使用独立程序和数据目录，完成后正常卸载。完整结果见[本次记录](WINDOWS_PREVIEW_DISTRIBUTION_2026-09-21.md)。旧 M2/M5 文档中的内置 GUI 和开发示例便携包清单属于历史状态。
