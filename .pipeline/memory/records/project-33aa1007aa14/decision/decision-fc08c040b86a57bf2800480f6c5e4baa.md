---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T15:06:34.551Z
dedupe_key: decision.vspi.skill-install-default-scope
id: decision-fc08c040b86a57bf2800480f6c5e4baa
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: fc08c040b86a57bf2800480f6c5e4baaf21ea72b2ac4296a54646d8245bc6858
source_refs:
  - locator: 2026-07-26-v0.3-design-decisions
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-26T15:06:34.551Z
---
# Skill install default scope

VSPi 0.3 Skill management installs to User scope by default. The confirmation screen may switch to Project scope only for a trusted project.
