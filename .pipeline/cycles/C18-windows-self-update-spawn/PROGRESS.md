---
kind: progress
cycle: C18-windows-self-update-spawn
plan: PLAN.md
status: in-progress
updated: 2026-08-18T14:01:00+08:00
current: M2
next: publish_v1_1_1
---

# Windows 自更新安装器修复进度

| ID | 状态 | 证据 |
| --- | --- | --- |
| `M1` | `completed` | Windows npm invocation 改为 `ComSpec /d /s /c npm.cmd`；ComSpec/fallback 与原有 npm/Volta 共 11 项 updater tests 通过 |
| `M2` | `in_progress` | check、129 files / 954 tests、pack/install/verifier 与 audit 通过；等待提交/tag/双平台 Release |
