# Core 前台配对采集接口

2026-10-13。接口和离线回归已准备；本聊天没有启动或接入实例。当前 26.1007 Owl 的实际能力由唯一启动者在新 owned session 上调用 `probe/begin/end` 确认。过去 backing document hidden 或 `Browser window not found` 的结果不作为当前版本能力的否定结论。

## 文件与接入

将以下两个文件一起复制到已审核 driver 包目录，并计入该包的源码摘要：

- [foreground-collector.cjs](../scripts/native-core/foreground-collector.cjs)：接收已有 `cdp/sessionId`，采集及有界落盘；不 attach、激活、导航、发送输入或退出客户端。
- [foreground-page.cjs](../scripts/native-core/foreground-page.cjs)：被动事件、PerformanceObserver、CSS 点位与阶段标记。只读页面内容/几何，不读草稿或正文，不改变 DOM/CSS、焦点或选择。

Core Host 每代只有一个 CDP subscription。合并现有订阅，不能再开第二个：

```js
const {createCollector, EVENT_METHODS} = require('./foreground-collector.cjs');
const fg = createCollector({
  cdp: context.cdp, sessionId, targetId: spec.targetId,
  sampleId: spec.sampleId, markerKey: spec.markerKey, nonce: spec.nonce,
  outputDirectory: captureDirectory // 调用者新建且验证属于本 sample 的普通目录
});
subscription = await context.cdp.subscribe({
  scope: 'all', methods: [...EVENT_METHODS,
    'Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded']
}, event => {
  fg.onEvent(event); // 接收 root Tracing 事件及本 session 的 Page 事件
  if (event.sessionId !== sessionId) return;
  // 原有 Native 异常过滤逻辑保留在这里。
}, reason => fg.onSubscriptionEnd(reason));
// 在既有 nonce marker 成功安装后调用；初始化会再次核对 marker。
const capabilities = await fg.probe();
```

`probe.json` 记录 Browser 版本、Tracing categories、窗口查询、layout/frame tree 和页面支持的 PerformanceEntry 类型。参数、方法不被接受时保存原错误；接受命令不等于已经观察到对应事件。

每次真实输入前启动一个短 slice：

```js
await fg.begin({label:'zero-a-01', panels:0, pairId:'pair-01',
  dataHash:syntheticDataSha256, maxMs:30000, saveFrames:true,
  windowEvidence:freshWindowGeometry});
// 收到 begin 回执后，由已授权 Computer Use 操作；不得用本工具模拟输入。
// 从既有快照取 c.exportProfile().profile.events，保持原始 timestamp。
await fg.profile(profileEvents);
const capture = await fg.end();
// 下一次换唯一 label、panels:5，其他配对条件相同；可做 0→5→0。
```

每个 slice 最多 30 秒，到时自动结束并写 `capture.json`。如果自动结束已发生，不能把随后导入的 profile 当作这段采集已包含的数据。长的 100 次 warm/API 导航批次可继续测原有 `inputReadyMs/nextRafMs`，另标为程序化 API 阶段；它不是 100 次真实物理输入，也不适合未经分段就塞进 30 秒 trace。rAF 指标仍只叫 rAF。

driver 在 unsubscribe/detach 之前 `await fg.dispose()`；若进入 Core deactivate，则传 `await fg.dispose(cleanup.cdp)`。只结束本 collector 成功启动的 trace/screencast；Tracing.start 因已有录制而被拒绝时，不会结束别人的录制。清理错误须保留为采集错误，不能覆盖消费者自身功能结果。

## 四个阶段及可观测性

| 阶段 | 来源 | 边界 |
| --- | --- | --- |
| 输入 | 捕获的 trusted click/pointer/key 与原始 event.timeStamp | 不保存键值或文本；trusted 不能单独区分物理输入与 CDP 注入，物理来源仍由 CU 操作记录证明。每个 slice 只给一个待关联的语义选择动作。 |
| 消费者选择 | 既有 `selection/start` 的 performance.now timestamp | 不用轮询到达时间；0 面板没有消费者阶段时是 N/A，可单列同契约的 native-selection。 |
| confirmed input | `input.navigate/navigationCommitted`，该位置已经验证严格公开输入回执 | `selection/inputReady` 单列；focus 和 DOM 存在不是确认回执，更不是 paint。0 面板可由负责夹具在严格公开回执处调用 `fg.stage('confirmed-input', timestamp, {inputConfirmed:true, revision})`；不得凭 focus 补填。 |
| 对应结果的可见帧 | 当前 trace 的呈现反馈/关联帧，加真实窗口对应关系与可见内容核对 | `DrawFrame`、swap、任意下一帧或输入后的第一张截图不能直接替代。没有证据时为未观测，不是 0ms，也不是自动性能失败。 |

