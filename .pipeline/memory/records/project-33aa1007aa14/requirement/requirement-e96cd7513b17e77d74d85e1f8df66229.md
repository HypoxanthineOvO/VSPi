---
authority_role: record
confidence: confirmed
created_at: 2026-08-11T11:35:37.000Z
dedupe_key: requirement.vspi.policy-switch-runtime-authority
id: requirement-e96cd7513b17e77d74d85e1f8df66229
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: e96cd7513b17e77d74d85e1f8df662297e4e4fd74d708edb308d1c5396c13d54
source_refs:
  - locator: 2026-08-11-c12-r8-windows-tui-feedback
    ref: current-chat
    type: user_feedback
supersedes: []
updated_at: 2026-08-11T11:35:37.000Z
---
# Policy switch runtime authority

用户在 TUI 选择新的 execution Policy 后，runtime 切换成功即视为生效。Session 恢复元数据属于可选持久化：写入失败必须显示 warning，但不得回滚或把本次 Auto 切换报告为失败。重复选择同一 Policy 应保持幂等。
