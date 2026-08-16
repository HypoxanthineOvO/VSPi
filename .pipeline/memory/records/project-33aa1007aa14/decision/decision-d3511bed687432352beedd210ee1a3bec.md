---
authority_role: record
confidence: confirmed
created_at: 2026-08-15T12:30:00.000Z
dedupe_key: decision.vspi.c13-release-0.6.4-local-acceptance
id: decision-d3511bed687432352beedd210ee1a3bec
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: d3511bed687432352beedd210ee1a3bec9d17d4d829892ee1129070203626189
source_refs:
  - locator: 2026-08-15-c13-version-and-acceptance-correction
    ref: current-chat
    type: user_feedback
supersedes: []
updated_at: 2026-08-15T12:30:00.000Z
---
# C13 修订以 v0.6.4 发布，验收目标为本机

C13 的 Pi Editor 性能补丁与模型目录修订作为 v0.6.4 发布候选（`package.json` version 已提升）。S2 验收目标是本机实机使用（输入、开屏、模型列表），不再以 Windows 作为默认门禁；仅当确实存在 Windows 使用场景时，再补充 Windows 验证。
