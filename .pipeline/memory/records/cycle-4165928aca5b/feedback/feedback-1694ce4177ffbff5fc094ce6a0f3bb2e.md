---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T07:10:06.304Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.32820b10def09cf8
id: feedback-1694ce4177ffbff5fc094ce6a0f3bb2e
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 1694ce4177ffbff5fc094ce6a0f3bb2eaa04923e93c48eeafe39e0615b6d0999
source_refs:
  - locator: delivery.reject
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T07:10:06.304Z
---
# Delivery feedback

Problem: showThinking is a binary visibility setting while every live and hydrated thinking message independently defaults to collapsed, so enabling display still reports a collapsed record instead of selecting an explicit display result.
Reproduce: Enable display thinking in Settings. Trigger a real thinking response and observe that the transcript shows only a collapsed thinking header. Restart or hydrate history and observe the same hard-coded collapsed state.
Expected: Replace the boolean with hidden, collapsed, and expanded display modes. Hidden shows one transient thinking-in-progress row only while active and removes it after completion; collapsed retains the record header; expanded retains the header and body. Default to collapsed and migrate legacy false to hidden and true to collapsed.
Actual: showThinking only controls filtering, while both live thinking_start and hydrated thinking blocks set collapsed=true.
Context: Final acceptance review of vspi-v0-2-0-workflow-integration revision 7.
