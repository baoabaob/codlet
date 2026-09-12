# M5b GitHub 导入、更新与回滚手测

日期：2026-09-12。**以下 Native 界面用例均待手测。** 下载器、托管事务和界面已有自动测试；这不替代实际窗口、网络与打包入口的检查。原本的 [M5a 本地管理用例](LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md) 和 [审批 / M0/M1 补充说明](REMAINING_ACCEPTANCE_MANUAL_2026-09-12.md) 继续保留。

## 准备

1. 使用更新后的隔离测试客户端 `Start-TestClient.cmd`，打开 **ChatGPT (Dev)** 的 Codlet 菜单。不要把日常 Codex 当成本轮测试窗口。
2. 准备一个公开 GitHub 仓库的两个**合规插件 ZIP release 资产**。已有发布包可直接使用；没有时，可用本项目 `examples/github-release-check/v1`、`v2` 和 [发布规范](GITHUB_PLUGIN_DISTRIBUTION.md) 生成后自行上传。**本次没有创建或上传远程仓库**；不要把 GitHub 自动 Source code ZIP 当作构建资产。
3. 本轮提供的样例 ID 为 `dev.example.github-release-check`，两个版本分别为 1.0.0 / 1.1.0，都只需要 `ui.dom`。分别显示 `M5 GitHub test — v1` / `v2`，不读文件、不联网、不启动 Host。客户端中的 `plugins/github-release-check` 只是发布素材，不会自动注册。
4. 记录两个 release URL、资产名和版本。主流程约 10–15 分钟；没有合规公开 release 时先做 G06/G07，其他记录“缺少发布包，未测”，无需反复尝试任意 GitHub ZIP。

## G01　精确选择与默认停用

1. 打开 **Import GitHub**，粘贴仓库或 release URL，点 **Read releases**。
2. 下拉选择具体 release，再选择对应 ZIP。选择之前下载按钮不可用；确认列表中的 tag、资产名与预期相符。
3. 点 **Download and inspect ZIP**，等待预览。期间应有状态提示，管理页不应冻结。
4. 核对仓库、tag、资产、ID、版本、SHA-256、平台/runtime 声明、权限和依赖。未声明兼容性显示未知；不能把作者声明显示成实测通过。
5. 权限、信任、启用均应未勾选。先只选 **Grant ui.dom**，最终导入仍不可用；再勾选来源信任，保持 **Enable after import** 不选，点 **Import plugin**。

**预期：** 列表中只出现一个测试插件，来源为 GitHub、版本 1.0.0、状态停用；没有 v1 标记。Details 显示真实来源、托管目录和权限。下载预览本身没有自动注册或执行代码。

结果：____　仓库 / release：____　备注：____

## G02　启停与来源持久化

1. 启用测试插件，应出现唯一 v1 标记。停用后消失，再启用恢复。
2. 用测试客户端 `Stop-TestClient.cmd` 正常停止，然后 `Start-TestClient.cmd` 启动。
3. 查看 Details 的来源和版本、当前启用状态，以及版本历史。

**预期：** 来源、权限和选择的版本保持，界面不重复。托管目录不会因 watch 自动接受手动修改；需要编辑源码时应使用本地开发目录。

结果：____　备注：____

## G03　显式更新

1. 在测试插件 Details 点 **Check GitHub versions**。单纯读取版本不改变正在运行的 v1。
2. 选择第二个 release/ZIP，点 **Download and inspect ZIP**。
3. 预览应显示当前 1.0.0 → 候选 1.1.0、权限/依赖变化和两份兼容声明。这个样例权限不变，只改标记和说明。
4. 重新勾选 **Grant ui.dom** 与来源信任。启用仍默认不选；为持续运行明确勾选 **Enable after update**，点 **Update plugin**。

**预期：** 一次操作回执完成后只剩 v2 标记，旧标记消失，版本和来源指向第二个资产。其他插件状态保持。刷新不会再创建一次更新。

