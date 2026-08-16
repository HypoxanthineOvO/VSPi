---
kind: progress
cycle: C12-release-train
plan: PLAN.md
status: closed
updated: 2026-08-15T17:41:14+08:00
current: complete
next: C13-pi-editor-latency-repair
---

# VSPi v0.6.0 Release Train 进度

## 当前状态

C12 已结束。0.6.0-0.6.2 的发布证据保持有效；0.6.3 Windows 最终验收被拒绝，后续修复转入 C13。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `R1` | 发布边界与 Goal 建立 | `completed` | C12、项目索引与 session focus 已建立；真实发布为 v0.6.0 | R2 |
| `R2` | 完整性与版本准备 | `completed` | 128 Records 可重建；版本三处为 0.6.0；4 files / 16 targeted tests 通过 | R3 |
| `R3` | 本地发布门禁 | `completed` | check；113 files / 827 tests；smoke；PTY；trace 0 violations；audit 0；pack/install 通过 | R4 |
| `R4` | 主线提交与 CI | `completed` | commits 1b66563/80aad6a/f325353；pipeline #348 四关全绿 | R5 |
| `R5` | Tag 与 GitLab Release | `completed` | annotated tag v0.6.0；pipeline #349 五关全绿；Release 已创建 | R6 |
| `R6` | Release 安装复验 | `completed` | 匿名 latest/pinned 字节一致；SHA 匹配；clean install 与 Fixture smoke 为 0.6.0 | 最终人工验收 |
| `R7` | Windows 0.6.1 corrective release | `completed` | tag v0.6.1；pipeline #352 五关全绿；匿名安装复验 0.6.1 | Windows 最终验收 |
| `R8` | Windows TUI corrective revision | `completed` | commit 18a9284；main #368 四关全绿；tag v0.6.2 / #369 五关全绿；匿名 latest/pinned SHA 一致；clean install 与 Fixture smoke 为 0.6.2；Provider compatibility 已排除 | Windows 最终验收 |

## 阻塞

- 无。

## 下一步

C13 只选择性继承 0.6.2 已接受 UI 基线、0.6.3 的有效非视觉修复和本轮 Windows 反馈；不继承 C12 任务列表。
