---
kind: discussion-summary
cycle: C07-subagent-teams
updated: 2026-08-09
raw_discussion: .pipeline/memory/records/cycle-4ef2b8ba1fb8/
---

# VSPi Subagent 与项目 Teammate 完整计划讨论摘要

## 已确认需求

- Task Agent 是独立内存子 Session（默认最小上下文），Teammate 是受信项目内的持久角色（lane Session）。
- 运行硬上限：深度 5、累计 128、全局并发 16；corrective Plan 采用保守默认 3/12/16，取消与权限拒绝 fail closed。
- 模型策略：当前 Provider 的 Agent Pool 映射实际模型；额度耗尽才尝试 fallback，且保持 sticky。

## 已作决定

- 完整计划（m1-m5）以 delivery `vspi-subagent-teams`（plan 模式）提出，等待交付审批。
- 决策 `decision-76faed9d`（VSPi Subagent 与项目 Teammate 能力）作为计划记录。
- 已有 Goal 交付（C05、delivery `vspi-subagent-teams-goal`）确认方向，避免重复。
- 用户要求在启动 C07 前先审核设计；审计期间不修改 Agent 源码。
- revision 0 不应直接批准，先按当前实现重写/缩减 Plan，并前置安全 Stone。
- 用户确认“按你的来”，授权采用 corrective Plan 方向并由 Agent 选择保守默认策略。
- 新 Plan 默认 3/12/16、硬上限 5/128/16；完整父历史不跨 Provider；Task Agent 恢复 in-memory；持久授权改用 typed action。

## 接受与拒绝

- 用户明确“接收并继续”，`S1 security-contract-review` 已接受。
- 用户已接受 `S2 agent-runtime-review`，确认 M2/M3 Runtime 与验证证据。
- 用户已接受 S1/S2/S3；M5 最终门禁通过，C07 已关闭。

## 纠正与分歧

- 旧 Progress 称 m1 尚未开始，但当前源码已经具备 scheduler、Task Agent runtime、Teammate lane/routing/fallback 与 `/agents` UI。
- 旧 Plan 的 5/128/16 与 production 3/12/16 不一致；“可配置”也仅实现 concurrency。
- 原计划把安全统一放在 m5，无法阻止前序 milestone 在不安全合同上被接受。

## 未决问题

- 无。

## 关闭后询问

- 用户原文：“这个有发布吗？发布版本现在是咋样的？”
- 核对结果：C07 未发布；源码版本仍为 `0.3.11`，最新本地 tag 为 `v0.3.11`，当前工作区处于该 tag 后 3 个提交且含未提交改动的开发态；公开 npm registry 无 `vspi` 包。
