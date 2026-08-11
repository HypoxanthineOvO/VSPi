---
authority_role: record
confidence: confirmed
created_at: 2026-08-11T11:35:37.000Z
dedupe_key: requirement.vspi.model-picker-generation-price-order
id: requirement-b07059defab206566f6dbf4f140fbf22
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: b07059defab206566f6dbf4f140fbf220b62ae537be0d9c4a681f90e31b9c2c3
source_refs:
  - locator: 2026-08-11-c12-r8-windows-tui-feedback
    ref: current-chat
    type: user_feedback
supersedes: []
updated_at: 2026-08-11T11:35:37.000Z
---
# Model picker generation and price order

Model picker 保留 Provider 分组优先级。每个 Provider 组内先按显式发布日期或模型 identity 中的代际从新到旧排序；代际相同时，按输入与输出 USD 单价之和从高到低排序；最后使用名称和 id 保证稳定顺序。
