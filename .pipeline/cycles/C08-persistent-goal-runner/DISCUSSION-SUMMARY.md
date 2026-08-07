---
kind: discussion-summary
cycle: C08-persistent-goal-runner
updated: 2026-08-01
raw_discussion: .pipeline/memory/records/goal-6ad4d973ba9e/
---

# VSPi 持久 Goal Runner 讨论摘要

## 已确认需求

- Goal 需要跨进程/跨 Session 持久恢复：重启、fork、handoff 后只恢复落盘状态，不自动重新发起模型请求。
- 显式 `/goal resume` 获取当前 Session 的唯一 execution owner。
- 持久恢复与终端瀑布、Mock-first 恢复工具链一致。

## 已作决定

- 以 Goal 形态迭代：持久 Goal Runner（decision-baffd8ff）、与终端瀑布修订（decision-347778f1、decision-e51df954）、与 Mock-first 恢复修订（decision-6e1c2b53）、与带标尺 Mock-first 恢复修订（decision-ab205a44）。
- proposal revision 4 达到 proposal_ready，但仍需按修订反馈收敛。

## 接受与拒绝

- 尚未接受；delivery 状态 needs_revision，等待修订反馈。

## 纠正与分歧

- 持久 runner 与终端瀑布/Mock 恢复的边界多次调整，最终需要联合收敛。

## 未决问题

- 修订反馈的具体范围待用户明确；达成后重新提交验收。
