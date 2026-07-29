---
authority_role: record
confidence: confirmed
created_at: 2026-07-29T16:00:00.000+08:00
dedupe_key: requirement.vspi.test-validation-discipline
id: requirement-41375d415c1c7b031bdc0aa1f8bddb81
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: 41375d415c1c7b031bdc0aa1f8bddb81c1346e63ce1e9498c79dfb79241c9d93
source_refs:
  - locator: 2026-07-29-testing-debugging-maintain
    ref: current-chat
    type: session
  - locator: repository-debug-playbook
    ref: Docs/testing-and-debugging.md
    type: file
supersedes: []
updated_at: 2026-07-29T16:00:00.000+08:00
---
# Test and build discipline

For every new feature or Bug fix, begin with the smallest deterministic reproduction and add the regression at the lowest layer that proves the contract. Expand to application, backend, PTY, full-suite, package, and release checks only when the affected boundary requires them. UI continuity assertions must verify ordering, coordinates, viewport, cursor, resize behavior, and historical reachability rather than only checking that text appeared.

Do not rebuild after every source edit. Use targeted Vitest and npm run check during the source loop. Run npm run build only when validating dist/index.js, the resolved local vspi command, package contents, or a final delivery checkpoint. npm test already invokes npm run build through pretest, so do not run a redundant build immediately before it. Record which proportional checks ran and disclose any final checks that did not run.
