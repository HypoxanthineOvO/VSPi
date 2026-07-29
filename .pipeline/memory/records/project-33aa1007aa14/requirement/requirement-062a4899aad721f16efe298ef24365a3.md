---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T10:22:55.228Z
dedupe_key: requirement.vspi.question-interaction-depth
id: requirement-062a4899aad721f16efe298ef24365a3
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
semantic_hash: 062a4899aad721f16efe298ef24365a338bcd8e6491f2efb3fec0c2408cf9845
source_refs:
  - locator: 2026-07-26-native-tty-component-feedback
    ref: current-chat
    type: session
supersedes:
  - requirement-af8bfc3a57f131729a2179756a1200d3
updated_at: 2026-07-26T10:22:55.228Z
---
# Question interaction depth and placement

Retain the VSPi frame and render Question directly above the composer while keeping relevant conversation context. Every option description must remain visible without requiring focus or navigation. Use stable label and description columns when width permits, and a deliberate two-line fallback on narrow terminals. Visually distinguish question steps with stronger segmented or framed labels while preserving completed, current, pending, and review states. Prevent accidental wrapping and clipping in prompts, options, descriptions, and footer hints.
