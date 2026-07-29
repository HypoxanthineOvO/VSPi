---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T09:48:25.207Z
dedupe_key: feedback.vspi.status-layout-fixed-tracks
id: feedback-36a85019af5becf313cfafda0ffc58bb
kind: feedback
schema_version: '1'
scope:
  ref: VSPi
  type: project
semantic_hash: 36a85019af5becf313cfafda0ffc58bb158396af4c9142bc7d0a1d33d1815ff9
source_refs:
  - locator: 2026-07-26-working-plan-status-clarification
    ref: current-chat
    type: session
supersedes:
  - feedback-db31efd26e2215b19a90826d64584e69
updated_at: 2026-07-26T09:48:25.207Z
---
# Bottom status layout

Keep the bottom status compact but split it into two left/right-aligned rows. First row: coral-red model and effort plus orange Context on the left, light-green working directory on the right. Second row: subdued Policy and boundary on the left, input/output token counts and emphasized cost on the right. Do not show the Git branch by default. A thin Context progress line may remain below. Preserve coherent truncation and narrow-terminal fallback.
