---
kind: audit-report
cycle: C15-render-algorithm-performance-audit
milestone: M4
updated: 2026-08-17T00:30:00+08:00
evidence-dir: tmp/c15/（gitignored，含 raw 流，仅本机）
tool: scripts/render-trace.mjs
---

# VSPi 渲染算法性能审计报告

## 一、方法与证据边界

- 工具：`scripts/render-trace.mjs`（本 Cycle 固化）：node-pty 100×30 + xterm-headless 6.0.0，逐 write 记录 bytes/rowUpdates/viewport diff/帧分类（fullRedraw/shift/rowDiff/other），500ms 采样 `/proc` CPU；无正文落盘（raw 流仅在 gitignored 的 tmp/）。
- 环境：本机 direct PTY（无真实 renderer 积压层）。C14 结论继续有效：远端毫秒级数据不能直接证明 VSCode 本地 renderer 症状；本报告的终端前端结论以「输出负载模型」表述，真实 DSR 采样仍需用户配合（见缺口）。
- 竞品：OpenCode v1.14.30（本机二进制 + GitHub v1.14.30 源码 + OpenTUI main 源码）、Codex CLI（GitHub main 源码 + 本机实测）、Claude Code 2.1.233（本机二进制 strings，无源码，标注未确认项）。
- 被测对象：仓库 `dist/`（v1.0.0）。

## 二、渲染链路现状（M2 代码审计结论）

| 层 | 实现 | 关键事实（证据） |
| --- | --- | --- |
| 上游调度 | pi-tui `TuiBase` | `requestRender`→nextTick→`scheduleRender`，`MIN_RENDER_INTERVAL_MS=16`；键盘走 `requestImmediateRender` 抢占（tui.js:499-549,110） |
| VSPi 节流 | `tui-frame-pacer.ts` | 33ms pacing 叠加在 pi-tui 16ms 之上；滚轮 100ms 合并；`scrollBy` 聚合净位移 |
| 上游 diff | pi-tui `TuiAltScreen.renderFrame` | 行级：跳过相同行，变化行输出 `CUP+EL(2K)+整行`，尾部 CUP+光标显隐，每帧包 ?2026（tui-alt-screen.js:1109-1136） |
| VSPi 输出改写 | `scrollback-terminal.ts` | ① `TerminalFrameOptimizer`：帧内 strict exact shift → DECSTBM+CSI S/T，残差行重写；② `adaptInteractiveTerminalOutput` 默认**剥离 ?2026**（`VSPI_TUI_SYNC_OUTPUT=1` 可开） |
| 应用缓存 | `vspi-app.ts` | fullscreen body/dock 按 `fullscreenRenderRevision`+width 缓存；`handleInput`（键盘）每次 bump revision；鼠标被 pi-tui `handleViewportInput` consume 不触发 bump |
| transcript 缓存 | `transcript.ts` | message cache 4 个 width/settings variants |
| 模式 | 默认 `tuiMode: "fullscreen"`（alt-screen 应用自管 viewport）；可选 `regular`（ScrollbackTUI，append-only + 终端原生 scrollback） | defaults.ts:26 |

## 三、量化测量（M3）

### VSPi（100×30，dist v1.0.0）

| 场景 | 时长 | 帧 | 总 bytes | 峰值 bytes/s | 峰值帧/s | CPU avg/max | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A fixture 短流 | 30s | 25 | 12.8KB | 5.5KB | 14 | 2%/44%* | *峰在启动 |
| B/C/D 大历史+滚动（fullscreen） | 125s | 955 | 363KB | **57.3KB** | 31 | 0%/2% | 滚动期每秒重写 ~650 行 |
| 同场景 regular 模式 | 125s | 729 | 249KB | **9.3KB** | 43† | 0%/0% | 滚动期仅 40×10B/s 微写；†打字即时渲染 |
| E resize×4+流 | 70s | 248 | 68KB | 4.7KB | 29 | 0.1%/6% | 7 次 fullRedraw 各 ~2.6KB，可控 |
| A 真实模型长回复 | 75s | 1013 | 316KB | 11.4KB | 26 | **26.5%/87.9%** | 帧间隔 p95 **225ms** |

fullscreen 滚动窗口细节（88-90s，150 次 wheel-up 25ms 间隔）：
- 帧序列全部为 shift 帧（DECSTBM+S/T 生效），p50 1390B/帧，残差 rowUpdates p50=8（与合并位移 3-15 行成正比，含新露出行+dock，符合设计预期）；
- 30fps 打满（31 帧/s），即结构上滚动 = 持续向终端发送接近整 viewport 换位的帧流。
- 间隙 p50 32.5ms = pacer 生效；p95 565ms 出现在大位移合并后（单帧工作量大）。

### 全局异常数据

1. **空帧/微帧占比 60%**：大历史场景 955 write 中 577 个 <40B（均值 ~16B，无行内容）；streaming 期间密度 5-22 次/秒。成因：无内容变化的渲染请求仍被转发，pi-tui 对 0 行变化帧仍输出 cursor 尾部（无 no-op 抑制）。每次空帧都是一次独立 terminal write（真实终端=一次 parser/renderer 唤醒）。
2. **真实模型 streaming 的 Node 侧成本**：CPU 均值 26.5%、峰 87.9%，帧间隔 p95 225ms（长 markdown 增长帧的事件循环停顿）。C14 已把吞吐降到 30fps，但**单帧计算**在长消息上仍会阻塞 >200ms。
3. regular 模式滚动期 40 次/秒 × 10B 滚轮回显微写（低危）。

### 竞品实测（同终端 100×30，同 harness）

