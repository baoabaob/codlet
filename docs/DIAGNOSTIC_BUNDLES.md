# 本地诊断包

M5c 的首个交付项：通过已有只读 Doctor 和鉴权 Host Inspect 导出故障摘要，无需启动或关闭 Codex，界面损坏时仍能使用。

```powershell
codlet diagnostics --output 'C:\existing-folder\Codlet-diagnostics.zip'
codlet diagnostics --output 'C:\existing-folder\Codlet-diagnostics-2.zip' --json
```

输出必须是现有目录下新的绝对 `.zip` 路径，支持中文和空格。已有文件、目录、链接和同时写入的目标不会被覆盖。配置损坏、Host 未运行或检查失败时仍可导出；退出码 0 表示导出成功，真实诊断结论在回执的 `doctorStatus` 和包内 `result` 中保留。参数错误或导出失败退出 1，错误写到 stderr。

便携包和隔离测试包都提供 `Export-Diagnostics.ps1`。不带参数时在启动器旁创建带时间与随机后缀的 ZIP；可通过 `-OutputPath` 指定文件。测试包额外提供 `Export-Diagnostics.cmd`，并使用匹配的 lab registry、运行时程序和身份检查，不能借此查询其他配置作用域。

## 内容

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | schema、Codlet 版本、导出程序 SHA-256（不可读时 null）、平台、时间、载荷大小与摘要 |
| `doctor-summary.json` | 结构化检查状态、插件 ID/版本、权限和 capability 名、进程 ID、生命周期、样本新鲜度、错误/事件代码 |
| `README.txt` | 内容范围、字段限制与进一步排查方式 |

摘要逐字段选择；不复制 registry、用户文件、插件源码或日志，不包含路径、资源授权路径、环境变量、会话、凭据和自由文本错误。target/session 标识不原样导出，目标用包内一致的 `target-1` 等别名关联。插件 ID、版本和 capability 元数据会保留，分享前仍可直接打开 JSON 检查。导出操作只生成本地文件，不上传。

摘要上限 4 MiB，临时文件完成、同步后才以不覆盖已有文件的方式发布。归档内只有三个固定文件；SHA-256 用于核对完整性，不代替签名。Host 不可用、样本陈旧和未验证的兼容性都按原状态记录，不能从包生成成功推导为插件已运行或发布门禁通过。

## 排查顺序

1. 先导出诊断包，再查看 `doctor-summary.json` 中的失败检查、`runtime.status`、样本新鲜度及插件代次
2. 在本机运行 `codlet doctor` 查看包含路径和完整错误的修复说明；完整原文不会自动加入诊断包
3. 对已识别的故障插件，使用既有 `codlet plugin disable <id>` 恢复；离线操作保留 registry lease 与授权边界
4. 修复后重新导出到新文件，比较失败代码和代次，不覆盖原故障证据

[安全模式与本地错误日志](SAFE_MODE.md)已实现；用户级安装/卸载和签名仍是后续工作。诊断导出不修改启用状态，也不执行自动修复。
