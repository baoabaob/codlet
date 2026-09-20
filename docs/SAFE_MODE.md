# 安全模式与本地排障

安全模式是现有启动器的一次性参数，不创建单独的快捷方式，也不改写插件的启用配置。

## 进入与退出

普通便携运行时：先关闭由 Codlet 启动的客户端，然后运行：

```powershell
.\codlet.exe launch --safe-mode
```

现有隔离测试包：先用 `Stop-TestClient.ps1` 正常关闭测试客户端，再运行：

```powershell
.\Start-TestClient.ps1 -SafeMode
```

原有 `Start-TestClient.cmd -SafeMode` 也会传递这个参数。不带参数重新启动即退出安全模式，仍按之前保存的配置加载插件。`--watch` 与 `--safe-mode` 互斥。

本轮仅提供手动触发；单个插件错误或客户端版本提示不会自动切入安全模式。正式启动仍遵守现有客户端冲突检查，不会接管或关闭其他 Codex 实例。隔离测试入口继续只管理自己创建的客户端。

## 行为与恢复

- 跳过所有 Codlet 插件，包括管理 GUI、UI Adapter、Desktop Adapter 和 Host 插件
- 启动不读取 registry 内容、插件清单或源码，不发现 Node，不启动插件更新检查、热重载或 Codlet 自更新
- Core 保留自己的客户端、状态和管理 IPC；`doctor` 与诊断包仍能报告当前会话，状态事件包含 `safe_mode`
- 管理命令仅允许停用、撤销权限以及保留源码的移除；启用、重载、导入、更新、回滚和删除源码均被拒绝
- 显式恢复操作仍检查依赖与保存冲突，使用同一回执，重发旧回执不会重复修改

例如，在另一个终端停用故障插件：

```powershell
.\codlet.exe plugin disable <plugin-id> --json
# 隔离测试包使用自己的配置作用域
.\Test-Plugins.ps1 disable <plugin-id> --json
```

安全模式不会自动修复损坏的 JSON。配置本身无法解析时，客户端仍能启动，但依赖配置的恢复命令会报告错误；先导出诊断包，再关闭该会话并修复配置。仅进入和退出安全模式不会改变插件启用状态、权限、来源文件或偏好。

## 设置中的目录入口

“设置 → 文件与排障”提供安装目录和错误日志按钮，复用官方 UI 组件。Core 只接受 `installation`、`logs` 两种固定选择：安装目录是当前运行的 Codlet 程序所在文件夹，日志目录是当前 registry 同级的 `logs` 文件夹。界面不能通过这个接口传入任意路径或命令。

日志记录 Core 启动、终止错误和插件执行错误。`runtime.jsonl` 接近 1 MiB 后轮转，最多保留当前文件及两个旧文件，单条消息有长度上限。不读取会话内容、环境变量或原始 CDP 消息，也不上传。插件错误原文可能包含本地路径，错误日志不自动加入对外诊断摘要。详见 [诊断包](DIAGNOSTIC_BUNDLES.md)。

## 官方客户端版本说明

客户端更新全部交由官方客户端，Codlet 的版本区只显示 Codlet、当前客户端与 Codlet 适配版本，不提供客户端更新按钮或状态。公开清单不再参与任何判断；[来源审计](OFFICIAL_CLIENT_UPDATES.md)保留此前差异的代码依据。