| 指标 | VSPi fixture 短流 | VSPi 真实长回复 | OpenCode（短回复） | Codex（短回复） |
| --- | --- | --- | --- | --- |
| 总 write | 25 | 1013 | 22 | 309 |
| 总 bytes | 12.8KB | 316KB | 38.8KB | 56KB |
| 峰值 bytes/s | 5.5KB | 11.4KB | 12.3KB | 8.4KB |
| 帧间隔 p50 | 21.5ms | 36ms | 7.9ms | **33.1ms** |
| CPU avg/max | 2%/44% | 26.5%/87.9% | 0%/0% | 0%/0% |
| ?2026 | 剥离 | 剥离 | 7 帧 | **223 帧（每帧）** |
| alt-screen | 是 | 是 | 是 | **否** |

## 四、竞品架构对比（M2b）

| 维度 | VSPi/Pi | OpenCode/OpenTUI | Codex | Claude Code |
| --- | --- | --- | --- | --- |
| 框架 | pi-tui（TS，行级 diff） | OpenTUI（Zig 核心 + SolidJS reconciler） | ratatui + crossterm（cell 级 diff） | Ink/React（行级 diff）［strings 证实 ink-*］ |
| 帧调度 | VSPi 33ms pacer 叠加 pi-tui 16ms | targetFps=30，commit 批处理（renderer.ts:777,1167） | FrameScheduler 合并请求，上限 120fps（frame_rate_limiter.rs:13）；实测流式 ~33ms/帧 | 未确认（未见渲染节流字符串） |
| 流式路径 | 每 messageUpdate → 全帧渲染（growing markdown 全量重排） | 原生增量 markdown 渲染器 `<code filetype="markdown" streaming>` | **commit 队列 + 每帧一行 drain**（app.rs:404-408）：token 突发与帧率解耦，每帧工作量恒定 | 未确认 |
| diff 粒度 | 行：CUP+EL+整行 | **cell 级**（实测 0 次 EL、510 次绝对定位）；「Lazy frame start = no-op 抑制」（renderer.zig:2333） | cell 级（ratatui buffer.diff） | 行级（Ink） |
| 滚动/历史 | fullscreen：应用自管 viewport，滚动=持续整屏换位帧 | alt-screen + cell diff | 常规对话 **inline viewport 无 alt-screen**（实测 1049h=0），历史翻页才进 alt-screen pager（event_dispatch.rs:698） | append-only scrollback + Static 区（React `Static` strings 佐意，细节未确认） |
| 同步输出 | 默认剥离（C14 决策） | DECRPM 探测后启用 | 每帧启用 | 存在（2 处字符串），范围未确认 |

## 五、问题分级

### P1-1 streaming 空帧未抑制（VSPi+pi-tui，易修）
60% write 为无内容微帧；修复=在 write 层增加 no-op 帧抑制（内容与光标均未变则跳过整帧）。OpenTUI 同位置机制：`renderer.zig:2333`。预期 write 数减半，直接降低终端 renderer 唤醒频率。

### P1-2 长消息 streaming 单帧停顿（VSPi，核心体验）
p95 225ms 事件循环停顿 + CPU 88% 峰。根因：growing markdown 全量重排 + row estimate 重算发生在 paced 帧内。修复方向：按 markdown 块缓存（只重排最后一个块）、estimate/渲染解耦、或超预算分片。竞品参照：OpenCode 原生增量渲染；Codex 队列 drain 恒定每帧工作量。

### P1-3 fullscreen 历史滚动结构性成本（VSPi/产品决策）
滚动=30fps×接近整 viewport 换位帧流（峰值 57KB/s、~650 行/s）。Node 侧已优化到 CPU 0%，剩余成本全部在终端前端。三条路：①长历史浏览引导/默认 regular 模式（实测滚动期输出≈0）；②fullscreen 滚动期动态降帧（33→66/100ms）；③上游行级 diff 升级 cell 级。C14 遗留「高历史位置反向滚动」即此结构的最差 case。

### P2 行级整行重写（pi-tui 上游）
每变化行 CUP+EL+整行（~100-200B），cell 级可再省（OpenCode 实测同场景 0 擦除）。收益中等、改动大，列为上游长期项。

### P2 ?2026 剥离决策待重估（VSPi）
C14 实测 VSCode 下剥离 2026 改善 DSR（保留该决策）；但 Codex/OpenCode 均默认启用。建议：VSCode xterm.js 版本演进后用无正文 DSR trace 复测一次再定。

### P3 findShift O(rows²)（VSPi）
每滚动帧全量位移扫描；semantic cache 下 Node CPU≈0，非瓶颈，可不修。

### 正面确认（非问题）
- 33ms pacer 生效（31 帧/s 上限实测）；键盘即时渲染正常（regular 43 write/s）。
- semantic cache 生效：滚动期 CPU 0%。
- resize 成本可控；空闲无持续帧流。
- 2026 剥离/optimizer 回退/宽高失效路径行为符合设计。

## 六、修复建议与去向

| 优先级 | 项 | 归属 | 建议去向 |
| --- | --- | --- | --- |
| 1 | 空帧抑制 | VSPi（可在 wrapper 层做） | C16 |
| 2 | streaming markdown 增量/分片渲染 | VSPi | C16（需设计） |
| 3 | 滚动策略（regular 引导 or 滚动降帧） | VSPi 产品决策 | C16 前先由用户定方向 |
| 4 | cell 级 diff / 2026 重估 | pi-tui 上游/重测 | 观察项 |

## 七、证据缺口

1. 真实 VSCode Remote SSH Terminal 的 DSR/backlog 采样（需用户在卡顿现场运行无正文 trace）——本报告终端前端结论均为输出负载模型推断。
2. Claude Code 流式节流参数与 Static 区行为：仅有二进制 strings 证据，标「未确认」。
3. OpenCode 第二次长提示实测未成功提交（输入未生效），其长流式画像由架构源码+短回复实测代替。
