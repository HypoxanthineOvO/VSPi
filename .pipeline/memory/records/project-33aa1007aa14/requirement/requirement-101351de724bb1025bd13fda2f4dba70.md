---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T11:55:30.972Z
dedupe_key: requirement.vspi.interactive-panel-density
id: requirement-101351de724bb1025bd13fda2f4dba70
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: 101351de724bb1025bd13fda2f4dba70548d61dde989a0ab5d460b5a9a64af5d
source_refs:
  - locator: 2026-07-26-panel-spacing-model-plan-refinement
    ref: current-chat
    type: session
supersedes:
  - requirement-d350a326aebf15cee022d4ca8d85482e
updated_at: 2026-07-26T11:55:30.972Z
---
# Interactive surface hierarchy and component layout

Preserve the approved spatial classes, original Braille Working frames, full-width command rows, visible Question descriptions, prominent ordered approval actions, and the original session branch tree drawing. Working itself is a plain, unframed status row at the end of the active message waterfall: it has no blue leading rail or user-message surface.

Render every ordinary sent user message as a full-width surface with one background row above and below its content, preserving the blue user marker. Add one normal blank row between that completed surface and the following Agent output. A message sent while the Agent is busy is different: render it as one compact, subdued pending row with lower-contrast text, the blue user marker, and only a small right-aligned `↪` symbol. Once inserted, it becomes an ordinary padded user message without an insertion label. Prefix each Agent response block with a small muted round marker.

Question content uses one additional column of inner spacing for its progress row, prompt, and options; keep the bottom keyboard hint at its original alignment. Approval places the command immediately below its heading, keeps one deliberate gap between the command and choices, and renders choices 1 through 5 continuously without a split between choices 3 and 4. Model details omit authentication and status. Show `Low / Medium / High / Xhigh / Max` on one row whenever the available detail width permits, falling back to two rows only when required; spell `Xhigh` without a hyphen.

Expanded Plan keeps the coherent outer frame, blue title, revision/progress, and goal. Its body uses the exact flat nested projection: completed main chat, active hollow-circle Question/Approval parent, active `├─ ● Plan Native TTY Mock`, completed `├─ ✓ Question 与 Approval`, muted `╰─ ○ Model、Provider 与 Sessions`, then a muted pending `○ Question 与审批` sibling. The outer frame supplies the only leading vertical line, so body connectors have no extra indentation. Active parent and child use restrained cyan and slight bold weight, distinct from the blue Plan title. Collapsed Plan remains one compact title row with no hint or summary body. Validate all layouts in real 80x24 and narrow native TTYs before product implementation.
