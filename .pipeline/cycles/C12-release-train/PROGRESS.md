---
kind: progress
cycle: C12-release-train
plan: PLAN.md
status: active
updated: 2026-08-11T19:40:31+08:00
current: R8
next: 构造并验证 R8-only 0.6.2 提交，排除 Provider request compatibility 改动
---

# VSPi v0.6.0 Release Train 进度

## 当前状态

0.6.1 corrective release 已完成并通过公开资产复验；Windows 最终验收发现的三项 TUI 回归已在 R8 本地修复并通过完整门禁，用户已授权仅发布 R8 为 0.6.2。

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
| `R8` | Windows TUI corrective revision | `in_progress` | fullscreen 不再使用 regular history rebase；Auto 不因恢复元数据写入失败而回滚；模型按代际/同代总单价排序；114 files / 836 tests、PTY 11 tests、check/build/smoke/audit 全绿；R8-only 0.6.2 已授权 | 构造隔离提交、重跑门禁并发布 |

## 阻塞

- 无。

## 下一步

只推进新的 0.6.2 corrective release，不重放 R1-R7；选择性排除未归属的 Provider request compatibility 改动。
