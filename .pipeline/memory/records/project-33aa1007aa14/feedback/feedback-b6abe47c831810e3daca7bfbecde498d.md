---
authority_role: record
confidence: confirmed
created_at: 2026-08-09T09:38:48.532Z
dedupe_key: feedback.vspi.release-ledger.v0.6.0
id: feedback-b6abe47c831810e3daca7bfbecde498d
kind: feedback
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: b6abe47c831810e3daca7bfbecde498d054aa083f77f65d2d05135ce25b1fcfa
source_refs:
  - locator: commit:f325353ac5672bdf9bec65b203f9733877d9eefb
    ref: tag:v0.6.0
    type: git
  - locator: pipeline:349
    ref: project:107
    type: gitlab_pipeline
  - locator: https://gitlab.vsplab.cn/heyx/vspi/-/releases/v0.6.0
    ref: v0.6.0
    type: gitlab_release
supersedes: []
updated_at: 2026-08-09T09:38:48.532Z
---
# v0.6.0 release outcome

VSPi 0.6.0 Fullscreen Runtime was released from commit `f325353ac5672bdf9bec65b203f9733877d9eefb` with protected annotated tag `v0.6.0`. GitLab tag pipeline 349 passed quality, 113 files / 827 tests, package, install-smoke, and release. The public Release exposes immutable `vspi-0.6.0.tgz` and `vspi-latest.tgz` assets with SHA-256 `6925f44c5f377c922eafbeef655f594f47a8bc7d89c8f1e579a2de479d978602`. Anonymous download, latest/pinned byte equality, clean installation, `vspi --version` 0.6.0, and Fixture smoke were verified. The public npm registry was not used.
