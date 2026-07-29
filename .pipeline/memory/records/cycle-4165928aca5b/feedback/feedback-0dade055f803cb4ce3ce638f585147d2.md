---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T04:40:01.218Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.feedback.c138c34d690d31c6
id: feedback-0dade055f803cb4ce3ce638f585147d2
kind: feedback
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 0dade055f803cb4ce3ce638f585147d201762399a60e51ec491eb469f1ba05b4
source_refs:
  - locator: revision
    ref: actor:user:operator
    type: user_feedback
supersedes: []
updated_at: 2026-07-25T04:40:01.218Z
---
# Delivery feedback

Problem: Tool trees never close and command activity is visually over-reported; Markdown heading hierarchy is weak; the approval panel is cramped; policy elevation raises only one level instead of reaching the minimum level that permits the current action.
Reproduce: Run a real turn containing several tool calls and inspect the tree connectors and vertical density. At Standard policy, trigger a destructive operation and choose policy elevation. Open the approval panel at 80 columns and inspect its frame gutters and option indentation. Render an assistant response containing Markdown headings.
Expected: Group one turn of tools under one execution summary, close the final branch with a corner, compact successful items with progressive disclosure, color Markdown headings with a restrained content color, add stable panel gutters, and elevate directly to the lowest policy level that permits the current action.
Actual: Every tool uses a tee connector and roughly three rows; headings rely mostly on weight; approval content touches the frame; Standard destructive approval proposes YOLO even though YOLO still requires approval.
Context: Final real-TUI acceptance review of vspi-v0-2-0-workflow-integration revision 5.
