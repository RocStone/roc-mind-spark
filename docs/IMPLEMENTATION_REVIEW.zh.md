# 实现评估与性能改进

评估日期：2026-09-08。需求依据是 [功能需求与验收基线](REQUIREMENTS.zh.md)，审查起点是提交 `84bf2fa`。本文记录本轮代码改造、自动化检查和真实 macOS 应用验收；代码行号会随重构变化，因此使用文件与函数名定位。

## 结论与范围

本轮改造已经覆盖 Markdown 选区、Markdown 与导图同步、自动保存与切图顺序、历史请求隔离、原生服务生命周期和窗口查询。Swift 外壳、WKWebView 画布与本机 SQLite 服务仍按原有职责协作，未把未启用的托管功能扩展成本机依赖。初次改造的合成文本基准只验证了页面选区计算；用户随后在实际导图中确认 Markdown 和节点选字仍有明显延迟。对真实鼠标操作的追加诊断将问题定位到原生事件进入网页之前的积压，不能用此前的回调耗时下降宣称实际拖动已经流畅。

验证结果分为两层：`make test` 的 Web 与 Swift 测试通过，`scripts/app-e2e.mjs` 也用完整生产网页、本地 Node 服务、隔离 SQLite 数据库和真实 WKWebView 完成 21 项检查。正式应用的原生退出在重新安装后的复测已经通过：早期采样发现一个 AppKit nested wait 与 MainActor 保存任务互相等待的问题，代码改为取消当前退出请求、异步保存完成后再次请求退出；修复后的安装与退出检查通过，同时仍不把异常终止或未保存草稿在所有强制终止场景下的恢复写成保证。

## 已完成的实现

| 范围 | 实现与因果关系 | 验收含义 |
| --- | --- | --- |
| Markdown 选区（MD-02） | `web/public/markdown-selection.js` 在一次拖动开始时建立文本节点索引，命中与绘制使用浏览器的 `caretRangeFromPoint()`、`Range.getClientRects()` 和真实 DOM 排版；每个屏幕帧至多更新一次可见高亮。`mouseup`、失焦、页面隐藏和编辑开始都会取消捕获监听器及待处理帧。 | 中英文、粗体、长文档和换行共用 WKWebView 的实际字形位置；结束拖动后不继续保留手势监听器。 |
| Markdown 与导图同步（MD-01） | Markdown 会话保存完整文本，按源文本行保留节点身份和非文本字段；折叠只影响编辑器可见子集，解析和预览仍使用完整文本。退出 Markdown、换图和隐藏窗口前会处理待同步编辑。 | 编辑 Markdown 不会因为重新解析而让交叉连线失效，也不会把折叠内容静默删除；切图前的文字有明确写回路径。 |
| 保存与删除顺序（MAP-02） | `web/public/map-save-queue.js` 为每张导图维护唯一进行中的保存请求，保存使用不可变快照；新修订号替代尚未发送的旧快照，删除会增加 generation 并使迟到回调失效。失败快照留在队列中并按原导图身份重试，读取错误传播到界面而不是伪装成空列表。 | 旧保存响应不会覆盖新编辑，删除后迟到的 PUT 不会重新创建导图；保存失败时页面仍明确显示未保存状态。 |
| 切图、历史与只读状态（MAP-01、MD-01） | `loadMap()` 在提交新地图前递增 `_mapLoadGeneration`、处理旧图待保存内容，并只接受当前代次的读取结果。历史预览同时检查 `_historyRequestGeneration` 和地图代次；预览设置 `READONLY`，取消时恢复原图和原只读状态。本轮修复的 Markdown 编辑入口会检查 `READONLY`。 | A 图的慢响应不能覆盖后来选择的 B 图；历史请求、切图和取消预览不会把旧结果写入当前地图；只读预览不会修改模型或发起保存。 |
| 撤销与重做（EDIT-03、MAP-02） | `pushHistory()` 记录完整 `mapHistorySnapshot()` JSON，最多保留 60 个快照；`undo()`、`redo()` 恢复完整模型并安排保存，Markdown 会话结束时把最终文本作为模型状态纳入快照。 | 节点关系、连线、样式、布局和支持的附加字段随同一份完整快照恢复，撤销结果也进入保存队列。 |
| 原生服务启动、停止与重试（APP-03） | `ServerSupervisor.ensureRunning()` 将 Node 查找、端口查询和健康探测放入异步或 utility 工作；持有的子进程通过串行停止队列回收。服务在 ready 前必须同时满足健康响应、产品标识、启动 token 和 `Process.isRunning`，启动成功前发现子进程退出会失败而不会误报 ready。 | 端口上的外部进程不会被误杀；服务没有真正运行时不会把 WKWebView 标记为可用。 |
| 服务 ready 后异常退出（APP-03） | `ServerSupervisor` 只监视自己启动的子进程；异常退出通过 `CanvasBootCoordinator.markServiceUnavailable()` 进入可重试状态。`OverlayController` 保留原有 WKWebView 和页面内存，Retry 重新启动服务后调用 `rmsRetryPendingSaves()`，继续处理窗口中的编辑。 | 服务重启不会丢掉 WebView 中尚未保存的草稿，也不会把一次旧启动任务误当成当前成功状态。 |
| HUD 查询与窗口状态（APP-01） | `OverlayController` 将 `CGWindowList` 与 `NSRunningApplication` 查询放到 utility 队列，用 `LauncherHUDWatchState` 保证同一时刻只有一个探测，并在回主线程时检查显示代次。 | 周期性 HUD 查询不阻塞原生主线程；隐藏再显示时，旧查询结果不能改变新的窗口状态。 |
| 正常退出与安装停止（APP-01、MAP-02） | `OverlayController.flushBeforeQuit()` 通过 `callAsyncJavaScript` 等待页面保存，JavaScript Promise 最多等待 5 秒；失败或超时返回错误，`AppDelegate` 取消本次退出、保留窗口和草稿并显示提示。早期正式退出采样发现 `terminateLater` 会进入 AppKit nested wait，使 MainActor 保存任务无法恢复；现行实现返回 `terminateCancel`，异步保存成功后设置 `readyToTerminate` 并再次请求退出。`scripts/install-app.sh` 只向精确匹配的已安装应用发送 SIGTERM，最多等待 15 秒；应用仍在运行时中止安装，不用安装脚本强杀来绕过保存保护。应用内部的已持有 Node 子进程才由 `HeldProcessStop` 按 5 秒优雅停止和 1 秒记录 PID 强制升级策略处理。 | 正常保存失败不会静默退出；安装更新不会用强制结束应用来跳过未保存内容，也不会按端口误杀外部 Node。修复后的安装、退出和端口释放检查通过。 |

