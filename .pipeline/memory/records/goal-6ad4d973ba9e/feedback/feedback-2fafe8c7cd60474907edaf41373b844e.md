---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T05:39:16.985Z
dedupe_key: goal.vspi-persistent-goal-runner.feedback.a44abc08a4934317
id: feedback-2fafe8c7cd60474907edaf41373b844e
kind: feedback
schema_version: '1'
scope:
  ref: vspi-persistent-goal-runner
  type: goal
semantic_hash: 2fafe8c7cd60474907edaf41373b844eca0f3cc2da742501bdabcf5b24e34773
source_refs:
  - locator: revision
    ref: actor:agent:codex-root
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T05:39:16.985Z
---
# Delivery feedback

Problem: Startup and transcript rendering use a fixed-viewport model instead of a physical terminal waterfall.
Reproduce: Run vspi in a tall terminal. Observe Splash only by scrolling upward while Composer stays at the bottom. Render more content or resize and observe content disappear before natural top-boundary displacement.
Expected: One initial viewport clear followed by a unified downward-growing waterfall; natural upward scrolling only after reaching the bottom; three viewport heights in the active render window with durable Session/Inspect history.
Actual: Synthetic full-screen linefeeds push Splash into scrollback, top padding pins Composer, and viewport clears/reset state break physical continuity.
Context: Revision 1 responds to user acceptance feedback dated 2026-08-01.
