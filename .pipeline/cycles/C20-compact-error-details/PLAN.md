---
kind: plan
cycle: C20-compact-error-details
mode: plan
status: completed
updated: 2026-08-20T20:53:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
---

# 紧凑错误与详情预览

## 目的

避免 upstream/API 超长错误占满 TUI，同时保留可检查的完整诊断信息。

## 边界

- 错误 notice 显示简短且明显的标识，不直接展开完整 payload。
- 使用 `Ctrl+O` 打开最近一次错误详情，`Esc` 关闭。
- 详情中的 JSON payload 尽可能 pretty-print；无法解析时保留原文。
- 不改变 warning/info/success notice 的现有行为，也不改变后端错误恢复语义。

## 计划

| ID | 工作项 | 状态 | 验证 |
| --- | --- | --- | --- |
| `M1` | 定位错误展示与快捷键链路 | completed | 静态检查 `VspiApp`、interaction registry 和错误恢复测试 |
| `M2` | 实现紧凑错误与详情预览 | completed | 定向单元测试覆盖摘要、快捷键、JSON 格式化与关闭 |
| `M3` | 回归与收尾 | completed | typecheck、定向测试、差异审查 |
