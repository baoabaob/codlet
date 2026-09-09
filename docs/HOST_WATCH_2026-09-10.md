# Host JS 文件热重载

日期：2026-09-10。`codlet launch --watch` 现在可以观察已经加载的 host JS，通过现有
host 生命周期事务完成稳定检测、换代、补偿与诊断。此功能继续使用统一 JS/TS 目录包，
不新增插件格式或执行入口。

```powershell
codlet launch --watch
# 在另一个终端使用同一个 codlet.exe：
codlet plugin add "C:\my-plugins\raw-host" --trust --grant host.process --grant cdp.raw
codlet plugin enable example.raw-host
# 编辑并保存 codlet.json 或其 host.entry 声明的构建后 JS。
codlet plugin operation <watch 日志中的 operation-id> --json
```

普通 `codlet launch` 不创建 watcher。上例使用仓库 raw-host 的插件 ID。初始没有任何 host
的会话也可在线 enable 后开始观察；注册或刷新列表本身不读取并执行新插件。

## 观察范围和稳定检测

只观察当前执行器已经载入的本地源码快照，并核对其当前注册仍存在且 enabled。初次载入
失败但已记录源码、仍 enabled 的 host 也可在修复入口后重试；未知新注册不会自动进入观察。
host 正在 Starting/Stopping 或有一项 host 生命周期 pending 时，不启动第二项 watch 换代。

每 250 ms 最多采样四个源，host 和 renderer 共用这一上限并按轮转顺序推进。候选必须有
两次相同观察，且从内容变化起至少安静 250 ms。renderer 的 provider/consumer 继续按
整组稳定条件合并；host 目前没有跨执行器 capability 声明，按独立插件换代。

每个源只包含 `codlet.json` 与同一目录包内当前声明的 JS 主入口。仅改变 JSON 排版不触发
换代；在原 root 与授信下，manifest 将 entry 改为另一个合法 JS 文件可随稳定观察生效。
旧入口在换代后退出观察。资源、`require` 的模块、依赖目录、TS 源码和构建命令不属于本版
watch 范围；需要自行构建主入口，或在其他文件改变后明确执行 CLI reload。

manifest/source 使用已有有界受检读取器（128 KiB / 1 MiB），registry 保持 1 MiB 上限。
写入锁冲突、缺失文件、非法 JSON/UTF-8 会在现有源验证中拒绝，保持旧进程与代数。
不同坏字节有不同指纹；同一失败候选只产出一次请求/结果，修复后可以重新稳定选取。

## 授信与排队执行

host watcher 固定初次载入或明确 CLI enable/reload 时的 root 和完整 grants 记录。
registration 被删除、路径变化、停用或 grants 变化时，先暂停源文件读取，再发布有界且
去重的诊断。恢复原记录可以恢复观察；要选择新目录或新授权，需明确调用 CLI enable/reload。
自动 watch 和补偿不把新的 registration/grants 当成已选择的观察源。

固定的是已经加载的 canonical root。即使 registry 路径字符串不变，该目录消失会产生
`watch_root_unavailable`；替换为指向其他目录的 junction 会产生 `watch_root_changed`。
这两种情况在读取 manifest/entry 前进入去重的 Paused 状态，不反复创建 reload receipt。
排队执行前再次核对 canonical root，候选装载后也核对其 `LoadedHost.root`。CLI 明确选择
junction 根目录的原有装载能力仍然保留；watch 不自动重新解释先前选定的 canonical 目录。

观察后执行前还可能发生变化。内部选择保存 root、完整 grants、generation 和稳定源码
指纹；执行时与实际 owner、当前 registry、最终载入的源码快照逐一核验。若 CLI 已换代、
当前授权改变，或载入的内容已是另一份未稳定保存，旧 watch 选择在退休旧代前被拒绝。
host/renderer 类型切换继续被拒绝，不借 watcher 执行跨执行器迁移。

这里区分“未尝试源”和“源尝试失败”：

- 未提交，或被 owner/代数/授信/偏好守卫提前拒绝，以及稳定指纹发现另一份内容，均标记为
  内部 `not_attempted`。只释放对应选择的旧签名，并要求两次新的稳定观察。因而先选中 F1、排队
  时发现 F2、随后恢复 F1，不会把从未执行的 F1 永久吞掉。
- 文件验证、初始化或补偿已经尝试过的候选保留失败签名。初始化失败仍走现有旧快照、新
  generation、当前授信补偿；单纯恢复产生的新代数不会触发同一坏版本的循环重启。

## 回执、前台与诊断

已有 CLI receipt 优先于本轮新 watch 观察。host watch 用现有 broker prepare、一次
submit、只读 result；内部守卫不进入公开控制 DTO，也不能通过 IPC 传代码、路径或 grants。
CLI 在观察期间先入队时仍先执行，之后的旧 watch receipt 根据其原 generation 决定是否可用。

前台一次只推进一项生命周期事务。host 的初始化/清理在独立 owner 中推进，等待期间继续
renderer 事件与其他 host CDP；后续 CLI 留在原有有界队列中，不并行操作另一代。accepted
receipt 不因客户端等待超时被重提，watch 的 operation-id 也可以用普通 CLI operation 查询。

watcher 最多缓存 32 条去重诊断；host 协调器最多缓存 32 个 watch 完成结果，正常前台逐轮
取走打印。日志区分 requested、completed、applied/rolled_back/degraded 和前置拒绝错误。
实际 host 状态仍由执行器发布，不假造 renderer target。

热重载管理受管进程、请求、订阅和代数。插件的 `deactivate` 仍须按当前有限清理契约收尾，
这不构成安全沙箱，也不承诺撤回插件造成的任意页面、文件或网络副作用。

## 验证

`tests/host_watch.rs` 使用真实固定 Node、假 CDP 对端和受控扫描时钟，覆盖在线加入观察、
保存合并、entry 变更、坏/缺失/写入锁定源、初始化补偿不循环、完整授信与路径固定、稳定
观察后的文件变化与 F1 恢复、CLI 队列优先、pending 时其他 host RPC、初始失败源修复。
共享 watcher 单项另外检查 host/renderer 合计四源的扫描上限和轮转公平性。

本包定向通过 24 项：host watch 8 个端到端场景、相关 HostControl 7 项、共享 watcher
状态机 8 项（含 mixed host/renderer 扫描上限）、CLI 优先 1 项。F1 → F2 守卫拒绝 →
恢复 F1 的活性回归在这一批通过；实际坏版本补偿后也验证了不重复启动。

随后补充真实 Windows root 边界单项并通过：先让已加载 host 失败并确认退休，再在已核验
的临时目录内移走原 root、创建 junction；缺失/重定向均暂停且诊断一次，queued receipt
不读取锁定的替代 manifest、不执行替代目录，移除 junction 并恢复原目录后可稳定恢复到
下一代。第一次仅需修正 PowerShell 夹具对 `\\?\` 前缀的处理，生产守卫未放宽。

这次修改只复核了 5 个相关单项，均通过：稳定选择后字节变化、完整 grants/root 固定、
mixed 四源扫描、旧 renderer 的写入/删除/非法 JSON 指纹、CLI 显式 junction 根目录装载。
没有重跑前述 24 项整批。真实 cleanup-host 串起 watch、清理、Inspect/doctor 与补偿的
组合结果见 [开发与组合验收](HOST_DEVELOPMENT_2026-09-10.md)。

未启动真实 Codex，未修改用户 registry，未重复全量 M0/M1 或其他工作包已经通过的测试。
