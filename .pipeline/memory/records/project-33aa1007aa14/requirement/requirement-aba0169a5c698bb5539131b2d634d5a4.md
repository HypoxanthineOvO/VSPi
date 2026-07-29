---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T10:44:56.352Z
dedupe_key: requirement.vspi.interactive-panel-density
id: requirement-aba0169a5c698bb5539131b2d634d5a4
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: aba0169a5c698bb5539131b2d634d5a49a912a55536505dc3464b329c291ae78
source_refs:
  - locator: 2026-07-26-working-queue-plan-mock-feedback
    ref: current-chat
    type: session
supersedes:
  - requirement-b5632341374b9eda4562c59c56e1e5e9
updated_at: 2026-07-26T10:44:56.352Z
---
# Interactive surface hierarchy and component layout

Preserve the approved spatial classes, user-message background and blue leading marker, original Braille Working frames, full-width command rows, visible Question descriptions, prominent ordered approval actions, and the original session branch tree drawing. Working itself is a plain, unframed status row at the end of the active message waterfall: it has no blue leading rail or user-message surface. A message sent while the Agent is busy appears immediately below Working as a subdued full-width pending user surface with the blue user marker and a right-aligned waiting label. Once inserted at the next model call, that pending surface disappears and the content becomes an ordinary user message in the waterfall without a retained insertion label.

Expanded Plan uses one coherent outer frame with a colored title, revision/progress, goal, visibly separated current/upcoming/next-action sections, and nested content where needed. Do not use a disclosure triangle as the Plan affordance and do not flatten all rows into one undifferentiated list. Collapsed Plan is exactly one compact title row such as `Plan · VSPi Next 交互优化`, with no extra hint row or summary body. Validate state transitions and Plan layouts in real 80x24 and narrow native TTYs before product implementation.
