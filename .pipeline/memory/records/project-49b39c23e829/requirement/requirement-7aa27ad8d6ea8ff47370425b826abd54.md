---
authority_role: record
confidence: confirmed
created_at: 2026-07-22T14:41:56.991Z
dedupe_key: project_intent
id: requirement-7aa27ad8d6ea8ff47370425b826abd54
kind: requirement
schema_version: '1'
scope:
  ref: project:VSPi
  type: project
semantic_hash: 7aa27ad8d6ea8ff47370425b826abd54f0dd68bdf120e6250668d2bc03235593
source_refs:
  - locator: request.intent
    ref: init
    type: user_request
supersedes: []
updated_at: 2026-07-22T14:41:56.991Z
---
# Project Intent

构建一个基于 pi agent 深度定制、开箱即用且可扩展的多模型工作台；总体需求以 Docs/init_doc.md 为依据。第一版优先把 TUI 的基础交互体系打磨完整，包括配色（尤其输入框）、输入换行、命令集、Provider 组织、Question Tools 弹出交互，以及进入界面时使用的符号、文字与动效。允许 sub agent 等尚未接通后端的功能先有完整、可验证的界面与占位交互。开发采用 Cycle 式节奏：每个 Milestone 都反复进行交互评审与打磨，直到 TUI 达到可接受质量；完整功能、extensions、模型编排、上下文机制、Web 端等在后续一个或多个 Cycle 集中完成。
