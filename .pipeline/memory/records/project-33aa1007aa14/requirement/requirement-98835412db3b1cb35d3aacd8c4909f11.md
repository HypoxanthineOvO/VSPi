---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T09:48:25.207Z
dedupe_key: requirement.vspi.interactive-panel-density
id: requirement-98835412db3b1cb35d3aacd8c4909f11
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
semantic_hash: 98835412db3b1cb35d3aacd8c4909f11db52dfba4a68374d9352b98d98254ecd
source_refs:
  - locator: 2026-07-26-working-plan-status-clarification
    ref: current-chat
    type: session
supersedes:
  - requirement-9714a3a81831cd03dec8943e06b51b8a
updated_at: 2026-07-26T09:48:25.207Z
---
# Interactive surface hierarchy and density

Use three spatial classes instead of rendering every interaction as the same large panel. Composer-attached surfaces appear immediately above input and keep conversation context: command completion, Question, and approval. Center-workspace takeover views hide the composer and preserve its draft and transcript position until Esc returns: Model, Provider, Sessions, Settings, and similar management views. Preserve the existing VSPi Working rail visual and line animation; relocate it to the end of the message waterfall immediately above the bottom interaction area. Preserve the existing VSPi Plan presentation and content logic rather than copying Kimi Todo; collapse Plan when it has no content. Keep the existing tool-call tree. Use whitespace and optional subtle dividers between user messages, tool activity, and assistant output. Prefer Chinese interface copy except established product, provider, model, command, and effort names. Sessions must expose useful selected-session metadata without overloading the list.
