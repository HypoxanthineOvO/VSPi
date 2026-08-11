---
kind: plan
cycle: C12-release-train
mode: goal
status: waiting-review
updated: 2026-08-11T19:50:38+08:00
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi v0.6.0 Release Train

## 执行目的

将 `v0.3.11` 后已接受的 Agent Teams、Persistent Goals、终端可靠性与 Pi 0.84 Fullscreen Runtime 整理为一个真实、可安装、可审计的 `v0.6.0` GitLab Release，并交付可在 Windows 上执行的安装命令。

## 执行边界

- 当前实际发布版本为 `v0.6.0`；`v0.4.0` Agent Teams 与 `v0.5.0` Persistent Goals 作为未独立发布的能力里程碑写入 release notes，不创建缺少独立可构建提交的追溯 tag。
- 发布渠道仅使用 Git commit/tag、GitLab CI、Generic Package、GitLab Release 与本地安装验证，不发布到公共 npm registry。
- 保留现有 dirty worktree 中全部已接受实现与语义历史；修复 Record Store 完整性时不丢失 C07 决策内容或 supersedes 关系。
- 允许为本次发布提交并推送 `main`、创建并推送 `v0.6.0` tag，以及由现有 CI 创建 Release 和上传资产。

## 验证目标

- Record Store 可由当前 Hypo-Workflow Core 完整读取并重建派生索引。
- `package.json`、lockfile、CLI `--version`、tag 与发布资产全部一致为 `0.6.0`。
- check、全量测试、build、smoke、PTY、audit、pack、包内容验证与干净安装全部通过。
- `main` 与 tag pipeline 成功；GitLab Release、不可变 tarball、latest tarball 和 SHA-256 可匿名读取。
- 从 Release latest URL 安装后 `vspi --version` 返回 `0.6.0`；Windows 命令只依赖受支持的 Node.js/npm。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `R1` | 发布边界与 Goal 建立 | `v0.6.0` 作为真实发布，`v0.4.0`/`v0.5.0` 只作为能力里程碑 | Plan、Discussion 与项目索引一致 |
| `R2` | 完整性与版本准备 | 修复 Record Store，更新版本、release notes、README 与 Windows 安装说明 | Core index rebuild、版本契约测试、diff review |
| `R3` | 本地发布门禁 | 源码、PTY、安全、打包和干净安装全部通过 | check/test/build/smoke/test:pty/audit/pack/install |
| `R4` | 主线提交与 CI | 发布内容形成有意提交并推送 `main`，分支 pipeline 通过 | Git status、remote branch、GitLab pipeline/jobs |
| `R5` | Tag 与 GitLab Release | `v0.6.0` tag pipeline 创建可下载 Release | tag、pipeline、Release API、资产与 SHA-256 |
| `R6` | Release 安装复验 | latest Release URL 安装成功，形成 Windows 安装指令 | 临时 prefix 安装、`vspi --version`、release smoke |
| `R7` | Windows 0.6.1 corrective release | 修复 Windows named-pipe lease，发布 0.6.1 并完成 Windows 安装复验 | 平台路径单测、全量门禁、tag pipeline、Release 资产安装 |
| `R8` | Windows TUI corrective revision | 移除与 fullscreen TUI 冲突的旧会话刷新机制，修复 Auto permission 切换，并按代际与价格稳定排序模型 | 定向回归、fullscreen/PTY、全量门禁、Windows 安装验收 |

ID 在本 Cycle 内保持稳定；本 Goal 没有中间人工审阅点。
