---
kind: plan
cycle: C04-live-run-control
status: closed
updated: 2026-07-25
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi Goal 运行控制

## 执行目的

以 Goal 形态交付 VSPi 运行控制体验：消息流浏览与稳定反馈、运行中消息/Working 状态与 ESC 连续性、运行控制与反馈层级、实时交互与运行反馈。

## 执行边界

本 Cycle 使用 Goal 交付（delivery `vspi-live-run-control`），无独立 milestone 计划表；以运行时行为改进与用户反馈闭环为目标，不引入新的 UI 面板或系统架构。

## 验证目标

运行中消息流可浏览且反馈稳定，ESC 中断不丢已发送消息与草稿，Working 状态与反馈层级与用户预期一致，实时交互无串扰。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `G1` | 消息流浏览与稳定反馈 | 完善运行中的消息流浏览与反馈稳定性 | 用户真实使用反馈（feedback 闭环）与行为回归 |
| `G2` | 运行中消息、Working 与 ESC 连续性 | 修复运行中消息展示、Working 状态与 ESC 中断的连续性 | ESC 中断后消息/草稿保持、Working 状态收束断言 |
| `G3` | 运行控制与反馈层级 | 修复运行控制与反馈层级的一致性 | 层级回归与用户确认 |
| `G4` | 实时交互与运行反馈 | 修复实时交互与运行反馈 | 实时交互回归 |

ID 在本 Cycle 内保持稳定；实际执行以 Goal 的 revision 迭代（revision 3 accepted）为准。
