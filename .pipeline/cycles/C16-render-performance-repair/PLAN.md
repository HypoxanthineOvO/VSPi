---
kind: plan
cycle: C16-render-performance-repair
mode: plan
status: closed
updated: 2026-08-17T16:36:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C15-render-algorithm-performance-audit
---

# 渲染性能修复（对标 Codex）

## 目的

实施 C15 审计（`../C15-render-algorithm-performance-audit/AUDIT.md`）确认的 P1 修复，把 VSPi 渲染性能量化对标 Codex CLI 实测水平：空帧占比 <5%、streaming CPU <5%、无 >100ms 单帧停顿、fullscreen 滚动 bytes 减半。

## 背景

- C15 量化基线（100×30 direct PTY，v1.0.0 dist）：
  - 60% write 为 <40B 空帧（P1-1）；
  - 真实模型 streaming CPU 26.5%/峰 87.9%、帧间隔 p95 225ms（P1-2）；
  - fullscreen 历史滚动峰值 57.3KB/s、~650 行/秒（P1-3）；regular 同场景滚动输出 ≈0。
- 竞品参照：Codex = commit 队列 + 每帧一行 drain + inline viewport（滚动免费）+ 每帧 ?2026，实测 33ms/帧、8.4KB/s、CPU 0%；OpenCode = OpenTUI Zig cell 级 diff + no-op 帧抑制。
- **用户判断（2026-08-17）**：滚动原生交给终端是 P1-3 的主要解法 → M4b 升级为主路线；两种模式都做到位，默认模式由用户验收时体感决定。

## 边界

- 不回退 C14 已接受行为：30fps pacer、focused keyboard 即时渲染、semantic cache、shift optimizer。
- fullscreen 与 regular 是模式选择而非补丁关系：M4b 完善原生滚动体验，M4a/M4c 缓解 fullscreen 剩余成本；不私自改产品默认 `tuiMode`，默认模式变更留给 S1 用户决定。
- cell 级 diff（M4c）为实验项：必须有 xterm-headless oracle 等价性验证，不达等价即回退。
- 修复顺序按 P1 编号推进，每步跑定向回归，M5 统一过全量门禁。

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | 基线与指标 | C15 trace 作为 before；对标指标落文 | BASELINE.md |
| `M2` | P1-1 空帧抑制 | no-op 帧（内容与光标均未变）在 write 层丢弃；两种模式空帧 <5% | 单测 + render-trace before/after |
| `M3` | P1-2 streaming 停顿 | profile 归因 → 增量/分片渲染实现；无 >100ms 帧停顿、CPU <5% | micro-profile + real-model trace |
| `M4b` | P1-3 主路线：原生滚动 | regular 模式功能面完整 + 快速切换 + 文档；两模式 trace 达标对比 | 功能回归 + trace 对比 + S1 体感 |
| `M4a` | P1-3 fullscreen 滚动缓解 | 滚动窗口降帧（默认 66ms，`VSPI_TUI_SCROLL_FRAME_INTERVAL_MS` 可配），滚动 bytes 减半 | 定向单测 + trace |
| `M4c` | P1-3 cell 级 diff（实验） | 行内最小 span 输出；oracle 等价则并入，否则记录回退 | xterm-headless 最终屏等价测试 |
| `M5` | 集成门禁 | check / 全量测试 / PTY / package verify 全过；trace 复测对比表 | 门禁命令 + AUDIT 附录 |
| `S1` | 用户验收 | 用户体感确认两种模式 + 定默认模式 + 可选真实 VSCode DSR 采样 | 用户接受或退回对应 M |
| `M6` | Markdown 渲染回归修复 | upstream assistant renderer 保留 VSPi 列表、任务项、代码块和表格后处理契约 | Transcript cached/non-cached 定向测试 + 全量回归 |
