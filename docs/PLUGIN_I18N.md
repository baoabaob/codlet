# 插件语言支持

Renderer 的 `context.i18n` 跟随客户端实际解析后的语言。中文语言标记统一为 `zh`，其他语言统一为 `en`。运行时观察客户端维护的 `document.documentElement.lang`，切换语言无需重载插件。

```js
const messages = {
  zh: { greeting: '你好，{name}' },
  en: { greeting: 'Hello, {name}' }
};
const render = () => { label.textContent = context.i18n.t(messages, 'greeting', { name: 'Codlet' }); };
context.i18n.onChange(render);
render();
```

`t` 返回纯文本；中文缺少某个键时回退到英文，英文也缺少时返回键名。不要把翻译直接注入 HTML。`onChange` 返回取消订阅函数，订阅也会在当前插件代次停用时自动释放。

目录插件的 `codlet.json` 可附带名称和描述翻译：

```json
{
  "schema": 1,
  "id": "example.greeting",
  "name": "Greeting",
  "description": "Show a greeting.",
  "i18n": {
    "zh": { "name": "问候", "description": "显示问候语。" },
    "en": { "name": "Greeting", "description": "Show a greeting." }
  },
  "version": "1.0.0",
  "renderer": { "entry": "renderer.js", "world": "isolated" },
  "permissions": ["ui.dom"]
}
```

旧 manifest 无需修改。`id`、权限和 capability 标识保持稳定；名称与描述只影响展示和搜索。名称限 256 UTF-8 字节，描述限 2048 字节，不接受控制字符。Host-only 插件也可声明翻译后的元数据，管理界面负责按客户端语言展示；Host 进程本身不持有界面语言状态。

Codlet GUI、Codex UI Adapter、Codex Desktop Adapter 与额度提示隐藏插件已包含中英文名称和描述；测试示例维持原文。
