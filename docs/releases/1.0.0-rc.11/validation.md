# 1.0.0-rc.11 — Core 更新发布与 Windows 升级

本轮完成完整安装包、兼容在线载荷及更新清单的统一构建，以及安装器升级识别、维护和降级处理。构建来源为 `2675a00a49180a0a0bb66884985665da2df19f67`，沿用已验证的 GUI rc.5 包。发布产物保存在本地，尚未公开发布。

## 热更新验证

当前日常驻留 Core 为 rc.8。它的可执行文件和 Node pin 与在线包中的常驻文件完全一致；当前桥接与 bootstrap 的完整字节也存在于该可执行文件中。此次 Native JS 修复可生成静态兼容载荷，包含 Native source 和 `core-ui-provider`。

| 身份 | SHA-256 |
| --- | --- |
| rc.8 常驻文件集合 | `653a9977d4b4135d2afc0782280f500e76638c425d939afdd77104a8f2a3d264` |
| rc.8 可执行文件 | `ef0c793d69b0861f4fe938928392c9dd2cf1284659780dbb63872ee3bb0102dd` |
| bridge | `e8826b4debeb8bb93e37aa19ac8553edd8918cff1d08da58e49a58bba43922f1` |
| bootstrap | `a75c2a76e44798ccbd1b76bd8384d911b6dd2837bc40e0421d86854f5665c9e6` |

当前 rc.8 仍使用已发布的 schema 1 清单，本地候选未向该会话实际热激活。旧清单继续提供完整包；新版 schema 2 清单按常驻文件集合选择在线包。因此，这个日常安装需要先完成一次完整升级，才能使用新的定向发布选择流程。日常 Core 和 Native 会话保持运行。

生产更新服务、真实前台协调器、Node Host 与认证桥接的集成测试通过：状态迁移、确认接管、失败回滚、丢失回执查询、写入准入恢复和持久化均受覆盖。在线包在状态迁移条件不满足时返回 `core_update_online_only`，保留原实例；MSI 常驻文件替换返回安装器所有权错误。这些是进程与组件集成证据，未建立本轮实际 Electron Native 热激活或交互验收证据。

## 完整安装与升级实测

环境：独立 Windows 11 Enterprise Evaluation 虚拟机，QEMU TCG、4 vCPU、5 GiB。以下为 MSI 会话的单次计时，不能作为日常硬件的性能估计。真实 setup 内嵌 MSI 的提取与 SHA-256 校验另测为 **1.036 秒**。

| 场景 | 结果 | MSI 返回码 | 耗时 |
| --- | --- | --- | --- |
| rc.8 首次安装，基线 | 通过 | 0 | 43.802 秒 |
| rc.8 → rc.10，基线 | 通过 | 0 | 71.601 秒 |
| 取消 rc.10 → rc.11 | rc.10 注册与原程序散列恢复 | 1602 | 47.940 秒 |
| 新文件写入后注入失败 | rc.10 注册与原程序散列恢复 | 1603 | 80.727 秒 |
| rc.10 → rc.11 | 目录、用户范围和选项保留 | 0 | 66.596 秒 |
| rc.11 同版本修复 | 缺失的程序文件恢复，未选功能仍未安装 | 0 | 41.545 秒 |
| rc.11 → rc.8 降级 | 拦截，rc.11 保留 | 1603 | 28.155 秒 |
| 当前用户卸载 | 注册移除，用户数据保留 | 0 | 44.856 秒 |
| 全局安装 | 全局范围、目录和选项正确 | 0 | 34.328 秒 |
| 全局同版本修复 | 注册和选项正确 | 0 | 62.523 秒 |
| 全局卸载 | 注册移除，全局 PATH 恢复 | 0 | 35.092 秒 |

九项最终包用例均保留用户数据哨兵。故障用例通过独立 MST 在 `InstallFiles` 后执行失败动作；原始 MSI 日志确认新文件写入发生在失败前。测试没有修改交付 MSI。另一个独立进程测试使用实际完整更新 ZIP，验证便携安装的替换、失败回滚和未知用户文件保留。

## 升级顺序与复用结论

继续使用 `MajorUpgrade Schedule="afterInstallInitialize"`。rc.8 与 rc.11 有 46 个稳定的共同组件定义、26 个散列相同的文件，共 986,508 字节；39 个载荷文件没有文件版本，包括 Core 可执行文件。相同组件目前仍会随 major upgrade 移除和重装，尚未启用跨版本复用。后移旧产品移除需要先解决变更的未版本化文件被 Windows Installer 保留的情况，并测试目标文件时间戳变化和缺失组件。

基线升级中，`InstallValidate` 区间为 12.198 秒，`InstallFiles` 为 4.426 秒，`RemoveFiles` 为 4.083 秒。区间按相邻 MSI 动作计算，包含嵌套卸载，不是独占 CPU 或纯复制时间。当前约 8.25 MiB 的 setup 沿用完整包交付。托管 Node 缓存继续跨升级保留并复用。[构建、计时和组件规则](../../windows-release-delivery.md)提供操作方法及官方依据。

## 测试与产物

- Rust 更新测试：30 通过；4 个入口默认忽略，其中子进程场景由父测试执行。实际完整 ZIP 的独立父测试另行运行并通过。
- Node 在线包与计时测试：5 通过。
- 发布计划：双清单、定向包、校验和、旧客户端完整包、稳定/预览标记、离线重试及篡改拒绝通过；最终 PrepareDraft/Publish 预检无外部写入。
- 原生安装器：中英文、自动语言回退、实际窗口布局、升级选项、同版本维护、降级和重复注册拦截通过；最终 setup 内嵌载荷校验通过。
- Windows MSI：基线 2 项与最终包 9 项通过。临时安装已卸载，原始日志、计时、注册快照和数据哨兵保留。

产物根目录：`X:/codlet/.codlet-artifacts/core-update-delivery-20261021/windows-final/release/`。

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.11-windows-x64-setup.exe` | 8,651,264 | `3e37c56d37145f7ecd384b08dac1c35ab8e73711b645d4f6e023168400287643` |
| `codlet-online-1.0.0-rc.11-win-x64-653a9977d4b4135d.zip` | 9,643,796 | `e95515de1e04acd2ca5ae0fc6dd92e93714ad0aabd33332e2e04d5b5c36271bd` |
| `codlet-runtime-1.0.0-rc.11-win-x64-portable.zip` | 9,579,828 | `cf89b5854eba27201e85133e0cd9575b8028dd736bca46fc014fb87c4e5170dc` |

同目录保留 schema 1 / schema 2 清单、`release-plan.json` 和 `SHA256SUMS.txt`。产物根目录的上层保存 `installer-final-evidence-summary.json`、`msi-final-evidence/` 原始日志、`msi-component-audit-final.json` 及各层测试报告。结构化摘要也收录在本目录的 [evidence.json](evidence.json)。

Windows setup 尚未签名。此次未生成 macOS 产物；实际 Native 热激活、物理 IME、附件与 workspace 交互的既有验收缺口仍见 [rc.10 验证范围](../1.0.0-rc.10/validation.md)。
