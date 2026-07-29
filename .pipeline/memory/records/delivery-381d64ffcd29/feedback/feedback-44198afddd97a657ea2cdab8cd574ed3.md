---
authority_role: record
confidence: confirmed
created_at: 2026-07-24T04:47:56.123Z
dedupe_key: feedback.vspi.status-layout-fixed-tracks
id: feedback-44198afddd97a657ea2cdab8cd574ed3
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-1-0-usability
  type: delivery
semantic_hash: 44198afddd97a657ea2cdab8cd574ed358fac708901ca3cadbbbcac3207cf44a
source_refs:
  - locator: 2026-07-24-status-layout-screenshot
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-24T04:47:56.123Z
---
# Status layout regression

The current TUI screenshot violates the approved two-line status hierarchy. The first row must read Model, Effort, Context in that order, with Effort visually adjacent to Model. Backend must not be inserted between Model and Effort. The second row must read Path, Token, Cost. Context, Token, and Cost need stable right-side tracks so long values do not crowd or shift each other; narrow terminals must use an explicit safe fallback rather than mixed ordering. This is an implementation defect to correct during the active UI refinement work, not a rejection of the accepted M4 Policy contract.