## 验证方法与结果

### 实际导图的连续拖选

正式安装应用在用户原有的“在做的事情”导图中，通过 `--selection-trace` 记录原生鼠标事件的时间和坐标、页面收到事件的时间，以及页面选区回调和排版查询的耗时。用户亲自连续拖动，并录制了实际屏幕。采集没有替换导图，也没有生成鼠标轨迹；诊断日志不保存文本或剪贴板内容。

视频对应的两次拖动结果如下。页面事件延迟是 JavaScript 处理时刻与事件原始时间戳之差；它表示输入等待时间，不等同于屏幕显示延迟。

| 真实操作 | 系统事件到达 App 的 P95 | 页面事件延迟：平均 / P95 / 最大 | 页面选区回调最大耗时 |
| --- | ---: | ---: | ---: |
| Markdown，日志手势 20 | 0.66 ms | 733 / 1357 / 1426 ms | 3 ms |
| 节点文字，日志手势 23 | 0.85 ms | 231 / 368 / 377 ms | 使用 WebKit 原生选区，无自定义 rAF 回调 |

按鼠标坐标和顺序匹配原生与页面记录后，Markdown 的 App 到页面平均等待为约 730 ms，与事件时间戳的结论一致。真实鼠标会产生间隔约 1 ms 的密集拖动事件，而页面接收速度跟不上；两种编辑器都积压，Markdown 几何查询最大仅 1 ms。因此本次修复放在 `OverlayPanel.sendEvent`：首个拖动位置立即传递，后续每秒最多传递 120 次最新位置；鼠标松开和其他输入到来前先送达最后的待处理位置。隐藏或失去键盘焦点时取消待发送位置，避免定时器在窗口移走后继续传递旧事件。

该修复已安装，实际连续拖动的复测结果待用户操作后补齐。编译与原有 Swift 28 项检查通过；这些检查不能代替真实拖动验收。

重复采集使用正式应用和原有数据：

```bash
bash scripts/start-live-selection-trace.sh /tmp/rms-live-selection
# 在正式应用中实际拖选 Markdown 和节点文字后：
node scripts/analyze-live-selection-trace.mjs /tmp/rms-live-selection/input.jsonl
```

采集启动参数还会保持诊断窗口可见，方便切换录屏工具；正常启动不安装采集钩子，也不改变窗口自动隐藏行为。退出诊断进程并正常打开应用即可恢复正常启动方式。

