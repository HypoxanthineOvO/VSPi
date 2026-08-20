---
kind: progress
cycle: C20-compact-error-details
plan: PLAN.md
status: completed
updated: 2026-08-20T20:53:00+08:00
current: none
next: none
---

# 紧凑错误与详情预览进度

## 当前状态

实现与验证已完成。Provider `message_end` 的 `errorMessage` 会投影为 error notice；TUI 仅显示 `操作失败 · Ctrl+O 查看详情`，完整错误保存在当前应用实例中，详情页尽可能 pretty-print JSON，`Esc` 关闭。用户取消不会误报错误。

## 阻塞

- 无。
