---
kind: plan
cycle: C21-inline-error-node
mode: plan
status: completed
updated: 2026-08-20T21:09:09+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C20-compact-error-details
---

# 瀑布流可展开错误节点

## 目的

把 provider/model 请求失败从底部 notice 调整为紧凑、持久、可在 Inspect 中展开的瀑布流错误节点。

## 边界

- 折叠态为单行 `× 请求失败 · <code/model>`，不使用大边框。
- 复用现有 Inspect 的 `Enter`/`→` 展开和 `←` 收起交互。
- 展开详情继续使用 C20 的 JSON pretty-print。
- 本地操作错误继续使用现有 Status notice；不引入 `pi-coding-agent` 私有组件。

## 计划

| ID | 工作项 | 状态 |
| --- | --- | --- |
| `M1` | live/resume 投影与复用点确认 | completed |
| `M2` | 错误节点、渲染和 Inspect 交互 | completed |
| `M3` | 定向测试和回归 | completed |
