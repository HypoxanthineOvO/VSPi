---
kind: discussion-summary
cycle: C08-persistent-goal-runner
updated: 2026-08-09
raw_discussion: .pipeline/memory/records/goal-6ad4d973ba9e/
---

# VSPi 持久 Goal Runner 讨论摘要

## 已确认需求

- Goal 需要跨进程/跨 Session 持久恢复：重启、fork、handoff 后只恢复落盘状态，不自动重新发起模型请求。
- 显式 `/goal resume` 获取当前 Session 的唯一 execution owner。
- 持久恢复与终端瀑布、Mock-first 恢复工具链一致。

## 已作决定

- 以 Goal 形态迭代：持久 Goal Runner（decision-baffd8ff）、与终端瀑布修订（decision-347778f1、decision-e51df954）、与 Mock-first 恢复修订（decision-6e1c2b53）、与带标尺 Mock-first 恢复修订（decision-ab205a44）。
- revision 4 的具体反馈已定位为 Terminal Inspector 可视坐标壳；当前实现已覆盖，并以 fresh trace 复核。
- Pi 0.84 改变 main-screen reset 语义；Resume epoch 必须保留“首帧但不清屏”的零尺寸 render state。

## 接受与拒绝

- 用户要求完成并收口 C08；修订反馈、实现与验证证据核对后关闭语义 Cycle。
- legacy Delivery 状态不回写，保留为历史快照。

## 纠正与分歧

- 持久 runner 与终端瀑布/Mock 恢复的边界多次调整，最终需要联合收敛。

## 未决问题

- 无。