`fg.profile` 不代理或改写 Native 方法；只导入现有测试 profile 的有限已知阶段，并加入自有 User Timing 标记。开始与结束标记用于检查 trace 微秒时钟和页面毫秒时钟的偏移是否一致。标记只在本 slice 内有效，结束时清理自己的 Performance marks。

Event Timing 以 `durationThreshold:16` 订阅，duration 有约 8ms 粒度；缺少条目不表示没有输入或耗时为零。它对应事件处理后的文档渲染阶段，可能早于异步导航完成，因此不能直接把其结束时间当作 confirmed selection 的最终可见帧。[Event Timing 草案](https://w3c.github.io/event-timing/)

Tracing 使用 `ReturnAsStream`、16MiB buffer、有界 32MiB JSON 输出；记录丢失与读取不完整均单列。类别包括 user timing、timeline、cc/benchmark/viz/input/latencyInfo；不开网络、JS stack sampling 或系统 tracing。具体支持以新实例回应为准。[Tracing 协议定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Tracing.pdl)

Performance metrics 是辅助计数器。Page screencast 最多保存 120 张 JPEG/16MiB，每帧 ack，保留 timestamp/monotonicTimestamp 原字段。这些字段定义为 frame swap 时间，不能自动认作物理显示时间；保存的是该 Target 的输出，还需与 CU 观察到的 HWND 内容对应。[Performance 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Performance.pdl)、[Page 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)

## 帧关联与计算

```text
node scripts/native-core/foreground-analyze.mjs <slice/capture.json>
```

[分析器](../scripts/native-core/foreground-analyze.mjs)计算输入→选择→确认的阶段时间，核对两端 User Timing 时钟偏移，列出呈现候选的 pid/tid/ts/phase/id/args 及信号清单。保留大整数 ID 的原始字符串，避免丢失 flow 身份。它不会凭事件名自动把 `actualVisibleFrameLatencyMs` 填成数值。

主聊天随后按本次真实材料关联：

1. 使用 `probe.json` 的 frame tree、trace 内 Target/frame 元数据和 User Timing 所在 renderer PID 绑定本页面。先排除其他 owned 页面的帧；浏览器级 trace 并非只含当前 Target。
2. 从该真实输入的 EventLatency/latency flow 追踪到提交及 presentation feedback，核对 frame/display trace ID。EventLatency 也存在没有 compositor history 的 termination 路径，只有一个总 duration 不足以证明呈现；若是 B/E 事件须配对同一 track/ID，不能把 begin 当最终时间。[Chromium EventLatency 源码](https://raw.githubusercontent.com/chromium/chromium/main/cc/metrics/event_latency_tracing_recorder.cc)
3. 将具体帧与保存的 Target 图片、CU 的真实 HWND 画面和唯一选择几何/别名对应，确认该帧已经包含目标选择及相应 Native 输入器，而非 loading/旧会话帧。Owl 的逻辑图层到 HWND 的关系必须由本次材料支持；若缺失，继续保留为观测缺口。[Chromium 帧与呈现调试说明](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/speed/debug-janks.md)
4. 只有完成以上关联后，按 `presentationTraceUs / 1000 - clock.offsetMs - trustedClick.time` 计算该输入到所确认帧的延迟，并附具体 trace event/flow 与窗口画面引用。不能一概使用 `ts+dur`：应按该事件的实际 schema 选择反馈时间。单次后续截图仅能证明捕获时画面已出现，不能给出精确呈现时刻。

若本次 trace/API 没有导出所需呈现反馈，结果应记录 `unobservable-final-presentation` 及缺少的具体链环；若观察到了完整对应帧且超过预先约定门槛，才记为性能门槛失败。公开输入合同错误、功能超时、错误会话或未显示预期内容另记为真实功能失败。采集错误、数据丢失、窗口被遮挡、捕获范围不足不得代替这些结论。

## 窗口、CSS 与标题栏

由唯一启动者对新鲜交接 HWND 运行[只读 geometry 工具](../scripts/native-core/foreground-window.ps1)：

```powershell
.\scripts\native-core\foreground-window.ps1 -Evidence <owned-runtime-evidence.json> -CoordinatorState <manual-client.json> -Hwnd <fresh-decimal-hwnd>
```

它用保留的 Desktop 句柄核对 PID、精确创建时间、映像以及 HWND owner；输出 GetWindowRect、DWM extended frame、客户区大小和屏幕 origin、DPI/awareness、visible/minimized/foreground。只调整并恢复采集线程的 DPI awareness。DWM 可见边框与 GetWindowRect 的不可见 resize 边框不同；DPI 还与目标 awareness 有关。[GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)、[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)

`await fg.inspect([{x,y}, ...])` 中坐标必须是 CSS viewport 坐标。结果包含 elementsFromPoint、其祖先、实际 computed app-region、pointer-events、inert、裁剪及候选标题栏矩形。pointer-events:none 的 drag region 可能不出现在命中数组，所以还单独列区域。CSS 声明不是 OS caption hit-test。

不直接用 DPR×CSS＋窗口外框原点换算。分析模块提供 `calibrate(anchors)`：两个在 CSS 与物理屏幕中可对应的不同方向地标拟合 scale/offset，第三地标独立检查误差（默认 3px）；`mapCssPoint` 只接受通过检查的映射。若 CU 截图有 crop/resize，还要把截图点先换成物理屏幕点。窗口移动、resize、zoom、DPI 或 viewport 改变后重新校准。标题栏拖动由已授权 CU 执行，脚本只负责前后几何与候选区域记录。

## 配对与离线验证

`comparePair(zero,five)` 检查 panel 数、pairId、dataHash、Target、CSS viewport、DPR、同一窗口创建身份/DPI/客户区，以及窗口前台可见和段内 viewport/timeOrigin 稳定。调用者还须核对语义动作、初始/目标别名、非 no-op、相同合成数据和视口、缓存预热与执行顺序；这些不能仅凭 hash 相同自动成立。0→5→0 的两个零面板窗口用于检查漂移。保留每段真实 n，不从一个输入或程序化 warm 批次推造物理输入 P95。

`node --test tests/foreground_collector.test.mjs`：11 项离线回归通过，覆盖被动阶段采集、早到帧 ack、边界/foreign-session 过滤、拒绝停止别人的 trace、失败清理重试、nonce 拒绝、严格确认凭据、arming 前输入排除、候选不冒充呈现、三点映射、配对检查及大整数 ID。全部使用模拟 CDP/页面，没有连接客户端。JS/PowerShell 语法检查通过。

主聊天随后回报 geometry 脚本已在其新实例实际成功，取得 DPI 96、awareness 2、前台可见、未最小化、1280×820 与 origin (907,277)，并与页面 viewport/DPR/scale 对照。本聊天未代为查询；这些数值只属于该次捕获，不可作为后续常量。完整 collector 的协议与呈现回应由主聊天在后续唯一 sample 中采集，不改已激活的验收包。

## Host 盘符根兼容修复

后续 sample `consumer-52cc3144-5dc8-49ad-8f9f-e7e156bcbbe8` 的[失败回执](../../codlet-split-workbench/.checks/native-comparison/consumer-52cc3144-5dc8-49ad-8f9f-e7e156bcbbe8/driver/report.json)记录 `lstat 'X:'` 的 EISDIR，发生在 collector 构造的目录校验阶段。主聊天确认尚未进入 probe 或发送 Tracing 命令；该失败不是 Owl 协议不支持的证据。

第一版修复基于斜杠路径 shim 的假设，将同盘父路径 `X:` 还原根分隔符后仍做 lstat。该分支的模拟测试通过，但后续 `consumer-bfaa8980-b296-460d-bd01-9a154fa7ede1` 实测仍报相同错误，**因此这不是已验证的真实原因或完整修复**。随后在真实 Node 24.21.0 上复现了扩展长度卷根 `\\?\X:\` 的元数据失败，详见[后续修复与退出说明](core-foreground-followup-2026-10-13.md)。

新增 `tests/foreground_path_compat.test.mjs` 先在旧源码上复现失败，再验证修复；覆盖 Host 斜杠路径、原生 Windows、POSIX、输出/祖先/根符号链接以及真实根查询错误。与原 11 项 collector 回归合计 **16 项离线检查通过**（Node 24.21.0），没有接入客户端。

第一版冻结文件 `.codlet-artifacts/core-foreground-support-2026-10-13-pathfix/foreground-collector.cjs` 保留作失败修复历史，现已由 namespace/清理修复替代；旧冻结文件和失败 sample 均未改写。
