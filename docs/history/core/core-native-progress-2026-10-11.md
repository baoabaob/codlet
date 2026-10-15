# Core Native 成本测量进展

后续更新：用户选择先完成后台测量。release 构建的 72 场景、12 组空闲样本及退出检查已经完成，见 [最终后台报告](core-native-background-2026-10-11.md)。下文保留早期准备与 debug 诊断经过；“等待用户显示窗口”已不再作为唯一的呈现验证路径，backing document 与原生窗口的关系需单独审计。

所属 profile：`core-e674f238-bc43-483c-bdb1-8b90802cbe3e`。当前启动在诊断刷新故障后已稳定，Desktop PID 55832，Target `EC226D1684ECBCF94C3B177C87D8E0EB`。每次测量必须重新运行归属验证，不能复用这些编号。

## 已准备的矩阵

`scripts/native-core` 包含一个仅在所属测试 profile 中显式注册的可卸载夹具：

- 0/1/2/4/5/8 roots × 20/200/2000 固定项 × scheduled/sync × neutral-split/styled，共 72 场景。
- 每 root 重复 pre/button/aside/p 元素，每次更新轮换两处固定文本，分别记录 render 调用、commit 收据、可见文档的两次 rAF、帧间隔和长任务。不把 rAF 当作实际显示器呈现时间。
- SDK 控件 portal 在独立的样式容器内；中性正文必须不位于 SDK 样式祖先之内。
- 真实 Native 控件仅选择已检查的“隐藏/显示侧边栏”按钮，通过 CDP 输入事件，核验 trusted click 和该按钮 aria-expanded 的改变。与受控文本更新并发，计量从页面接到输入到状态改变；不包含 OS 输入投递耗时，不触碰发送、草稿、附件。
- 相同主题通知、增加一个容器时旧容器写入数应为零；模拟 theme 切换后恢复原有 class/data-theme。
- 60 秒 idle 进程组采样覆盖 0/1/2/4/5/8 roots × 两种样式，固定最大 2000 项；调度方式在静态 DOM 稳定后合并为 scheduled。使用保留进程句柄计 CPU，包含 Native、Local Work、后端、Core 和测量 Host，采样器本身不在组内。两端扫描之间出生又退出的进程不能覆盖。

夹具的 3 项自动回归已通过，覆盖两种调度和样式下的真实 commit 计数、portal 连通、资源清理、主题增量与还原，以及拒绝 hidden 帧和未审核按钮。它们只验证夹具，不算 Native 性能结论。

## 当前具体阻塞

所属 Target 持续报告 `document.visibilityState === "hidden"`。`document.hasFocus()` 为 true 也不能替代可见性。已经请求目标 Page 置前并恢复所属窗口，检查仍为 hidden。夹具因此在 setup 前拒绝帧/按钮样本，没有伪造 visibility、没有使用后台 rAF 的数值作为前台体验结论。

已请求用户将 ChatGPT (Dev) 取消最小化、保持可见后再继续。尚未运行上述 72 场景和可见 idle 矩阵。

## 单独的后台诊断样本

这两次样本使用 **debug lab**，窗口 hidden、0 roots，仅作资源诊断，不作为正式矩阵或生产性能验收。原采样器在读取最终进程快照前记录 elapsed，故下面的约 60 秒分母存在末端扫描的小误差；正式采样器已改为读取快照后记录实际 elapsed。

| 条件 | 所属进程数 | 约 60 秒 CPU 秒 | 占单逻辑核 | 占 20 逻辑核机器 |
| --- | ---: | ---: | ---: | ---: |
| 夹具 Host 存在、轮询已停 | 27 | 5.484 | 9.14% | 0.457% |
| 卸载夹具后 | 25 | 5.219 | 8.70% | 0.435% |

前一组 Core debug lab 自身为 2.859 CPU 秒，后一组 2.406；Native ChatGPT 进程为 2.547 / 2.750。两个单次样本不足以推断夹具或优化的 CPU 收益；正式成本比较还需 release 构建与重复采样。Native 进程 private bytes 约 2.40–2.42 GB；各进程工作集求和会重复计算共享页，不能作为独占内存。

停止夹具时 Core 操作回执 applied、无 target failure；Host PID 21536 记录正常 exited，相关 Node 与 conhost 从进程组中消失，受控 DOM/容器/observer/media listener 均为 0。临时注册已移除，源码及原始采样文件保留在该 run 目录。Native 客户端继续保留运行，认证及初始化无需重复。

继续前先重新核验 live 归属、为 release lab 更新精确 hash 并按正常关闭/重开流程切换，再将 `scripts/native-core/{host.cjs,renderer.js}` 与本次 target settings 复制到所属 benchmark package，显式注册到该 profile。先执行 `node scripts/native-core/run-matrix.mjs <run> smoke`，通过后分别运行 `active` 和 `idle`。生成报告只包含合成 fixture 统计，不保留原生 DOM 文本。
