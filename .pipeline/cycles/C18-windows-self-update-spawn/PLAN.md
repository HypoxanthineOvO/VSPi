---
kind: plan
cycle: C18-windows-self-update-spawn
mode: goal
status: in-progress
builds_on: C17-prompt-cache-deepseek-adaptation
updated: 2026-08-18T00:00:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
---

# Windows 自更新安装器修复

## 目的

修复 Windows/Node.js 24 上 `vspi update` 在完成 Release 解析、下载与 SHA-256
校验后，因 `execFile("npm.cmd")` 抛出 `spawn EINVAL` 而无法安装的问题，并发布
不可变补丁版本 v1.1.1。

## 边界

- Windows npm 安装通过 `ComSpec`/`cmd.exe` 执行 `npm.cmd`；Volta `.exe` 保持直启。
- 不替换或移动 v1.1.0 tag/资产。
- 保留受信任 GitLab Release URL、SHA-256、64 MiB 上限与安装后版本核验。
- 增加可在非 Windows runner 上执行的平台注入 contract tests。

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | Installer 修复 | win32 npm invocation 使用 ComSpec，非 Windows npm 与 Volta 行为不变 | invocation 深比较与 update 定向测试 |
| `M2` | v1.1.1 门禁与发布 | package/check/full tests 通过，双平台 Release 可安装 | pack/install smoke、SHA256、tag/Release/latest 验证 |
