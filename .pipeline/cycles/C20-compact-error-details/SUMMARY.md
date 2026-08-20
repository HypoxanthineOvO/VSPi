---
kind: cycle-summary
cycle: C20-compact-error-details
status: closed
updated: 2026-08-20T20:53:00+08:00
---

# 紧凑错误与详情预览总结

## 结果

- 修复真实 provider failure 链路：读取 assistant `errorMessage`，不再静默丢弃。
- 所有 error notice 在主界面显示紧凑标识 `操作失败 · Ctrl+O 查看详情`。
- `Ctrl+O` 打开最近一次完整错误，`Esc` 关闭；详情仅驻留当前应用实例。
- 完整 JSON、JSON 字符串及 `data:` suffix 尽可能 pretty-print；非 JSON 原样保留。

## 验证

- 错误恢复与 Pi backend：26 项通过。
- interaction registry、layout、fullscreen TUI：18 项通过。
- `npx tsc --noEmit` 通过。
- Biome 定向检查通过。

## 剩余边界

- 若 provider 把巨大 payload 作为正常 assistant content 而非 `errorMessage`，它仍按正常 transcript 内容展示。
- JSON 后附带额外非 JSON 尾缀时无法整体解析，会保留原文。
