---
kind: cycle-index
status: active
---

# Cycle 索引

## Active Cycles

| Cycle | 目的 | 状态 | 当前项 | 下一步 |
| --- | --- | --- | --- | --- |
| [C07-subagent-teams](C07-subagent-teams/PLAN.md) | Subagent/Teammate 完整计划（m1-m5） | active | m1-contract-and-scheduler | 等待交付审批后按 m1→m5 执行 |
| [C08-persistent-goal-runner](C08-persistent-goal-runner/PLAN.md) | 持久 Goal Runner 与终端瀑布修订 | active | G3 修订反馈闭环 | 按 needs_revision 反馈修订 proposal 后重新提交 |
| [C09-ui-rendering-fixes](C09-ui-rendering-fixes/PLAN.md) | 终端渲染与历史浏览修复（Question 空行 / Sessions 居中 / 历史滚动） | active | M3 历史滚动渲染层 | 深挖 Inspect 渲染层遗留或转后续候选 |

## Closed Cycles

| Cycle | 名称 | 状态 | 关联 Delivery | 版本 |
| --- | --- | --- | --- | --- |
| [C01-tui-v1](C01-tui-v1/SUMMARY.md) | VSPi TUI v1 主线 | closed | vspi-tui-v1 | v0.1.0 |
| [C02-v0-1-0-usability](C02-v0-1-0-usability/SUMMARY.md) | VSPi v0.1.0 本地日用版本 | closed | vspi-v0-1-0-usability | v0.1.0 |
| [C03-v0-2-0-workflow-integration](C03-v0-2-0-workflow-integration/SUMMARY.md) | VSPi v0.2.0 Workflow 集成 | closed | vspi-v0-2-0-workflow-integration | v0.2.0 |
| [C04-live-run-control](C04-live-run-control/SUMMARY.md) | VSPi Goal 运行控制 | closed | vspi-live-run-control | v0.2.0 |
| [C05-subagent-teams-goal](C05-subagent-teams-goal/SUMMARY.md) | Subagent 与 Teammate 能力（Goal 交付） | closed | vspi-subagent-teams-goal | 0.3.11 |
| [C06-terminal-mock-recovery](C06-terminal-mock-recovery/SUMMARY.md) | 终端 Mock 与 Recovery 工具链 | closed | vspi-terminal-mock-recovery | 0.3.x |

## 说明

- 历史 Cycle 依据已接受 Delivery 对象重建，遵循决策 `decision-742e1882`（不捏造接受记录）。
- 未完成的 Delivery（vspi-subagent-teams、vspi-persistent-goal-runner）保持 active，未标记完成。
