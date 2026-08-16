---
authority_role: record
confidence: confirmed
created_at: 2026-08-16T18:35:25+08:00
dedupe_key: preference.vspi.prefer-upstream-render-architecture
id: preference-43221dda2fae2a29a42d6bab24ac5bb0
kind: preference
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: 43221dda2fae2a29a42d6bab24ac5bb041904a51cda026065fefb637db1edfaf
source_refs:
  - locator: 2026-08-16-c14-official-render-direction
    ref: current-chat
    type: user_feedback
supersedes:
  - preference-9ba9d29db33d84a5d75897791339c595
updated_at: 2026-08-16T18:35:25+08:00
---
# Prefer upstream render architecture

Default to Pi official render/layout scheduling, differential output, input, cursor, scrolling, and component APIs end to end. Avoid VSPi-owned whole-page render pipelines or cross-frame caches. Keep only product-specific presentation and narrowly scoped caches with explicit invalidation where upstream has no equivalent; custom rendering requires measured evidence and regression coverage.
