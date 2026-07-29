---
authority_role: record
confidence: confirmed
created_at: 2026-07-26T10:07:05.421Z
dedupe_key: requirement.vspi.interactive-panel-density
id: requirement-67fde9f993577eb71275eead9f9c03cd
kind: requirement
schema_version: '1'
scope:
  ref: VSPi
  type: project
semantic_hash: 67fde9f993577eb71275eead9f9c03cd407320b23971557cd38f40a768aa739b
source_refs:
  - locator: 2026-07-26-native-tty-density-status-feedback
    ref: current-chat
    type: session
supersedes:
  - requirement-98835412db3b1cb35d3aacd8c4909f11
updated_at: 2026-07-26T10:07:05.421Z
---
# Interactive surface hierarchy and density

Use composer-attached, center-workspace takeover, and existing Plan surfaces according to their interaction role. Preserve the current VSPi Working rail visual and animation, moving only its row position to the end of the message waterfall above the bottom interaction area. Preserve the existing tool tree and Plan content logic; collapse Plan when empty. Reduce excessive double blank lines and use occasional low-contrast separators where they improve grouping. Primary headings may use the approved accent color but must resolve through semantic theme colors for both dark and light terminals. Center takeover panels should use natural content height and generally remain around one half of available terminal height, never routinely consuming two thirds or more. Sessions must show a recent-progress summary in selected-session details so titles are not the sole basis for judging state. Before implementation, validate spatial mocks in a real TTY with VSPi terminal primitives rather than relying only on browser composites.
