---
kind: plan
cycle: C23-release-1-1-4
mode: plan
status: completed
updated: 2026-08-21T16:30:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
builds_on:
  - C22-release-1-1-3
---

# VSPi 1.1.4 发布

## 目的

将 Sessions 渲染修复、状态栏 Hit Rate 槽位修复与 Transcript 灰度调整作为向后兼容 patch release 发布到 GitLab 与 GitHub。

## 范围

- 新增 `Docs/releases/v1.1.4.md`。
- 同步 bump `package.json` 与 `package-lock.json` 到 `1.1.4`。
- 完成全量测试、package 校验与全新安装验证。
- 创建 release commit 与 `v1.1.4` tag，推送 `origin` 和 `github`。
- 核验两个远端的 pipeline、Release 与 latest/pinned 资产。

## 计划

| ID | 工作项 | 状态 |
| --- | --- | --- |
| `R1` | Release notes 与版本元数据 | completed |
| `R2` | 发布前验证 | completed |
| `R3` | Commit、tag 与双远端 push | completed |
| `R4` | 远端发布核验 | completed |
