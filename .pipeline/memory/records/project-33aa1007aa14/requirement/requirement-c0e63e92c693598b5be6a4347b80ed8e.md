---
authority_role: record
confidence: confirmed
created_at: 2026-08-16T20:29:54+08:00
dedupe_key: requirement.vspi.general-tui-frame-pacing
id: requirement-c0e63e92c693598b5be6a4347b80ed8e
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: c0e63e92c693598b5be6a4347b80ed8e1de1cb292cbf06f11673d6df27668d8c
source_refs:
  - locator: 2026-08-16-c14-general-frame-pacing
    ref: current-chat
    type: user_feedback
supersedes: []
updated_at: 2026-08-16T20:29:54+08:00
---
# Bound TUI refresh rate generically

VSPi must bound ordinary TUI refresh cadence generically across terminal frontends rather than use a VSCode-only behavior branch. Streaming, activity, and viewport-scroll render requests should be coalesced to a modest frame rate because a terminal UI does not require high FPS, while focused keyboard/cursor immediate rendering remains responsive.
