---
authority_role: record
confidence: confirmed
created_at: 2026-07-24T14:34:50.382Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.8c4e651de718eafe
id: feedback-717a9c188e0da4bad1c683a4c5ce2e53
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 717a9c188e0da4bad1c683a4c5ce2e531a7193bacef11b14ea90ba202b9bdb51
source_refs:
  - locator: revision
    ref: actor:user:workspace-user
    type: user_feedback
supersedes: []
updated_at: 2026-07-24T14:34:50.382Z
---
# Delivery feedback

Problem: 当前构建的真实交互可用性不达标：工具调用高频失败，ESC 无法中断生成，用户消息高亮过强且违和。
Reproduce: 启动当前成功构建。 发送会触发工具调用的消息并观察失败。 生成中按 ESC。 发送普通用户消息并观察整块高亮。
Expected: 工具调用稳定执行并给出可诊断失败；ESC 立即中断当前生成或工具；用户消息仅以小型背景色块作轻量标记。
Actual: 工具调用频繁失败；ESC 无反应；用户消息使用大面积高亮背景。
Context: C2 M1 第一轮 Stone 的真实试用验收反馈；真实 session 进一步确认 bash timeout 秒/毫秒单位错配。
