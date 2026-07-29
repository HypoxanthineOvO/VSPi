---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T07:22:21.210Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.984b4eaf663b3721
id: feedback-1c1db9560547552fdd3dda4f2bca1295
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 1c1db9560547552fdd3dda4f2bca12954b0ae314be00a8f820df83be0383c0aa
source_refs:
  - locator: revision
    ref: actor:user:heyx
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T07:22:21.210Z
---
# Delivery feedback

Problem: Revision 8 的 hidden 模式会在思考完成后过滤整条记录，与最新交互要求冲突。
Reproduce: 将 thinking 显示模式设为 hidden。 完成一次包含 thinking 的模型回复。 观察完成后的 Transcript。
Expected: 任何模式下都保留思考记录；hidden 只隐藏正文并使用最简完成行。
Actual: Revision 8 要求 hidden 在完成后让整条思考记录退出可见 Transcript。
Context: 用户在 M1 实现过程中明确修正了 hidden 的产品语义。
