---
kind: discussion-summary
cycle: C18-windows-self-update-spawn
updated: 2026-08-18T00:00:00+08:00
---

# Windows 自更新安装器修复讨论摘要

- v1.1.0 Release 缺 SHA 描述的问题已通过补充元数据解决。
- Windows 后续进入安装阶段后暴露 `spawn EINVAL`；原因是 `.cmd` 不能按普通 `.exe` 由 `execFile` 直接启动。
- 用户确认继续修复；采用新补丁版本，不改写 v1.1.0。
