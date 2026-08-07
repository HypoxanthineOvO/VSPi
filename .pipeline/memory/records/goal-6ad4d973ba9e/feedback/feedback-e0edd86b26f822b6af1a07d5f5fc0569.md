---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T05:36:58.604Z
dedupe_key: goal.vspi-persistent-goal-runner.feedback.02b3dd429995fd7f
id: feedback-e0edd86b26f822b6af1a07d5f5fc0569
kind: feedback
schema_version: '1'
scope:
  ref: vspi-persistent-goal-runner
  type: goal
semantic_hash: e0edd86b26f822b6af1a07d5f5fc05690a5a034c58d83a014a1022604445c88f
source_refs:
  - locator: delivery.reject
    ref: actor:user:heyx
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T05:36:58.604Z
---
# Delivery feedback

Problem: VSPi startup animation and transcript viewport do not follow terminal waterfall/scrollback semantics.
Reproduce: Open a relatively tall terminal. Run vspi from the shell. Observe that the startup animation is only visible after scrolling upward while the input box remains fixed at the bottom. Continue rendering transcript content or resize the terminal and observe earlier content disappear instead of being pushed beyond the top.
Expected: Startup should either clear the screen and show only the bottom frame, logo animation, and input, or render beneath the shell invocation on an otherwise empty screen. Transcript output should first grow downward and push the input downward, then naturally push earlier output upward after reaching the terminal bottom, preserving about three viewport heights before truncation.
Actual: The startup animation appears outside the initial viewport, the input box is pinned to the bottom, tall terminals lose earlier content without natural displacement, and scrolling produces a discontinuous viewpoint.
Context: Reported during local testing of delivery vspi-persistent-goal-runner while final acceptance was pending; this blocks acceptance.
