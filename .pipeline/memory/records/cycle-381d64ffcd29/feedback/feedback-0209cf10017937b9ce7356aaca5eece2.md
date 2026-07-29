---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T13:52:06.579Z
dedupe_key: cycle.vspi-v0-1-0-usability.feedback.00b9bb4cff9999bd
id: feedback-0209cf10017937b9ce7356aaca5eece2
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-1-0-usability
  type: cycle
semantic_hash: 0209cf10017937b9ce7356aaca5eece2929bca938324ace21388b6088ab6b727
source_refs:
  - locator: revision
    ref: actor:user:workspace-owner
    type: user_feedback
supersedes: []
updated_at: 2026-07-23T13:52:06.579Z
---
# Delivery feedback

Problem: Revision 0 只修补局部 TUI，仍保留静默 Fixture、Demo Provider/Question/Update，缺少真实 Session、配置、Local Plan、压缩和 Prompt Profile，无法形成可长期使用的版本。
Reproduce: 按默认方式启动并观察真实后端失败时自动进入 Fixture。 打开 Model、Provider、Question、Update、Plan 与 Settings，确认多项操作只改变 Fixture 或标签。 恢复、新建或切换 Session，并检查历史 hydration、Model/Effort、Plan binding 和草稿恢复。
Expected: v0.1.0 应成为诚实的本地日用检查点，真实能力形成完整链路，未实现能力从生产入口删除，并为 v0.2.0 的 Workflow 与公共更新留下稳定边界。
Actual: Revision 0 的三个 Milestone 范围过窄，且把多个 Demo/Fixture 表面继续当作可交付功能。
Context: 2026-07-23 的后续规划已确认 Provider overlay、Local Plan、压缩 profile、模型 Prompt Profile、官方 Harness 文档、版本策略以及无 TUI update 命令。
