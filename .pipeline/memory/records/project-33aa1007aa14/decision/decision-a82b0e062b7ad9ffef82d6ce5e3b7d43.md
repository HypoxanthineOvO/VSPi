---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T15:06:34.551Z
dedupe_key: decision.vspi.external-session-import-detail
id: decision-a82b0e062b7ad9ffef82d6ce5e3b7d43
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: a82b0e062b7ad9ffef82d6ce5e3b7d43d50d9a6e51a83439a4e4c8c85ad0bb7d
source_refs:
  - locator: 2026-07-26-v0.3-design-decisions
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-26T15:06:34.551Z
---
# External Session import detail

Codex and Claude Code imports preserve the complete user-visible transcript, including visible tool arguments and outputs. They exclude hidden thinking, system and developer prompts, credentials, permission configuration, and internal control records. Import is always a copy into a new VSPi Session and never mutates source history.