可选：再次选择旧版本时不勾启用，确认页面已说明会保持停用；完成后应没有标记。这是用户明确选择的停用，不算更新故障。

结果：____　操作 ID：____　备注：____

## G04　选择历史版本回滚

1. Details 的历史中找到 1.0.0，点击对应 **Review rollback**。历史超过一页时，用 **Load more versions** 继续读取。
2. 核对候选版本、来源、权限和兼容声明，重新确认权限、来源信任和 **Enable after rollback**。
3. 点 **Roll back plugin**，等待原操作回执完成。

**预期：** 当前版本回到 1.0.0，只出现一个 v1 标记；1.1.0 历史仍保留。历史分页不重复、不自动选择版本；关闭/切换详情后，迟到结果不应插入其他插件的历史。

结果：____　操作 ID：____　备注：____

## G05　撤销与移除

1. 运行测试插件，在 Details 撤销 `ui.dom`。标记应消失，不能在没有重新授权时恢复 Active。
2. 点击 **Remove plugin**，先 Cancel；状态与文件保持。再次点击并确认。
3. 列表中不再有这个注册项。检查先前记录的托管目录，文件仍存在。

**预期：** 移除只取消登记、停用；托管文件与历史保留，没有删除作者目录或插件数据。若换成另一个仓库的相同 ID，必须重新审核来源与权限，不能继承原有信任。

结果：____　备注：____

## G06　错误、取消、返回与重复操作

分别按可用条件检查，不需要专门准备恶意包：

| 场景 | 预期 |
| --- | --- |
| HTTP、本地地址或非 github.com URL | 拒绝来源，不能下载或注册 |
| 不存在的仓库、只有源码、没有合适 ZIP | 显示具体原因和改用构建包/本地导入的提示 |
| 私有仓库或 API 限流 | 明确错误，不读取本机凭据，不静默重试安装 |
| 下载期间 **Cancel GitHub task** | 取消结果交付；不会注册。网络取消或本地校验完成前可能短暂留有工作/缓存文件 |
| 下载期间返回、改 URL、关闭面板 | 旧结果不进入新预览，不自动安装 |
| 状态查询暂时失败 | **Check task status** 查询同一 job；不重复下载或生成新安装操作 |
| 点过最终提交后响应丢失 | 查询原 operation ID；不自动重放提交。关闭面板不撤销已提交的操作 |

如果作者提供了新增权限的测试版本，额外确认权限增量显示且需要逐项重新授权；不勾选时无法更新。版本本身不兼容、摘要不匹配、预览后改动、替换失败与并发撤权已有自动用例，手测没触发时不伪记为已通过。

结果：____　实际覆盖的场景：____　未测：____

## G07　社区入口

点击 **Browse community plugins**。应打开或显示 `https://github.com/topics/codlet-plugin`，不立即导入、安装或授权任何插件。若当前宿主未打开外部浏览器，可复制该网址到自己的浏览器，并记录宿主表现。

**预期：** 明确这是发现入口；没有声称已有官方市场或所有条目已验证。返回 Codlet 导入某个链接时，仍走 G01 的完整确认流程。

结果：____　备注：____

## 出错时记录与恢复

记录用例编号、构建、仓库/tag/资产名、最后一步、错误原文和 operation ID/job ID。可附截图，但不要贴 GitHub token 或不相关任务内容。在**测试客户端目录**辅助查询：

```powershell
.\Test-Plugins.cmd list
.\Test-Plugins.cmd permissions dev.example.github-release-check --json
.\Test-Plugins.cmd github history dev.example.github-release-check --json
.\Test-Doctor.cmd --json
.\Test-Plugins.cmd operation "原 operation_id" --json
```

清理只操作测试插件：

```powershell
.\Test-Plugins.cmd remove dev.example.github-release-check --json
```

本版没有自动缓存/数据清理按钮，不直接编辑 registry，也不要删除正在使用的托管目录来制造回滚失败。测试结束可保留发布样例和 ZIP，等待后续版本复用。
