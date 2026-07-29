---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T15:06:34.551Z
dedupe_key: decision.vspi.mcp-tool-exposure
id: decision-dadcdf82568a01d80eeccfe8ee8432db
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: dadcdf82568a01d80eeccfe8ee8432db169054e8f297ae463798420d83381e55
source_refs:
  - locator: 2026-07-26-v0.3-design-decisions
    ref: current-chat
    type: session
supersedes: []
updated_at: 2026-07-26T15:06:34.551Z
---
# MCP tool exposure

VSPi 0.3 preserves enabled MCP tools as direct Pi ToolDefinitions with their native structured schemas. Saving an MCP Server does not expose tools by default; exposure requires an explicit Install and Enable choice or later manual enablement. Large Servers require explicit tool selection to avoid prompt and tool-list expansion.
