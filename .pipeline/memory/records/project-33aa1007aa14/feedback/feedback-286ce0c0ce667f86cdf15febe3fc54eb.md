---
authority_role: record
confidence: confirmed
created_at: 2026-07-29T08:39:18.782Z
dedupe_key: feedback.vspi.release-ledger.v0.2.1-v0.2.7
id: feedback-286ce0c0ce667f86cdf15febe3fc54eb
kind: feedback
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: 286ce0c0ce667f86cdf15febe3fc54eb17b029f3b48755a0dd85862a6fbd59a8
source_refs:
  - locator: d488b5252492815d0a97bc5ebd2d4471cb64a659
    ref: tag:v0.2.1
    type: git
  - locator: 59361d79cc2d0ed2d3d2cb6ba43457f112721cae
    ref: tag:v0.2.2
    type: git
  - locator: 066005b640773a58ae739182d102349bf3af2937
    ref: tag:v0.2.3
    type: git
  - locator: 18bc703259b4069f6de8a74e84d61533b0ded854
    ref: tag:v0.2.4
    type: git
  - locator: 44bd9674163d1f478b3e514d8f86ba3d68fab4c9
    ref: tag:v0.2.5
    type: git
  - locator: f79e186e1051bad029c4e00f5aadbc748a83b66f
    ref: tag:v0.2.6
    type: git
  - locator: e7c363d1525aeddf00348579afebe40aab1875e1
    ref: tag:v0.2.7
    type: git
  - locator: v0.2.1-through-v0.2.7
    ref: 019f9486-7c29-7f83-9972-e5e6c8950ca7
    type: session
supersedes: []
updated_at: 2026-07-29T08:39:18.782Z
---
# v0.2.1 through v0.2.7 release outcomes

No new formal Delivery was opened for these releases; they were direct iterations in the main Session after the accepted v0.2.0 work. Git anchors and outcomes are:

- v0.2.1 d488b52: reproducible release pipeline, provider onboarding, and curated models.
- v0.2.2 59361d7: self-update and direct release download support.
- v0.2.3 066005b: provider onboarding repair and queued-prompt continuation after interrupt.
- v0.2.4 18bc703: paste support in init authentication.
- v0.2.5 44bd967: authentication and Session ownership hardening.
- v0.2.6 f79e186: external agent history import.
- v0.2.7 e7c363d: Skill management.

The existing project decision decision.vspi.post-0.2.5-feature-order planned v0.2.6 then v0.2.7, but it is not a Cycle or release acceptance record.
