---
kind: baseline
cycle: C15-render-algorithm-performance-audit
milestone: M1
updated: 2026-08-16T23:20:00+08:00
---

# M1 审计基线与测量口径

## 审计对象（C14 交付后的现行渲染链路）

| 层 | 位置 | 现状要点 |
| --- | --- | --- |
| Frame pacing | `src/ui/tui-frame-pacer.ts` | 通用 33ms（约 30 FPS）pacing；focused keyboard 即时；`VSPI_TUI_FRAME_INTERVAL_MS` 16-250ms 诊断覆盖 |
| Viewport shift 检测 | `src/ui/terminal-frame-optimizer.ts` | alt-screen 模型 + strict exact shift → DECSTBM + CSI S/T；任意 region/large shift；失败回退 Pi 逐行 diff |
| 应用层缓存 | `src/app/vspi-app.ts` | fullscreen body/dock 按 semantic render revision + width 缓存；纯滚动只更新 ScrollView layout/crop |
| Transcript 缓存 | `src/ui/transcript.ts` | message cache 最多 4 个 width/settings variants；row estimate 校验 immutable refs |
| 组件构建 | `src/ui/panels.ts`、`markdown.ts`、`composer.ts` 等 | 每帧参与 body/dock 构建；`panels.ts` 2954 行为最大文件 |
| 上游 | Pi 官方 layout scheduling、differential write、`AssistantMessageComponent` streaming 生命周期 | 归因基线（preference-43221dda） |

## KPI

1. **节流层**：任意 1s 窗口 frames 数（30 FPS 上限下应 ≤31）；request coalesce 比例；focused keyboard render 即时性。
2. **构建层**：每帧 `buildRenderBody` / `buildRenderDock` / `buildRenderSections` 调用次数（streaming 目标 1:1:0；纯滚动目标 0 增长）；frame 耗时 mean/max；event-loop max lag。
3. **输出层**：每帧与峰值窗口的 terminal writes、ANSI bytes、rewritten rows。
4. **终端前端层**（仅真实 Terminal 可测）：DSR probe 中位数 / max / >1s 计数（backlog 证据，对应 >5s 可见冻结与风扇症状）。
5. **资源**：VSPi 进程与 consumer CPU 占比。

## 场景矩阵

| # | 场景 | 说明 | 优先级 |
| --- | --- | --- | --- |
| A | streaming | 真实模型长回复，direct PTY 100×30 | 高 |
| B | 纯滚动 | wheel 低位/中位/高历史位置，向上与向下 | 高 |
| C | 高历史位置反向滚动 | C14 接受时保留的遗留边界 | 最高 |
| D | 长会话/长消息 | 大量历史消息；长 markdown/代码块/thinking 单条 | 高 |
| E | resize / 宽窄终端 | cache width variants 失效与重建成本 | 中 |
| F | streaming + 滚动并发 | C14 已确认的历史高危组合 | 高 |

## 测量环境三层

1. **direct PTY**（node-pty，无 parser）：测 Node 侧帧计算/构建成本。
2. **xterm-headless consumer**：parser 重放，测 write bytes/rewritten rows 与 parser backlog。
3. **真实 VSCode Remote SSH Terminal**：无正文 DSR trace（需用户配合采样），唯一能观测本地 renderer 积压的层。

## 工具资产盘点

- **已固化**：`test/tui-frame-pacer.test.ts`（合并/节流/滚轮语义）、`test/terminal-frame-optimizer.test.ts`（shift 正确性/fallback）、`test/fullscreen-tui.test.ts`（fullscreen PTY 行为）——均为功能回归，非性能基准。
- **未固化（C14 会话内临时手段）**：perf + 只读 method instrumentation、无正文 write/rows/bytes trace、DSR probe、xterm-headless replay。
- **已固化（C15）**：`scripts/render-trace.mjs`（node-pty + xterm-headless 无正文 trace，场景脚本驱动）。
- **仍为临时**：真实 VSCode Terminal 的 DSR probe 采样（需用户现场配合）。
