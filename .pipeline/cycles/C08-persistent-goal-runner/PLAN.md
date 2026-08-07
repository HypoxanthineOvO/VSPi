---
kind: plan
cycle: C08-persistent-goal-runner
status: active
updated: 2026-08-01
progress: PROGRESS.md
execution: EXECUTION.md
---

# VSPi 持久 Goal Runner

## 执行目的

实现 VSPi 持久 Goal Runner 与相关终端瀑布修订：Goal 的跨进程/跨 Session 持久恢复能力，以及与之配套的终端瀑布与 Mock-first 恢复工具。这是当前进行中的 Cycle，仍处于 needs_revision 状态。

## 执行边界

本 Cycle 以 Goal 形态推进（delivery `vspi-persistent-goal-runner`），覆盖持久 runner 生命周期与终端瀑布恢复；不引入新的 Plan/Goal 语义冲突。

## 验证目标

Goal 在重启、fork、handoff 后只恢复落盘状态而不自动重新发起模型请求；显式 `/goal resume` 获取唯一 execution owner；与终端瀑布恢复（Mock-first）一致。

## 完整计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `G1` | 持久 Goal Runner | 实现 Goal 跨进程持久化与唯一 execution owner 恢复 | 重启/fork/handoff 恢复测试；owner lease 原子性 |
| `G2` | 终端瀑布与 Mock-first 恢复 | 终端瀑布恢复与 Mock-first 恢复修订一致 | Mock 几何断言与恢复轨迹回归 |
| `G3` | 修订反馈闭环 | 根据用户修订反馈（needs_revision）收敛 proposal | revision 迭代与 proposal_ready 达成 |

ID 在本 Cycle 内保持稳定；当前 revision 4 处于 proposal_ready / needs_revision。
