---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T12:00:03.939Z
dedupe_key: preference.vspi.ui-native-mock-first
id: preference-afdb1404971fcf8baed40924374a0d1e
kind: preference
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: afdb1404971fcf8baed40924374a0d1e8c33f96ade6f4e1b56c3fecc136a905b
source_refs:
  - locator: 2026-07-26-native-tty-mock-process-accepted
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-26T12:00:03.939Z
---
# Native TTY mock-first UI workflow

When the user reports a VSPi interface problem or requests an interface change, first create or revise an executable Native TTY Mock using the project terminal primitives. Cover the relevant interaction states and validate at 80x24 plus a narrow terminal such as 64 columns. Present the mock for iterative user review and do not begin product implementation until the user explicitly approves the mock. Browser composites may supplement the review but are not the primary acceptance artifact for remote terminal work.
