---
kind: summary
cycle: C16-render-performance-repair
status: closed
updated: 2026-08-17T16:36:00+08:00
---

# 渲染性能修复总结

C16 完成 C15 审计确认的 P1 渲染修复，并经用户真实体验接受 regular 为默认 TUI 模式。

- 空帧抑制、fullscreen 滚动降帧、regular 原生 scrollback 路线与帧耗时 instrumentation 已完成；最终大历史滚动 trace 为 31→16fps、峰值 57.9→33.0KB/s、CPU 0%。
- 用户确认 regular 模式“丝滑又流畅”，项目默认 `tuiMode` 从 fullscreen 改为 regular；fullscreen 仍可显式选择。
- assistant renderer 切换遗漏的 VSPi Markdown 后处理已恢复，分层无序列表、任务项、代码块和表格样式重新进入 cached/non-cached Transcript 路径。
- `npm run check` 通过；全量 118 files / 888 tests 的 5 个并行超时用例独立重跑全部通过。

M4c cell 级 diff 经评估暂缓：当前剩余收益不足以覆盖宽字符、SGR 与 OSC8 等价性风险。
