---
kind: discussion-summary
cycle: C04-live-run-control
updated: 2026-07-25
raw_discussion: .pipeline/memory/records/goal-33f80bd2158a/
---

# VSPi Goal 运行控制讨论摘要

## 已确认需求

- 运行中消息流可浏览且反馈稳定。
- ESC 中断保持连续性：不丢失已发送用户消息、未发送草稿与部分 thinking/text/tool。
- Working 状态与反馈层级需要与用户预期一致。

## 已作决定

- 以 Goal 形态迭代修复，按用户反馈闭环推进：
  - 完善消息流浏览与稳定反馈（decision-57219f2f）。
  - 修复运行中消息、Working 状态与 ESC 连续性（decision-af0dffd0）。
  - 修复运行控制与反馈层级（decision-c333e5ef）。
  - 修复实时交互与运行反馈（decision-f0677f2e）。

## 接受与拒绝

- 用户通过反馈闭环接受各次修订；最终 revision 3 被接受。

## 纠正与分歧

- 运行控制与反馈层级先后调整，最终以"层进式交互"语义收敛。

## 未决问题

- 持久 Goal Runner（跨进程/跨 Session 恢复）留待 C08-persistent-goal-runner。
