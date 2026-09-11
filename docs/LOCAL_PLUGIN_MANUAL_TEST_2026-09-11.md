# M5a 本地插件管理手测指南

日期：2026-09-11。目标：验证本地文件夹导入、权限确认、启停、重载、撤销和移除。GitHub 下载、社区目录和跨平台运行不在本轮范围内。

**目前状态：实现和自动回归已完成；下列真实界面流程交由你手测，尚未标记通过。** 实机已确认新版导入页能够显示。文件夹选择器曾因隔离资料缺少 Desktop 目录弹出“位置不可用”，实现已改为从现有目录打开；T01 专门复核该修复。

## 准备（约 2 分钟）

1. 使用现有隔离测试客户端。目录是本项目下 `.codlet-artifacts/lab-update-2026-09-10/client`，入口为 `Start-TestClient.cmd`。已经启动时直接使用 **ChatGPT (Dev)** 测试窗口。
2. 本轮只操作 **Local Management Check**，ID 为 `dev.example.local-management-check`。其源文件在测试客户端的 `plugins/local-management-check`。便携发行包中对应 `examples/local-management-check`。
3. 这个样例仅请求 `ui.dom`。启用时右上角显示 **M5 local test — v1**，停用后消失；它不读文件、不联网、不创建 Host 进程。
4. 用系统文本编辑器打开样例的 `renderer.js`，以便后续修改 `v1` / `v2`。目录中的 `codlet.json` 和 `renderer.js` 必须同时存在。
5. 本测试客户端 **没有开启 watch**。保存源文件后，需要点击 Reload 才会更新。

主流程约 10–15 分钟；异常分支可再用 10 分钟。每项做完，在结果栏填写“通过 / 失败 / 未测”。

## 主流程

### T01　选择文件夹与取消

1. 打开菜单栏 **Codlet → Import local → Choose folder**。
2. 应出现 Windows 文件夹选择器，并能正常浏览目录；不应因默认 Desktop 路径不存在弹错。
3. 先取消选择。应返回导入页，并显示取消状态；列表中不新增测试插件。
4. 再次选择 `plugins/local-management-check` 文件夹。应自动开始检查，随后出现预览。
5. 也可把该文件夹的完整路径粘贴到 **Plugin folder**，点击 **Inspect folder**；应得到相同预览。

**预期：** 名称 Local Management Check、ID 和版本正确；Renderer 入口为 `renderer.js`；仅请求 `ui.dom`；自动重载显示关闭。权限、信任、立即启用均未勾选，Import plugin 不可用。

结果：____　备注：____

### T02　逐项授权，默认停用

1. 只勾选 **Grant ui.dom**。Import plugin 仍不可用。
2. 再勾选 **I trust this plugin’s author and this local folder**。
3. 保持 **Enable immediately after importing** 未勾选，点击 **Import plugin**。

**预期：** 返回列表并显示导入完成；只出现一条测试插件，状态为停用，来源为 Local，权限为 `ui.dom`。右上角不出现测试标记。Details 中的目录和已授权限与预览一致。

结果：____　备注：____

### T03　启用与停用

1. 打开测试插件的启用开关。
2. 等待状态更新，观察右上角。
3. 关闭启用开关。

**预期：** 启用后状态为 Active，并出现 `M5 local test — v1`；停用后标记消失。连续开关两轮，不出现重复标记或残留。

结果：____　备注：____

### T04　手动重载

1. 启用测试插件。
2. 在其 `renderer.js` 中把标记文字的 `v1` 改成 `v2`，保存。
3. 保存本身不应立即改变界面。点击该插件的 **Reload**。
4. 应只显示一个 `M5 local test — v2`。把源码改回 `v1`，再 Reload 一次。

**预期：** 两次更新都成功，旧标记被清理，无重复标记，其他插件仍正常。

结果：____　备注：____

### T05　停用状态持久化

1. 停用测试插件。
2. 用测试客户端目录中的 `Stop-TestClient.cmd` 停止，等测试窗口退出。
3. 再运行 `Start-TestClient.cmd`，打开 Codlet。

**预期：** 测试插件仍在列表中，仍为停用，标记没有出现。原有测试登录和任务历史保留。

结果：____　备注：____

### T06　撤销权限与重新授权

1. 启用测试插件，确认标记出现。
2. 打开 **Details → ui.dom 旁的 Revoke**。先 Cancel 一次：权限和标记应保持。
3. 再点击 Revoke，并确认。
4. 标记应消失。Details 中不再列出已授 `ui.dom`。注意：撤权保留“希望启用”的偏好，开关可能仍勾选；此时不能显示为 Active。
5. 尝试 Start / Enable。应提示缺少权限，不应静默补授权。
6. 再次导入同一个目录，重新 Inspect、勾选 `ui.dom` 和信任，再勾选立即启用后导入。

