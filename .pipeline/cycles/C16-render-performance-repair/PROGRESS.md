---
kind: progress
cycle: C16-render-performance-repair
plan: PLAN.md
status: closed
updated: 2026-08-17T16:36:00+08:00
current: complete
next: none
---

# 渲染性能修复进度

## 当前状态

M2/M3/M4a/M4b/M5 完成，M4c 评估后暂缓（边际收益小、等价性风险高）。用户确认 regular 模式丝滑流畅并接受为默认 `tuiMode`；Markdown renderer 切换遗漏的 VSPi 后处理已恢复。C16 完成并关闭。

## 计划状态

| ID | 阶段 | 状态 | 结果 |
| --- | --- | --- | --- |
| `M1` | 基线与指标 | `completed` | C15 trace 即 before；fixture 长文本模式（VSPI_FIXTURE_LONG_TEXT=1）可复现 streaming |
| `M2` | P1-1 空帧抑制 | `completed` | PURE_TAIL 帧丢弃 + tail 跟踪；fullscreen 空帧 59%→30%，write -64%；regular 伪影确认无需处理 |
| `M3` | P1-2 streaming 停顿 | `completed` | VSPI_FRAME_STATS instrumentation；真实流式 doRender p50 25.9/p95 47.4/p99 54.8ms；帧间隔 p95 主体为 provider cadence；块级缓存暂不需要（记为超长消息观察项） |
| `M4b` | P1-3 主路线：原生滚动 | `completed` | /tui 命令 + 设置入口 + regular 滚动 0 输出实证；默认模式留 S1 |
| `M4a` | P1-3 fullscreen 滚动缓解 | `completed` | viewportTop 检测 + 66ms 滚动窗口；16fps/-43% bytes；覆盖滚轮绕过 scrollBy 的路径 |
| `M4c` | P1-3 cell 级 diff（实验） | `completed` | 评估后暂缓：M2/M4a 后剩余收益集中在 streaming 增量行，属上游 cell diff 职责；oracle 等价性风险不划算 |
| `M5` | 集成门禁 | `completed` | check 零错；118 files/887 tests 全过；PTY 11 项；pack 299 files |
| `S1` | 用户验收 | `completed` | 用户确认非 FullScreen（regular）模式丝滑流畅，决定固定为默认 `tuiMode` |
| `M6` | Markdown 渲染回归修复 | `completed` | 共享 VSPi rendered-lines 后处理接入 upstream assistant cached/non-cached 路径；列表/任务项/代码块契约恢复；check 与回归通过 |

## 阻塞

- 无。
