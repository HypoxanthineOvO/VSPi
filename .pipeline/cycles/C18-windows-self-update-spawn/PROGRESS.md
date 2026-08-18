---
kind: progress
cycle: C18-windows-self-update-spawn
plan: PLAN.md
status: completed
updated: 2026-08-18T14:04:00+08:00
current: none
next: none
---

# Windows 自更新安装器修复进度

| ID | 状态 | 证据 |
| --- | --- | --- |
| `M1` | `completed` | Windows npm invocation 改为 `ComSpec /d /s /c npm.cmd`；ComSpec/fallback 与原有 npm/Volta 共 11 项 updater tests 通过 |
| `M2` | `completed` | tag/双平台 Release 完成；两个 latest 字节一致且 SHA-256 已验证；本机真实 1.1.0 → 1.1.1 自更新成功 |