**预期：** 未明确重新授权时无法恢复运行；明确重新授权后恢复 Active 和单个标记。

结果：____　备注：____

### T07　移除保留作者文件

1. 保持测试插件正在运行，打开 **Details → Remove plugin**。
2. 确认文案说明会取消注册、停用，且保留源文件。先 Cancel：状态应保持。
3. 再次移除并确认。
4. 查看文件夹。

**预期：** 列表中测试插件消失，标记消失；`codlet.json`、`renderer.js` 仍存在且内容保持。其他插件未被停用。关闭并重开 Codlet 面板后，测试插件仍不在列表中。

结果：____　备注：____

## 异常分支

### T08　无效目录 / 缺少入口

前提：测试插件已移除。先 Inspect 一个不含 `codlet.json` 的空文件夹，再复制样例目录并将副本的 `renderer.js` 暂时改名。

**预期：** 两种情况都说明具体文件问题，不能进入可提交状态，不新增注册、不启动代码。恢复文件名后重新 Inspect，应恢复正常。

结果：____　备注：____

### T09　预览后源文件变化

前提：测试插件未注册。

1. Inspect 正常目录，勾选权限和信任，但先不点击 Import plugin。
2. 将该目录 `renderer.js` 中的 `v1` 改成 `v2` 并保存。
3. 回到预览点击 Import plugin。

**预期：** 操作失败并提示目录、manifest 或入口在预览后变化，需要重新检查；旧预览不得完成注册。重新 Inspect 后才可导入。测试完把源码改回 `v1`。

结果：____　备注：____

### T10　相同 ID、不同目录

1. 正常导入目录 A，保持停用。
2. 把整个样例目录复制为 B，保留相同插件 ID，然后尝试 Inspect B。

**预期：** 显示已在其他目录注册的冲突，不覆盖 A，不继承 A 的授权。先移除 A，再 Inspect B，可以重新选择权限后导入。测试完移除 B。

结果：____　备注：____

### T11　返回、关闭与重复点击

在导入预览时返回列表或关闭面板；再次打开，应重新检查和授权。打开系统选择器后取消，也不应注册插件。提交管理操作后，按钮应暂时禁用；Refresh 只检查已经提交的操作，不创建重复操作。

**预期：** 未点击最终 Import plugin 不会注册；没有重复列表项、重复标记或迟到的导入。提交后关闭面板不会撤销已经提交的操作，再打开应显示当前真实状态。

结果：____　备注：____

## 失败时怎么记录

请记录用例编号、最后一次操作、预期与实际结果、错误原文，以及截图。特别是“位置不可用”、一直 Updating、移除后仍有标记、权限自动恢复。

在**测试客户端目录**打开终端，可以辅助核对：

```powershell
.\Test-Plugins.cmd list
.\Test-Plugins.cmd permissions dev.example.local-management-check --json
.\Test-Doctor.cmd --json
```

CLI 返回了 `operation_id` 且状态不确定时，用原 ID 查询，不重复提交：

```powershell
.\Test-Plugins.cmd operation "原 operation_id" --json
```

GUI 状态不确定时先点 Refresh；不要直接编辑测试注册表。启动日志位于客户端的 `launch-*.stdout.log` / `launch-*.stderr.log`，测试运行记录在隔离资料目录 `logs/manual-client.json` 的 `report` 字段所指文件。

## 清理和恢复

手测结束后，只移除 `dev.example.local-management-check`，确认标记消失，源码恢复为 `v1`。源码副本可以保留用于下一轮测试。

GUI 操作失败时，在测试客户端目录用同一套 CLI 清理：

```powershell
.\Test-Plugins.cmd disable dev.example.local-management-check --json
.\Test-Plugins.cmd remove dev.example.local-management-check --json
```

如果误停用了管理界面的依赖，依次恢复：

```powershell
.\Test-Plugins.cmd enable codex.ui.adapter --json
.\Test-Plugins.cmd enable codlet-gui --json
```

## 自动测试与手测边界

本轮自动检查覆盖：目录和入口校验、预览变化拒绝、显式授权、注册并发冲突、原回执查询、Host 激活失败后保持停用、连带移除与进程清理、GUI 取消和迟到响应，以及既有管理回归。

前端 138 项；Rust 库 238 项（最后的选择器初始目录用例单独运行），相关集成 63 项；Clippy 已通过。进程生命周期用例按串行执行，避免共享计数器受同一测试进程中其他用例影响。

这些结果不代替 T01–T11 的真实界面验收。尤其是 Windows 文件夹选择器的最终选取、实际显示、焦点和操作习惯，等待本轮手测反馈。

反馈模板：`T01 通过；T02 失败：勾选权限与信任后按钮仍禁用。截图：…；其余未测。`
