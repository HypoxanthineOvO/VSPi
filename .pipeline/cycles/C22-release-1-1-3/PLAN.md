---
kind: plan
cycle: C22-release-1-1-3
mode: plan
status: active
updated: 2026-08-20T21:16:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C21-inline-error-node
---

# VSPi 1.1.3 发布

## 目的

将 C20/C21 的 provider 错误修复作为向后兼容 patch release 发布到 GitLab 与 GitHub。

## 范围

- 新增 `Docs/releases/v1.1.3.md`。
- 同步 bump `package.json` 与 `package-lock.json` 到 `1.1.3`。
- 完成全量测试、package 校验与全新安装验证。
- 创建 release commit 与 `v1.1.3` tag，推送 `origin` 和 `github`。
- 核验两个远端的 pipeline、Release 与 latest/pinned 资产。

## 计划

| ID | 工作项 | 状态 |
| --- | --- | --- |
| `R1` | Release notes 与版本元数据 | completed |
| `R2` | 发布前验证 | completed |
| `R3` | Commit、tag 与双远端 push | in_progress |
| `R4` | 远端发布核验 | pending |
