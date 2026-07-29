---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T10:22:55.228Z
dedupe_key: feedback.vspi.status-layout-fixed-tracks
id: feedback-ab1742539cee36f0f27b27c36c48aad2
kind: feedback
schema_version: '1'
scope:
  ref: VSPi
  type: project
semantic_hash: ab1742539cee36f0f27b27c36c48aad2abdaa7d9a5dbc85720a4f43cf1039ba0
source_refs:
  - locator: 2026-07-26-native-tty-component-feedback
    ref: current-chat
    type: session
supersedes:
  - feedback-c9b3e339c6c3f13935ced61f6fe90114
updated_at: 2026-07-26T10:22:55.228Z
---
# Bottom status layout

Use two compact left/right-aligned rows. First row: coral-red model and effort plus orange Context on the left, light-green working directory on the right. Context displays used/total before percentage. Second row: show only the current Policy on the left; omit the redundant `Host` boundary label. Show input/output token counts and emphasized cost on the right. Do not show Git branch or a Context progress bar by default. Preserve coherent truncation and narrow-terminal fallback.
