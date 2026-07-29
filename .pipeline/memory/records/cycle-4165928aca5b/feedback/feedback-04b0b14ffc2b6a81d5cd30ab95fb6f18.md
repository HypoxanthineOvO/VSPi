---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T03:57:25.939Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.5d5692392e6ba9a7
id: feedback-04b0b14ffc2b6a81d5cd30ab95fb6f18
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 04b0b14ffc2b6a81d5cd30ab95fb6f18e53fe2438a01798e8e2993b7c856e19c
source_refs:
  - locator: delivery.reject
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T03:57:25.939Z
---
# Delivery feedback

Problem: Normal Pi startup crashes because Fixture model identity is persisted into shared runtime defaults and restored as a Pi model.
Reproduce: Run VSPi with the Fixture backend and persist an Effort or model-related default. Run npm run dev without Fixture mode. Observe PiBackend.selectModel reject fixture/offline-fixture during VspiApp.start.
Expected: Normal Pi startup keeps a currently available Pi model; stale or foreign-backend defaults produce a bounded warning and do not terminate startup.
Actual: VSPi restores fixture/offline-fixture through PiBackend.selectModel and exits immediately after the Splash with an uncaught error.
Context: Global runtime-defaults.json is shared across backends and currently contains the Fixture identity. Revision 5 must prevent Fixture model persistence, tolerate already polluted defaults, and pass a real DeepSeek PTY conversation capture before acceptance.