### 其他功能检查与此前的合成文本基准

`make test` 通过 Web 688 项和 Swift 28 项检查。`node scripts/app-e2e.mjs` 使用完整生产网页、本地 Node 服务、隔离 SQLite 数据库和真实 WKWebView，通过 21 项检查，覆盖启动、Markdown 关闭写回、字段与连线保留、选区、只读编辑、撤销持久化、切图与历史请求竞态、保存失败与重试。

正式应用的退出复测使用安装脚本中的精确应用匹配和端口检查：`stop_exact_installed_app` 与 `wait_port_idle 3034` 在 0.19 秒内返回成功，应用及其 Node 端口均退出；重新打开后地图正常读取。随后向已核对父进程为该应用的 Node 子进程发送 SIGTERM，页面显示服务停止与 Retry，点击 Retry 后 Node 3034 恢复。这个结果证明了正常退出和服务异常重试路径；它不覆盖操作系统强制终止时未保存草稿的恢复保证。

Markdown 选区的生产基准由 `node scripts/md-production-eval.mjs --overlay --baseline=84bf2fa` 运行，输出已复制到 [docs/validation/markdown-selection-2026-09-08.json](validation/markdown-selection-2026-09-08.json)。该 artifact 的四个 case 使用测试合成的 400 或 4000 行文本，文本包含英文粗体和中文粗体；它不包含用户导图数据。测试通过现有 `scripts/md-select-eval.swift` 向 WKWebView 发送真实 NSEvent，并在页面内读取生产选区结果。

| Case | current 同步 JS 时间（事件 + rAF） | `84bf2fa` baseline 同步 JS 时间 | current 帧数 / 鼠标移动数 | current 选区与几何 |
| --- | ---: | ---: | ---: | --- |
| 400 nowrap | 16 ms（9 + 7） | 35 ms | 9 / 40 | `932..2446`，1514 字符；`exactHit=true`，偏移 0，距离 1 px |
| 400 wrap | 13 ms（5 + 8） | 18 ms | 14 / 39 | `347..820`，473 字符；`exactHit=true`，偏移 0，距离 1 px |
| 4000 nowrap | 38 ms（32 + 6） | 105 ms | 12 / 40 | `932..2446`，1514 字符；`exactHit=true`，偏移 0，距离 1 px |
| 4000 wrap | 45 ms（36 + 9） | 85 ms | 12 / 38 | `347..820`，473 字符；`exactHit=true`，偏移 0，距离 1 px |

四个 current case 都确认使用 `markdown-selection.js`、`contentEditable` 编辑器和真实浏览器排版；400 行和 4000 行分别生成 798 和 7998 个粗体高亮片段，拖动结束后 `listenersReleased=true`。这些 CPU 数值是页面同步鼠标处理器与 rAF 回调使用 `performance.now()` 得到的单轮观察值，只表示浏览器回调时间，不能等同于整个进程 CPU 占用、屏幕端到端延迟或用户感知帧率，尚不足以给出统计上稳定的性能结论。

固定驱动路径从编辑器下方向上方反向拖选。旧版 `mdSetSel()` 会先把选区边界排序，再把 focus 留在文档末端；因此四个 baseline 都出现 `exactHit=false`、距离 `419.223 px`，这个距离主要说明旧实现丢失了反向拖选的 endpoint 方向，不能直接当作拖动高亮延迟。current 的 focus offset 与浏览器命中 offset 一致，说明生产选区提交保留了反向拖选方向。

## 保留的边界

- **整图解析、布局与历史成本。** `render()` 仍会重建可见节点，Markdown 写回仍会触发整图解析和必要的布局；`pushHistory()` 仍保留最多 60 份完整 JSON 快照。本轮验证只证明拖选路径不再随每次鼠标移动扫描全文，不能据此承诺任意规模导图的整体解析和布局成本已经解决。
- **Markdown 的富文本往返范围。** Markdown 不是任意富文本的无损容器。笔记中的复杂 HTML、原始块、元数据组合和跨格式导出仍需更完整的往返样本；节点身份保持不能单独证明所有富文本都无损。
- **强制终止与异常退出。** 操作系统强制终止、崩溃或电源中断时，JavaScript Promise 不能保证最后一笔保存完成；15 秒安装等待保护的是正常退出协议，不能把它扩展成异常终止恢复保证。
- **未启用的托管能力。** GitHub、实时协作、云分享和可选 LLM 请求仍有独立的网络、权限和数据容量边界；本轮没有把它们当成本机功能完成，也没有为这些路径新增登录依赖。
