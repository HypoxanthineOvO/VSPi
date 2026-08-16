---
kind: plan
cycle: C14-streaming-render-regression
mode: plan
status: closed
updated: 2026-08-16T22:50:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C13-pi-editor-latency-repair
---

# Streaming 渲染回归

## 目的

复现并修复用户在 C13 接受后观察到的“渲染卡、没有流式渲染感”问题，区分 Provider chunk cadence、backend message update、App render scheduling、terminal diff write 与跨帧 cache 删除后的计算成本。

## 边界

- 不以静态 frame benchmark 代替 streaming cadence 验证。
- 不预设跨帧 cache 删除一定是根因；保留 C13 已接受的 cursor 可见帧正确性。
- 默认端到端复用 Pi 官方 render/layout scheduling、terminal differential output 与公开组件，不恢复或重建 VSPi 整页跨帧 pipeline/cache；仅在 upstream 无对应能力时保留可证明失效边界的局部呈现与 cache。
- C14 用户验收后恢复 1.0/GitHub readiness 与双平台发布。

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | Streaming cadence 复现与归因 | 测出 chunk、message update、render request、frame diff 与 terminal write 的时间序列 | deterministic streaming backend、TUI trace、真实 PTY |
| `M2` | 最小修复 | 消除确认的卡顿来源，不恢复 cursor stale cache | 定向 unit/app/PTY 回归与帧耗时对比 |
| `M3` | 集成与安装门禁 | 源码、全量、pack/install 与本机候选验证通过 | check/test/PTY/pack/install |
| `S1` | 本机 streaming 验收 | 用户确认回复恢复连续流式呈现且 cursor 不回退 | 本机接受或返回 M1/M2 |
