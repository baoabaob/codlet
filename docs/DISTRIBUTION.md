# Windows x64 便携分发

分发目录把已经构建的 `codlet.exe`、固定 Node、统一 JS 插件示例与开发资料放在一起。
打包不运行 Codex、Node、插件或依赖安装脚本，不注册插件，也不修改 PATH 或用户配置。
本脚本当前只产出 Windows x64 包，不进行签名或公开发布。

## 从源码目录打包

先使用正常构建流程得到本轮 `codlet.exe`，然后运行：

```powershell
.\scripts\Build-Distribution.ps1 `
  -CodletExecutable 'C:\build output\release\codlet.exe' `
  -NodeDirectory 'C:\build output\release\runtime\node-v24.21.0-win-x64' `
  -OutputDirectory '.\.codlet-artifacts\distributions\codlet-dev-win-x64' `
  -Zip
```

`-NodeDirectory` 指向包含 `node.exe` 和 `LICENSE` 的现有目录。两份文件分别按
[`runtime/node-runtime.json`](../runtime/node-runtime.json) 的 SHA256 校验。脚本不接受系统
PATH 上的 Node，不只检查 LICENSE 是否存在。输入 `codlet.exe` 必须具有 Windows x64 PE
标头，但其内容与来源仍由调用方负责；打包不会通过执行它来推断版本或可信性。

省略 `-NodeDirectory` 时复用 `Install-JsRuntime.ps1`，下载固定摘要的官方归档并仅提取
Node 与 LICENSE；可用 `-NodeArchivePath` 指定同一固定摘要的离线归档。这两个参数互斥。
分发版本取源码的 Cargo package version；在已有便携包内重新打包时取旧分发 manifest 的
version。`-SourceCommit <commit>` 可选，记录调用方提供的来源标识；省略就写入 null，
不会把当前 checkout 自动当成输入二进制的构建来源。

默认输出为源码目录下 ignored 的
`.codlet-artifacts/distributions/codlet-<version>-win-x64`，`-Zip` 在旁边生成同名 ZIP。
路径支持空格和中文。已有目录或 ZIP 一律拒绝，原有内容不会被覆盖或递归删除；重做时选择
一个新的输出目录。脚本在同一父目录的专用临时 stage 中完成检查，再原子移动目录。
如果最后 ZIP 移动失败，已经完整发布的目录仍可使用和核验。

## 目录与内容清单

```text
codlet.exe
distribution-manifest.json
README.md
runtime/node-runtime.json
runtime/node-v24.21.0-win-x64/node.exe
runtime/node-v24.21.0-win-x64/LICENSE
examples/raw-host/...
examples/cleanup-host/...
examples/local-host-renderer-capability/...
types/host.d.ts
docs/...
scripts/Build-Distribution.ps1
scripts/Install-JsRuntime.ps1
```

构建脚本只复制明确白名单中的示例入口、manifest、README、类型和契约说明；不递归复制
源码树，不携带用户 registry、settings、缓存、历史二进制或测试日志。说明文档之间与示例
中的相对链接保持原目录关系，打包时验证其目标确实存在。随包的历史契约说明用于解释当前
接口的演进，不是已验收的运行时产物。

`distribution-manifest.json` 使用 schema 1，包含分发 version、platform、可选来源 commit、
Node pin，以及每份载荷的相对路径、字节数和 SHA256。manifest 自身不嵌入自己的摘要，
其 SHA256 与 ZIP SHA256 由命令结果返回。清单是内容核验资料，不是签名或信任证明。

ZIP 条目直接对应上述相对路径，没有额外顶层目录。请解压到独立空目录，并保持 `codlet.exe`
与 `runtime/` 一起移动。ZIP 使用固定时间戳和排序；在相同 PowerShell/.NET 环境、相同输入
文件与来源参数下，可得到相同的清单和 ZIP。源码资料改变后，其摘要也会改变。

## 使用与重新打包

从解压目录开始，先做不授信的候选检查：

```powershell
.\codlet.exe plugin add .\examples\cleanup-host
```

没有 `--trust` 与 grants 时，这个命令只显示候选信息并退出，不执行或注册插件。完整注册、
watch、Inspect/doctor 与 disable 步骤见 [开发闭环指南](HOST_DEVELOPMENT_2026-09-10.md)。
生命周期边界见 [cleanup](HOST_CLEANUP_2026-09-10.md)、[watch](HOST_WATCH_2026-09-10.md)
和 [运行观察](HOST_INSPECTION_2026-09-10.md)。

同时运行 Host 与 renderer 的可用入口见
[组合示例](../examples/local-host-renderer-capability/README.md)与
[组合包契约](COMBINED_PACKAGES_2026-09-10.md)。分发同时包含 Host capability 契约及执行
两侧真实 JavaScript 的验收说明；测试源码和 VM peer 留在源码仓库。

便携包内保留了[构建脚本](../scripts/Build-Distribution.ps1)，可把当前二进制与固定 runtime
重新复制到另一个新目录。它不编译源码；新版本的正式包应由该版本实际构建产物生成。

## 包装专项验收

源码仓库的 `scripts/Test-Distribution.ps1` 接收同样的现成二进制与 Node 目录，在专用 ignored
目录检查正常打包、空格/中文路径、重复输出拒绝、错误 Node/LICENSE 拒绝、所有载荷摘要、
ZIP 条目与重复打包一致性。候选 CLI smoke 使用独立的子进程 `LOCALAPPDATA`，不授信，
并确认没有创建配置目录；验收保留结果供复核，不删除用户目录。

包装脚本验收可以使用旧开发二进制证明文件布局和流程正确。最终交付仍须在本轮正式构建完成
后，用新二进制重新生成便携包，不能据旧二进制包装成功宣称新功能已经包含其中。

早先 Host 开发包的包装逻辑验收已通过上述五类检查，包含 23 份载荷及 manifest。两次从相同
便携输入生成的 manifest 和 ZIP 摘要分别完全一致；错误摘要与重复目标均未发布或覆盖内容。
记录位于源码 ignored 目录的
`.codlet-artifacts/distribution-packaging-2026-09-10-r2/packaging-acceptance.json`。
该次输入是 `104c432` 的旧开发二进制，仅用于包装流程验收。

组合入口交付时，使用本轮新 release 二进制再次通过五类检查，载荷增至 30 份及 manifest，
候选检查覆盖 raw-host、cleanup-host 与双入口示例。记录位于
`.codlet-artifacts/combined-distribution-2026-09-10/packaging-acceptance.json`；
正式包另记录源码 commit 并核验最终逐文件及 ZIP 内容摘要。
