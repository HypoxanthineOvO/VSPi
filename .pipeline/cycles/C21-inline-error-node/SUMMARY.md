---
kind: cycle-summary
cycle: C21-inline-error-node
status: closed
updated: 2026-08-20T21:09:09+08:00
---

# 瀑布流可展开错误节点总结

## 结果

- Provider/model 失败现在是持久瀑布流节点，折叠态为 `× 请求失败 · model`。
- Inspect 复用 `Enter`/`→` 展开和 `←` 收起；`Ctrl+O` 快速定位最近错误。
- JSON 详情 best-effort pretty-print；无法解析时保留原文。
- live、resume 和 Session handoff 支持新错误消息类型。
- 本地设置、命令等操作错误仍按原方式显示 Status notice。

## 验证

- 定向错误/backend/transcript：71 项通过。
- interaction、layout、fullscreen、session/backend：59 项通过。
- 全量 Vitest 通过，包括真实 PTY 与 package install。
- `npx tsc --noEmit`、Biome 与 `git diff --check` 通过。
