---
authority_role: record
confidence: confirmed
created_at: 2026-08-16T18:11:45+08:00
dedupe_key: requirement.vspi.adaptive-panel-height
id: requirement-bac47013a185807f6b4da063abced643
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: bac47013a185807f6b4da063abced643bd8b686b39ac87cfe0cd86dce9e8aeae
source_refs:
  - locator: 2026-08-16-c13-adaptive-panel-height-feedback
    ref: current-chat
    type: user_feedback
supersedes: []
updated_at: 2026-08-16T18:11:45+08:00
---
# Adaptive interactive panel height

Interactive selection panels must use available terminal height rather than hardcoded small row counts when a taller viewport is available. When one mismatch is found, audit sibling panels for the same budget/render disconnect and fix analogous cases with proportional regression tests. Preserve bounded caps and compact 24-row behavior.
