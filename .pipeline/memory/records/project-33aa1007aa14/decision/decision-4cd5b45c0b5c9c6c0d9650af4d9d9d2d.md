---
authority_role: record
confidence: confirmed
created_at: 2026-08-16T17:25:34+08:00
dedupe_key: decision.vspi.default-execution-policy-auto
id: decision-4cd5b45c0b5c9c6c0d9650af4d9d9d2d
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: 4cd5b45c0b5c9c6c0d9650af4d9d9d2d125aef6d3fea32b4b8313ac66320c22a
source_refs:
  - locator: 2026-08-16-c13-corrective-authorization
    ref: current-chat
    type: user_feedback
supersedes:
  - decision-8d34bd77ce05ef6f025ea3e659aa23fb
updated_at: 2026-08-16T17:25:34+08:00
---
# Default Execution Policy is Auto

VSPi ordinary sessions default to `Auto` so routine work does not repeatedly stop for approval. Recovery mode remains constrained to `Standard`, project policy may only reduce effective authority, and explicit Policy switching, Workflow authority gates, audit behavior, and YOLO risk acknowledgement remain unchanged.
