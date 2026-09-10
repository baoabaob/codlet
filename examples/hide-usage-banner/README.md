# Hide usage banner

隐藏截图中的 “You’re out of Codex and Work usage” 提示卡片。插件只需要 `ui.dom`，没有 Host 入口或官方 adapter 依赖，可在 Codlet 管理面板单独启停。

```powershell
codlet plugin add .\examples\hide-usage-banner --trust --grant ui.dom
codlet plugin enable dev.local.hide-usage-banner
```

如果当前没有 Codlet 会话，登记后通过 `codlet launch` 启动。停用并恢复提示：

```powershell
codlet plugin disable dev.local.hide-usage-banner
```

首版针对 Codex Desktop `26.903.8094.0` 中的英文卡片结构：独立 `aside`、对应额度标题，以及 Add Credits 或 Reset usage 按钮。识别后增加本插件的标记和 CSS 隐藏规则；新增卡片、内容更新和重新挂载会重新检查。卡片被复用为其他提示时恢复显示。停用会断开 observer、取消排队检查、移除样式和自己的标记。

这是显示层插件，额度状态、服务端限制和使用量统计保持原有语义。其他语言或后续版本的 DOM 变化需要重新适配；未识别的卡片会保持显示。当前验证使用依据安装包源码构造的真实浏览器 DOM 夹具；未在用户的日常 Codex 会话中注入。

浏览器验证已通过 6 项：只隐藏目标卡片、重建后继续隐藏、复用为其他提示时恢复、改回额度提示时重新隐藏、停用清理，以及更新排队期间停用后不再复活。Codlet 候选检查也已通过且未创建注册配置。
