---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T12:07:03.753Z
dedupe_key: cycle.vspi-terminal-mock-recovery.feedback.b0f8b724ad3bebdd
id: feedback-40a6180c65bcf925d1cd8c783fb936db
kind: feedback
schema_version: '1'
scope:
  ref: vspi-terminal-mock-recovery
  type: cycle
semantic_hash: 40a6180c65bcf925d1cd8c783fb936dbd78beaa65ec3c06515a842c0b5c92236
source_refs:
  - locator: stone.reject
    ref: actor:user:heyx
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T12:07:03.753Z
---
# Delivery feedback

Problem: Question surface is visually cramped and competes with retained transcript and notification content.
Reproduce: Run npm run mock:terminal -- --rows 40 --cols 80 Submit trace long and then mock question Inspect the Question frame where a retained mock response line remains visually dominant and the Question header, prompt, progress label, and options are tightly packed
Expected: Resume behavior remains unchanged. Question has clear vertical separation from retained transcript and Composer, options have a blank row between them, title/progress/prompt groups have more breathing room, and notifications no longer displace or visually compete with Question content.
Actual: A retained mock response line creates an occlusion-like impression above Question, option rows and Question metadata are tightly packed, and the single-line notification treatment interferes with panel hierarchy.
Context: User manually reviewed the 80x40 terminal Mock. Resume is approximately correct; the rejection is scoped to Question layout density and notification presentation.
