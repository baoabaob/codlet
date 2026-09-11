# Local Management Check

用于 M5 本地导入、启停、重载、撤权和移除的手测样例。

- ID：`dev.example.local-management-check`。
- 仅请求 `ui.dom`，不启动 Host 进程，不访问网络或文件。
- 启用后在窗口右上角显示 `M5 local test — v1`；停用、撤权和移除后标记消失。
- 将 `renderer.js` 中的 `v1` 改成 `v2` 后点击 Reload，可验证重载。

测试前复制整个目录，修改副本。测试客户端附带的副本在 `plugins/local-management-check`。
步骤见发行包的 `docs/LOCAL_PLUGIN_MANUAL_TEST_2026-09-11.md`，或测试客户端的 `M5-ManualTest.md`。
