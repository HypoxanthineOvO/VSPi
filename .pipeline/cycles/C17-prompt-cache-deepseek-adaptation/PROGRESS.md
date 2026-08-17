---
kind: progress
cycle: C17-prompt-cache-deepseek-adaptation
plan: PLAN.md
status: in-progress
updated: 2026-08-17T23:31:21+08:00
current: M5
next: user_readme_revision
---

# 前缀缓存与 DeepSeek Harness 适配进度

## 当前状态

用户已接受 S2 的默认启用方案。M5 已固化 `1.1.0` metadata、默认配置与关闭开关，并通过完整测试、实际 package 安装和 production audit。最终审查发现并修复 Anthropic 多 block、branch-summary epoch 与大输出内存边界；用户使用 VSPi 完成 README 重写后，删除 README 静态测试并保持完整 TUI 技术规范测试。当前最终门禁为 129 files / 952 tests，本机全局 VSPi 已安装修订候选 `1.1.0`，进入 commit/tag/Release。

## 计划状态

| ID | 阶段 | 状态 | 结果或证据 |
| --- | --- | --- | --- |
| `M1` | Cache accounting、输出层级、实时吞吐、Context 恢复、价格来源与优化前基线 | `completed` | `/usage`、Speed/CH、`~Context`、assistant presentation、不可变 schedules 与 235-turn baseline 已实现；`npm run check` 和完整 `npm test` 120 files / 901 tests 通过 |
| `M2` | 稳定 prompt、按需状态查询与收益模拟 | `completed` | 报告同时展示 All-turn/Warm-turn/Latest-turn CH；长/超长 After Warm 为 99.61%、Latest 为 99.62%，保留六轮累计约 83% 作为 workload 计费口径 |
| `S1` | Cache、prompt、输出层级、吞吐与模拟报告用户审阅 | `completed` | 用户接受 Cache/UI、稳定 prompt、`continuity_status` 与 All-turn/Warm-turn/Latest-turn 模拟结果 |
| `M3` | DeepSeek anchored-standard 状态机与 wire surface | `completed` | 固定上游 persona/schema 深比较通过；三类 wire、promotion、resume、model switch、summary 与 compaction 共 25 项 harness/extension 测试通过 |
| `M4` | DeepSeek 工具执行与真实 A/B | `completed` | persistent bash/editor/Policy、真实 Pi registry、流式输出与进程树 cleanup 已验证；12 files / 74 定向测试通过；V4 Pro/Flash 四组真实 A/B、双工具和 resume 轨迹均正确 |
| `S2` | DeepSeek Feature 用户审阅 | `completed` | 用户接受 direct/relay V4 Pro/Flash 默认启用 anchored-standard，并保留 `VSPI_DEEPSEEK_HARNESS=0` 关闭开关 |
| `M5` | 集成门禁与收口 | `in_progress` | README 已由用户使用 VSPi 重写且不受静态测试约束；`1.1.0` metadata、129 files / 952 tests、实际 pack/install/bin smoke 与 production audit 已通过，开始双平台发布 |

## 阻塞

- 无技术阻塞。
- 无发布阻塞；README 修改与复核已完成。
