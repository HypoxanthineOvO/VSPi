---
kind: execution
cycle: C16-render-performance-repair
updated: 2026-08-17T16:36:00+08:00
---

# Execution Checkpoints

## 2026-08-17 - C16 建立与范围确认

- **计划项：** `M1`/`M2`
- **用户决定：** 接受 C15 审计结论，开 C16 实施 P1-1/P1-2/P1-3 三路全试，目标对标 Codex（33ms/帧、8.4KB/s、CPU 0% → 指标化为空帧<5%、streaming CPU<5%、无>100ms 停顿、滚动 bytes 减半）。
- **用户判断：** 滚动原生交给终端（regular/inline 模式）是 P1-3 主要解法；M4b 升级为主路线，两种模式都做到位，默认 `tuiMode` 留给 S1 体感决定。
- **正交性确认：** P1-1（空帧）、P1-2（streaming 停顿）与模式选择正交，两种模式下都存在，照修。
- **下一步：** M2 空帧抑制实现（TerminalFrameOptimizer 层 no-op 帧丢弃 + 单测），随后 M3 profile 归因。

## 2026-08-17 - M2 空帧抑制与 M4a 滚动降帧实现

- **计划项：** `M2`/`M4a`
- **M2 实现：** `TerminalFrameOptimizer` 新增 `PURE_TAIL_FRAME` 识别：无 rowUpdates 且仅重复已发出的 cursor tail 的帧直接丢弃；row-update 帧解析后记录 tail；static commit（commit/append/replace/beginSurfaceEpoch）与 fullRedraw/图片/resize/模式切换使 tail 跟踪失效。两模式共用（pi-tui 帧在本层均带 2026）。
- **M4a 实现：** 发现滚轮走 `routeWheel → ScrollView.scrollBy` 绕过 `scrollBy()` override（C14 的 100ms 合并只覆盖键盘滚动）；改为 `requestRender` 中比较 `viewportTop` 变化（任意滚动源），滚动后 500ms 窗口内 cadence 33→66ms（`VSPI_TUI_SCROLL_FRAME_INTERVAL_MS` 可配）；`TuiFramePacer` 支持动态 interval（避免双 pacer 的 lastForwardedAt 割裂）。
- **验证：** 定向 13 项 + fullscreen/scrollback/composer 24 项全过；check/build 通过。
- **trace 复测（100×30 大历史+滚动）：** frames 955→340（-64%）、空帧 59%→30%、峰值 57.9→33.0KB/s（-43%）、31→16fps。
- **regular 伪影确认：** regular 模式未开 mouse reporting，真实终端 wheel 由终端本地处理不进 stdin；C15 记录的「40×10B/s 微写」为 harness 注入 wheel 序列所致，真实滚动成本为 0，无需优化。
- **A/B 归因：** fixture 13KB 长流式确定性对比（仅 stash 渲染三文件）：CPU 5.2%→2.2%、帧 305→133。真实模型 CPU 方差 26-64% 与构建无关（同构建 baseline 34-43%），主导在 provider 流式处理路径——归入 M3。
- **M3 现状：** fixture 长流式（同构建）p95 77ms 无停顿；真实模型 p95 91-188ms 波动，growing markdown 块级缓存待实现。
- **下一步：** M3 markdown 块级缓存/分片设计；M4b regular 体验完善。

## 2026-08-17 - M3 帧耗时 instrumentation 与 P1-2 重新归因

- **计划项：** `M3`
- **实现：** `VSPI_FRAME_STATS=<path>`（scrollback-terminal.ts）：VspiTuiAltScreen/ScrollbackTUI override `doRender` 记录每帧耗时（无正文 JSONL）；另加 `VSPI_FIXTURE_LONG_TEXT=1`（fixture-backend.ts）生成 13KB 多节 markdown 长流式。
- **实测：** 真实模型流式 887 帧 doRender p50 25.9ms / p95 47.4ms / p99 54.8ms，仅 4 帧 >60ms（最大 310ms 为会话尾部终止帧）；fixture 长流式 p95 77ms、CPU 2.2%（baseline 5.2%）。
- **重新归因：** C15 记录的「单帧停顿 p95 225ms」实为 write 间隔，主体是 provider token 间隙（无 update 即无帧）；渲染单帧成本健康。markdown 块级缓存当前消息规模下不必要，记为超长单条消息（>30KB）观察项。
- **下一步：** M4b regular 体验完善。

## 2026-08-17 - M4b /tui 命令与模式验收准备；M4c 评估；M5 门禁

- **计划项：** `M4b`/`M4c`/`M5`
- **M4b：** 新增 `/tui` 命令（commands.ts + toggleTuiMode：保存设置 + switchTuiMode + 中文提示），设置面板 tuiMode 行已有；regular 模式滚动 0 输出已在 C15/M2 阶段实证（C15 的 40×10B/s 为 harness wheel 注入伪影，真实终端 regular 未开 mouse reporting）。
- **M4c 决策：** 暂缓。M2/M4a 后滚动峰值已 -43%，行内最小 span 的剩余收益集中在 streaming 增量行（rowDiff 帧局部变化），属上游 pi-tui cell 级 diff 的职责范围；VSPi 层实现的宽字符/SGR/OSC8 等价性风险不划算。
- **M5：** `npm run check` 零错；全量 118 files / 887 tests 通过（含 C14 时遗留失败的 docs-contract，README 已在发布前修复）；`test:pty` 11 项通过；`npm pack` 299 files。
- **最终 trace（100×30 大历史+滚动）：** frames 955→346、峰值 57.9→33.0KB/s、31→16fps、CPU 0%。
- **下一步：** S1 用户验收。

## 2026-08-17 - S1 接受、默认 regular 与 M6 Markdown 回归修复

- **计划项：** `S1`/`M6`
- **用户验收：** 用户在真实使用中确认 regular（非 FullScreen）模式“丝滑又流畅”，明确决定固定为默认模式；`DEFAULT_SETTINGS.tuiMode` 与 fixture 缺省值改为 `regular`，缺省/非法设置回退测试和 README/Usage/TUI 文档同步更新。fullscreen 仍可通过 Settings、`/tui` 或 `VSPi_TUI_MODE=fullscreen` 选择。
- **根因：** C14 将普通 assistant Transcript 切到持久化 `AssistantMessageComponent` 后，只迁移了输入侧 Markdown transformer；VSPi 的 rendered-lines 后处理仍只在 `VspiMarkdown` 中，导致实际 assistant 路径丢失分层无序列表 `•/◦/▪`、task list `✓/○`、代码块 header/body 和表格边框主题处理。
- **修复：** 从 `VspiMarkdown.render()` 提取共享 `postprocessMarkdownLines()`，同时接到 upstream assistant 的 cached 与 non-cached 输出路径，保留 upstream renderer、streaming 生命周期和缓存性能路径。
- **验证：** 定向 settings/markdown/transcript 共 61 项通过；`npm run check` 通过。全量首轮 118 files / 888 tests 中 5 项因并行负载触发 5s timeout，其余 883 项通过；失败文件独立重跑 `4 + 4 + 43` 项全部通过，确认无功能回归。
- **结论：** S1 接受，M6 完成，C16 关闭。
