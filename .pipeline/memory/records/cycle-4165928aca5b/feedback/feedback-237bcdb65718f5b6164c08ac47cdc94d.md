---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T04:38:45.128Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.dc3a0f94d1467e35
id: feedback-237bcdb65718f5b6164c08ac47cdc94d
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 237bcdb65718f5b6164c08ac47cdc94de21b237c845fed7f48893d57efa405eb
source_refs:
  - locator: delivery.reject
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T04:38:45.128Z
---
# Delivery feedback

Problem: Tool trees never close and command activity is visually over-reported; Markdown heading hierarchy is weak; the approval panel is cramped; policy elevation raises only one level instead of reaching the minimum level that permits the current action.
Reproduce: Run a real turn containing several tool calls and inspect the tree connectors and vertical density. At Standard policy, trigger a destructive operation and choose policy elevation. Open the approval panel at 80 columns and inspect its frame gutters and option indentation. Render an assistant response containing Markdown headings.
Expected: Group one turn of tools under one execution summary, close the final branch with a corner, compact successful items with progressive disclosure, color Markdown headings with a restrained content color, add stable panel gutters, and elevate directly to the lowest policy level that permits the current action.
Actual: Every tool uses a tee connector and roughly three rows; headings rely mostly on weight; approval content touches the frame; Standard destructive approval proposes YOLO even though YOLO still requires approval.
Context: Final real-TUI acceptance review of vspi-v0-2-0-workflow-integration revision 5.
