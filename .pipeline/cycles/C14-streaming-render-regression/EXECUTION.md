---
kind: execution
cycle: C14-streaming-render-regression
updated: 2026-08-16T19:15:36+08:00
---

# Execution Checkpoints

## 2026-08-16 - C14 建立与 M1 启动

- **计划项：** `M1`
- **目的：** 响应 C13 接受后出现的 streaming 体感回归，不把静态 render benchmark 当作流式体验证据。
- **结果：** 建立独立 C14；暂停 1.0 readiness 审计，开始 trace chunk→message update→render→terminal write。
- **已知变化：** C13 删除了跨帧整页 cache并恢复 Pi 每帧 layout；该变化可能增加计算，但当前未确认是根因。
- **下一步：** deterministic backend 与真实 PTY 双路径复现，记录帧间隔、更新次数、render 耗时和 terminal writes。

## 2026-08-16 - M1 direct VSPi 真实模型归因

- **计划项：** `M1`
- **环境：** `node-pty` 100×30 xterm，直接启动 `/home/heyx/.volta/tools/image/packages/vspi/bin/vspi`，使用 runtime default `opencode-go/deepseek-v4-flash`，向 Composer 输入短中文 prompt并等待 streaming；外部 `perf` 与只读 method instrumentation 记录 CPU/frame/build/cache，不保存屏幕正文。
- **结果：** C13 baseline 在持续 busy 期间取得 742 TUI frames、1482 次完整 `buildRenderSections`，几乎严格 2×；max frame 53ms、max section build 45ms，进程持续约 15-20% CPU。Pi 16ms scheduler 正常 coalesce，问题在每帧工作量而非无界 request queue。
- **归因：** fullscreen body 与 dock 是两个 Component，却都调用整页 builder；dock measure、body layout 会重复 composer/status/window/panel 计算，scrollbar 宽度变化还会触发 cache width 抖动。growing Markdown 每 immutable patch 也会全量更新。

## 2026-08-16 - M2 官方 render ownership 修复

- **计划项：** `M2`
- **实现：** fullscreen body/dock 改为独立 builder，dock measure 只拥有 activity/queue/composer/status，body 只拥有 transcript/panel；不恢复跨帧整页 cache。assistant text 改用 Pi 公开 `AssistantMessageComponent` 与官方 streaming update 生命周期，VSPi 仅保留 wrap-code/Mermaid transformer和产品外层呈现。
- **缓存正确性：** Transcript message cache保留最多四个 width/settings variants；row estimate校验 immutable message refs并纳入 thinking/tool 展示设置；超长 thinking estimate 与 render 统一 200K 上限。
- **回归：** scrollbar always 下每帧 body=1、dock=1；cursor-only 下一帧 marker变化；streaming text增长、thinking visibility与tool collapse切换均有失效测试。

## 2026-08-16 - M3 全量、安装与真实候选复测

- **计划项：** `M3`
- **门禁：** `npm run check` 通过；116 test files / 873 tests 全通过；package verify `vspi-0.6.4.tgz` 291 files；本地 tarball覆盖安装到 Volta package prefix，仓库/全局 app/transcript/markdown dist SHA-256 一致。
- **direct VSPi 候选：** 同一全局 `vspi`、OpenCode Go DeepSeek V4 Flash、100×30 PTY，一轮真实 streaming：154 frames、154 body builds、154 dock builds、0 full-section builds；mean frame 3.29ms，event-loop max lag 44ms。期间最长约1.46s无新 token但 activity仍刷新，属于 Provider cadence，不是 TUI event-loop冻结。
- **下一步：** S1 用户验收；接受后按已确认 requirement 进入 v1.0.0 发布流程。

## 2026-08-16 - S1 拒绝与 M1 重开

- **计划项：** `S1 -> M1`
- **用户结果：** 本机最终候选仍在单句触发的滚动输出中明显卡死，体感差于 0.6.0；S1 不接受。
- **证据缺口：** 先前 `node-pty` consumer 只统计并快速消费输出字节，未模拟真实 terminal parser/renderer 与 PTY backpressure，因此只能证明 VSPi Node event loop 未冻结，不能证明最终屏幕绘制流畅。
- **下一步：** direct `vspi` 长滚动回复接 xterm-headless consumer，记录 terminal write bytes/frame、parser backlog、整屏 rewritten rows、VSPi/consumer CPU 与 output cadence；保持 v1.0.0 流程暂停。

