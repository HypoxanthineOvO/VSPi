---
kind: progress
cycle: C17-prompt-cache-deepseek-adaptation
plan: PLAN.md
status: completed
updated: 2026-08-17T23:51:00+08:00
current: none
next: none
---

# 前缀缓存与 DeepSeek Harness 适配进度

## 当前状态

C17 已完成并发布为 VSPi 1.1.0。用户接受默认启用方案并使用本机 VSPi 完成 README 重写；README 不再受静态测试约束。最终门禁为 129 files / 952 tests，GitLab/GitHub tag 与 Release 均已发布，两个 latest 下载资产内容一致且 SHA-256 已验证。

## 计划状态

| ID | 阶段 | 状态 | 结果或证据 |
| --- | --- | --- | --- |
| `M1` | Cache accounting、输出层级、实时吞吐、Context 恢复、价格来源与优化前基线 | `completed` | `/usage`、Speed/CH、`~Context`、assistant presentation、不可变 schedules 与 235-turn baseline 已实现；`npm run check` 和完整 `npm test` 120 files / 901 tests 通过 |
| `M2` | 稳定 prompt、按需状态查询与收益模拟 | `completed` | 报告同时展示 All-turn/Warm-turn/Latest-turn CH；长/超长 After Warm 为 99.61%、Latest 为 99.62%，保留六轮累计约 83% 作为 workload 计费口径 |
| `S1` | Cache、prompt、输出层级、吞吐与模拟报告用户审阅 | `completed` | 用户接受 Cache/UI、稳定 prompt、`continuity_status` 与 All-turn/Warm-turn/Latest-turn 模拟结果 |
| `M3` | DeepSeek anchored-standard 状态机与 wire surface | `completed` | 固定上游 persona/schema 深比较通过；三类 wire、promotion、resume、model switch、summary 与 compaction 共 25 项 harness/extension 测试通过 |
| `M4` | DeepSeek 工具执行与真实 A/B | `completed` | persistent bash/editor/Policy、真实 Pi registry、流式输出与进程树 cleanup 已验证；12 files / 74 定向测试通过；V4 Pro/Flash 四组真实 A/B、双工具和 resume 轨迹均正确 |
| `S2` | DeepSeek Feature 用户审阅 | `completed` | 用户接受 direct/relay V4 Pro/Flash 默认启用 anchored-standard，并保留 `VSPI_DEEPSEEK_HARNESS=0` 关闭开关 |
| `M5` | 集成门禁与收口 | `completed` | commit `eb0edf7`、tag `v1.1.0` 与双平台 Release 已发布；3 个资产齐全，latest SHA-256 为 `17fd11362494dc6ebcd2e9cae404b974e1f3681a3e29680eee2707a4558bf199` |

## 阻塞

- 无。
