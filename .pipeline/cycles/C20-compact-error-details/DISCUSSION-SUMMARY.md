---
kind: discussion-summary
cycle: C20-compact-error-details
updated: 2026-08-20T20:53:00+08:00
---

# Discussion Summary

用户报告 upstream `response.failed` 错误疑似把整个 JSON payload dump 到 TUI，产生三万余字符的错误文本。用户要求主界面改为简单但明显的错误标识，通过特定快捷键查看完整详情，并尽可能格式化 JSON。

已按该要求实现：主界面显示紧凑失败标识，`Ctrl+O` 查看最近错误详情，`Esc` 关闭；可解析 JSON 使用两空格缩进，无法解析时保留原始诊断文本。