## 2026-08-16 - M1 terminal frontend 隔离

- **计划项：** `M1`
- **用户证据：** VSCode Remote SSH 集成 Terminal 特别卡；同一远端使用 Windows Terminal SSH 较流畅。向上滚动仍明显比向下更卡。
- **判断：** Provider、远端 Node runtime 与 SSH transport 不再是首要变量；优先比较 TERM_PROGRAM/capability 分支与 ANSI differential frame 在 VSCode xterm.js renderer 上的成本。
- **下一步：** 捕获不含正文的 write-size/rewritten-row/escape-class trace，以 xterm parser 重放；验证 synchronized output、全 viewport rewrite与 scrollbar/Unicode/SGR输出。

## 2026-08-16 - 毫秒级 trace 不构成真实复现

- **计划项：** `M1`
- **用户边界：** 真实症状是大于 5 秒的可见冻结与本机风扇明显加速；几十毫秒远端 frame数据不代表该问题。
- **当前结论：** direct PTY 与 xterm-headless只覆盖远端 Node render和ANSI parser，无法观测本地 VSCode/Electron renderer队列；不得据此宣称根因或修复。
- **下一步：** 优先获取 VSCode本地 GPU/renderer状态；若Remote CLI不能暴露，则交付不含正文的 write/backlog诊断模式，在真实卡顿Terminal中采样后再定修复。

## 2026-08-16 - 真实VSCode trace与通用刷新率方向

- **计划项：** `M1 -> M2`
- **真实trace：** 512 writes / 1.20MB ANSI / 3937 rewritten rows；两次峰值在222-265ms内写出9-12帧、487-596行。DSR中位22ms，积压阶段升至1.06-2.41s，并出现37.7s无新write空洞；与用户>5s可见冻结和本机风扇加速一致。
- **根因：** streaming与viewport滚动同时请求frame；Pi虽coalesce但旧上限约60 FPS，滚动或tail新增行会使几十行整体换位，VSCode xterm renderer消费落后后形成队列。
- **用户决定：** 不接受TERM_PROGRAM特判；TUI不需要高帧率，应对fullscreen/regular和所有终端使用通用刷新上限。
- **实现：** VSPi wrapper统一33ms pacing（约30 FPS），普通streaming/activity/viewport request合并；Pi focused keyboard immediate render不节流；`VSPI_TUI_FRAME_INTERVAL_MS`允许16-250ms诊断覆盖。
- **验证：** 100ms request burst最多4帧，focused keyboard在1ms测试窗内完成即时render；定向24项通过。

## 2026-08-16 - 通用30 FPS候选安装与direct复测

- **计划项：** `M2 -> M3`
- **产品路径：** fullscreen使用`VspiTuiAltScreen`，regular使用paced `ScrollbackTUI`；默认33ms，诊断覆盖范围16-250ms。模式切换和全局安装均进入同一wrapper。
- **direct真实模型：** OpenCode Go DeepSeek V4 Flash长回复、100×30 PTY、自动PageUp/PageDown；任意1秒窗口最多31 frames，无40-54 FPS burst；focused输入定向回归保持即时。
- **门禁：** `npm run check`通过；定向24项与PTY fullscreen通过；package verify 294 files；全局0.6.4安装与仓库`dist/ui/tui-frame-pacer.js`、`dist/index.js` hash一致。
- **已知非本改动失败：** full suite 117 files中116 files通过、872 tests通过；`test/docs-contract.test.ts`的4个case因当前精简README缺少旧详细契约文案失败，未回滚或改写README。
- **下一步：** 用户在真实VSCode Remote SSH Terminal用同一无正文DSR trace复测>5s backlog。

## 2026-08-16 - 第三轮trace：parser恢复但纯滚动paint仍积压

