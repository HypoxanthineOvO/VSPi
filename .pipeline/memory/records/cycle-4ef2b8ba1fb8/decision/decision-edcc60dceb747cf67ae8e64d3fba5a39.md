---
authority_role: record
confidence: confirmed
created_at: 2026-08-09T06:22:00.000Z
dedupe_key: cycle.vspi-subagent-teams.plan
id: decision-edcc60dceb747cf67ae8e64d3fba5a39
kind: decision
schema_version: '1'
scope:
  ref: vspi-subagent-teams
  type: cycle
secret_refs: []
semantic_hash: edcc60dceb747cf67ae8e64d3fba5a39843c506337929dd2f4ac5810627e4013
source_refs:
  - locator: .pipeline/cycles/C07-subagent-teams/SECURITY-CONTRACT.md
    ref: cycle:C07-subagent-teams:S1
    type: user_feedback
  - locator: .pipeline/cycles/C07-subagent-teams/RUNTIME-REVIEW.md
    ref: cycle:C07-subagent-teams:S2
    type: user_feedback
  - locator: .pipeline/cycles/C07-subagent-teams/UI-REVIEW.md
    ref: cycle:C07-subagent-teams:S3
    type: user_feedback
supersedes:
  - decision-76faed9d5251e6a4aa4a5ae9a4daefa5
updated_at: 2026-08-09T06:22:00.000Z
---
# Subagent 与 Teammate corrective 安全合同

C07 接受并落实以下长期边界：

- 默认 scheduler limits 为 depth 3 / tree 12 / concurrency 16；可信项目 ceiling 为 5 / 128 / 16。默认 run budget 为 120,000 tokens / 900 秒，tree budget 为 500,000 tokens / 20 USD。
- Task Agent 使用 in-memory Session，默认只接收 task 与 explicit context。完整父历史只能发送到相同 Provider；跨 Provider 即使已授权也只能发送 task 与 explicit context。
- 所有 child Bash 都是 writer；Bash/edit/write 共享 workspace 跨进程 lease，`.vspi` 控制目录在 child Bash sandbox 中只读。root cancellation 级联到 active 与 queued descendants。
- Teammate identity/system prompt 与 tool ceiling 来自 trusted project config；持久 mutation 和 required override 只走 typed `/agents` action。required 仅由当前 task epoch 中正确 Teammate 的成功 run 满足。
- Teammate prompt/reset/model switch 使用跨进程 ownership，并在 lease 后刷新 config 和最近 Session；quota fallback sticky 持久化失败必须回滚。
- `/agents` 使用 bounded/redacted Timeline 展示结构化 audit、budget、authority scope 与 lane owner；只有真实持久 lane history 才称为 Transcript，Task audit 不显示 Session 路径。

该决定替代 revision 0 中关于 5/128 默认、Task Session 留存、自然语言授权与 preview-as-Transcript 的旧语义；旧记录继续保留为历史。
