---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T14:48:52.631Z
dedupe_key: requirement.vspi.external-session-import
id: requirement-e9d688a0505fffb6626c54cc08f0d3ef
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: e9d688a0505fffb6626c54cc08f0d3ef3af65a535a40afbca92b52e9f2923259
source_refs:
  - locator: 2026-07-26-v0.3-external-session-import
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-26T14:48:52.631Z
---
# External conversation import

For VSPi 0.3, automatically discover local Codex conversation history and, where feasible, Claude Code history. Provide search and selection from VSPi, then copy the selected history into a new VSPi Session without mutating the source history. Codex auto-detection is the primary requirement. Important UI changes must be mocked in the terminal before implementation.
