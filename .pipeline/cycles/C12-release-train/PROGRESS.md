---
kind: progress
cycle: C12-release-train
plan: PLAN.md
status: active
updated: 2026-08-09T16:56:25+08:00
current: R7
next: R7 完成后等待最终验收
---

# VSPi v0.6.0 Release Train 进度

## 当前状态

用户在 Windows 上复验 v0.6.0 时发现 named-pipe lease 启动失败；正在发布 0.6.1 corrective release。

## 完整计划状态

| ID | 阶段 | 状态 | 当前结果 / 证据 | 下一步 |
| --- | --- | --- | --- | --- |
| `R1` | 发布边界与 Goal 建立 | `completed` | C12、项目索引与 session focus 已建立；真实发布为 v0.6.0 | R2 |
| `R2` | 完整性与版本准备 | `completed` | 128 Records 可重建；版本三处为 0.6.0；4 files / 16 targeted tests 通过 | R3 |
| `R3` | 本地发布门禁 | `completed` | check；113 files / 827 tests；smoke；PTY；trace 0 violations；audit 0；pack/install 通过 | R4 |
| `R4` | 主线提交与 CI | `completed` | commits 1b66563/80aad6a/f325353；pipeline #348 四关全绿 | R5 |
| `R5` | Tag 与 GitLab Release | `completed` | annotated tag v0.6.0；pipeline #349 五关全绿；Release 已创建 | R6 |
| `R6` | Release 安装复验 | `completed` | 匿名 latest/pinned 字节一致；SHA 匹配；clean install 与 Fixture smoke 为 0.6.0 | 最终人工验收 |
| `R7` | Windows 0.6.1 corrective release | `in_progress` | 根因：Windows 上 `net.listen` 需 named pipe；修复已完成，830 tests 通过 | 0.6.1 tag/Release 与 Windows 复验 |

## 阻塞

- 无。

## 下一步

用户用 0.6.1 在 Windows 安装运行并接受结果后关闭 C12。
