---
authority_role: record
confidence: confirmed
created_at: 2026-08-01T06:41:05.228Z
dedupe_key: goal.vspi-persistent-goal-runner.feedback.0564e746519681aa
id: feedback-57c0bec22f6e4b1f92bb7f3a9f277bc0
kind: feedback
schema_version: '1'
scope:
  ref: vspi-persistent-goal-runner
  type: goal
semantic_hash: 57c0bec22f6e4b1f92bb7f3a9f277bc0b1bd4f0cf9a7dde2a15400a1224effc2
source_refs:
  - locator: revision
    ref: actor:user:heyx
    type: user_feedback
supersedes: []
updated_at: 2026-08-01T06:41:05.228Z
---
# Delivery feedback

Problem: The proposed terminal Mock still lacked an outer inspection shell that lets the user personally identify incorrect or hidden rows without copying terminal content.
Reproduce: Run the terminal Mock at a target child height such as 40 rows. Observe a frame where content disappears, shifts, or overlaps during streaming or Resume. Try to report the exact location without a stable frame identifier or row ruler.
Expected: Keep the child PTY at its exact configured size while an outer shell adds a four-column row ruler, changed-row markers, stable frame IDs, coordinates, pause/step controls, and an optional column ruler.
Actual: Revision 3 specified interactive and trace modes but did not define a user-facing coordinate shell or stable visual addressing for individual frames and rows.
Context: The ruler must live outside the child PTY so it cannot change VSPi wrapping or layout; interactive and trace views must address the same captured frames.