- **计划项：** `M2`
- **去同步flush结果：** DSR max从3.82s降至0.80s，0个>1s probe，证明parser/flush积压显著下降；最终screen/cursor/modes raw replay完全等价。
- **剩余现场：** 用户不进行streaming、只滚动仍出现>5s可见卡顿；Pi默认`wheelScrollLines=1`。
- **trace：** 最大232-270ms burst写出6-8帧、311-419行、133-171KB；每个1行viewport位移仍导致约40-52行绝对定位+erase+payload重写，本地paint队列继续积压。
- **下一步：** wheel默认改为3行；实现严格screen-shift检测，仅在纯文本、无full redraw/image且next/previous exact shift时用DECSTBM + CSI S/T，其他场景回退Pi逐行diff。

## 2026-08-16 - native viewport shift候选

- **计划项：** `M2 -> M3`
- **实现：** wheel每档3行；`TerminalFrameOptimizer`维护alt-screen模型，strict exact shift时设置body scroll region并使用CSI S/T，只补写新露出行和残余变化；full redraw、图片、resize/stale state或无收益时原样回退。
- **正确性：** scroll-up/down、dock同时变化、图片失效与fallback测试通过；xterm-headless原始逐行frame和优化frame的最终lines/cursor/modes完全一致；真实fullscreen PTY固定dock滚历史通过。
- **门禁：** `npm run check`通过；23项定向通过；package verify 297 files；全局安装与仓库optimizer/terminal dist hash一致。
- **下一步：** 用户在真实VSCode Remote SSH Terminal纯滚动复测，并通过无正文trace核对rewritten rows/bytes与DSR。

## 2026-08-16 - 高历史位置trace与window shift扩展

- **实机结果：** scrollbar-aware版本在低位部分命中，但高位快速滚动仍回退；峰值8 writes/247ms写324行/78KB，随后单个18-row write的DSR也可延迟0.9-1.8s，说明前序burst压满renderer队列。
- **根因补充：** 33ms pacing会合并多个wheel event，实际单帧shift可达12-30行，旧检测只搜索1-10行；同时算法只允许从row1开始的region。
- **实现：** shift amount扩展到viewport范围，扫描任意连续exact content run并生成任意`regionStart..regionEnd` DECSTBM；保留fixed top/dock；比较忽略独立scrollbar ANSI，完整行负责残差重画；无显式cursor回退；rows/columns变化清model。
- **验证：** 25项定向通过；large 12-row shift + fixed header/dock最终screen/cursor/modes等价；真实fixture 12个连续wheel event合并为1-2个native frames，合计仅13/21行补写。
- **下一步：** 最后一次真实VSCode高历史位置复测；若仍失败，撤回optimizer并进入ScrollView/window架构重构。

## 2026-08-16 - 应用层viewport semantic cache

- **最终window-shift trace：** max DSR 1.85s降至0.62s，>1s probe从3降至0，用户确认不再彻底卡死但高位反向滚动仍明显卡顿，未验收。
- **架构根因：** Pi ScrollView每次scroll都调用child.render；fullscreen body此前每次重新执行`buildRenderBody -> selectTranscriptWindow -> renderTranscript`并构建dock，即使消息与UI语义状态完全不变。
- **实现：** fullscreen body/dock按semantic render revision + width缓存；纯Home/End/PageUp/wheel只更新ScrollView layout/crop，不重建transcript tree；消息、streaming、keyboard、panel/status/theme、startup/invalidate仍使revision失效。
- **验证：** 纯scroll多次操作后`buildRenderBody/buildRenderDock`累计调用保持1；focused cursor input正确失效；13 suites/130 tests与check通过；297-file package verify及全局dist hash一致。
- **下一步：** 真实VSCode高历史位置反向滚动复测；通过后收口C14，否则进入更深的Pi virtual ScrollView fork。

## 2026-08-16 - S1 接受并恢复 v1.0.0 发布

- **计划项：** `S1`
- **用户结果：** 用户确认当前渲染“基本回到可用线，先这样吧”，接受以现状进入 v1.0.0。
- **交付边界：** 保留通用 30 FPS、滚轮 3 行、100ms viewport 合并、native viewport shift 与 fullscreen semantic cache；不宣称真实 VSCode Remote SSH Terminal 体验已经完美。
- **发布决定：** v1.0.0 同时发布到 GitHub 与 GitLab；README 面向普通用户，使用输入框、对话记录和计划面板等词；协议为 Apache-2.0；两个平台仅保留 tag 发包，不运行 CI 测试套件。
- **下一步：** 创建 v1.0.0 release commit 与 annotated tag，推送两个远端并核对 Release assets。
