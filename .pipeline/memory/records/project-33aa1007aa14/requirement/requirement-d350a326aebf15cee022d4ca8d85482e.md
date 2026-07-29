---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T11:43:09.236Z
dedupe_key: requirement.vspi.interactive-panel-density
id: requirement-d350a326aebf15cee022d4ca8d85482e
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: d350a326aebf15cee022d4ca8d85482ebd0e958f07f182dea12973a4ec08efbd
source_refs:
  - locator: 2026-07-26-chat-spacing-queue-icon-plan-progress
    ref: current-chat
    type: session
supersedes:
  - requirement-d964d07c3a6671ab7b3702649d3734f6
updated_at: 2026-07-26T11:43:09.236Z
---
# Interactive surface hierarchy and component layout

Preserve the approved spatial classes, original Braille Working frames, full-width command rows, visible Question descriptions, prominent ordered approval actions, and the original session branch tree drawing. Working itself is a plain, unframed status row at the end of the active message waterfall: it has no blue leading rail or user-message surface.

Render every sent user message as a full-width surface with one background row above and below its content, so N content rows occupy N+2 surface rows. Preserve the blue user marker on every content row. A message sent while the Agent is busy uses the subdued pending surface with the same vertical padding and blue marker; show only a small right-aligned `↪` queue symbol, not explanatory waiting text. Once inserted, the pending surface disappears and the content becomes an ordinary padded user message without a retained insertion label. Prefix each Agent response block with a small muted round marker so separate response segments remain easy to scan.

Expanded Plan keeps the coherent outer frame, blue title, revision/progress, and goal. Below those header rows, render only the original nested task hierarchy. Do not add current/upcoming/next-action section headings or divider frames, and do not use disclosure triangles. Show a hollow circle before the active parent such as `Question 与审批`; emphasize both that parent and its active child such as `Plan Native TTY Mock` with restrained cyan and slight bold weight. This cyan progress color must remain distinct from the blue Plan title. Following items use only a small muted marker without blue emphasis or status-label decoration. Collapsed Plan is exactly one compact title row such as `Plan · VSPi Next 交互优化`, with no extra hint row or summary body. Validate all layouts in real 80x24 and narrow native TTYs before product implementation.
