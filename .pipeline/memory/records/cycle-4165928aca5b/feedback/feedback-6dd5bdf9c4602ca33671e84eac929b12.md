---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T03:58:33.835Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.55619d25e5f5bb42
id: feedback-6dd5bdf9c4602ca33671e84eac929b12
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 6dd5bdf9c4602ca33671e84eac929b12c9cfff621c7e1d88ce80663d8ec1c9a3
source_refs:
  - locator: revision
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T03:58:33.835Z
---
# Delivery feedback

Problem: Normal Pi startup crashes because Fixture model identity is persisted into shared runtime defaults and restored as a Pi model.
Reproduce: Run VSPi with the Fixture backend and persist an Effort or model-related default. Run npm run dev without Fixture mode. Observe PiBackend.selectModel reject fixture/offline-fixture during VspiApp.start.
Expected: Normal Pi startup keeps a currently available Pi model; stale or foreign-backend defaults produce a bounded warning and do not terminate startup.
Actual: VSPi restores fixture/offline-fixture through PiBackend.selectModel and exits immediately after the Splash with an uncaught error.
Context: Global runtime-defaults.json is shared across backends and currently contains the Fixture identity. Revision 5 must prevent Fixture model persistence, tolerate already polluted defaults, and pass a real DeepSeek PTY conversation capture before acceptance.
