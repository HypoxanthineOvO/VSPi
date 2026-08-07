# Mock Surface Oracle Evidence

Milestone: `mock-surface-oracle`

## Artifact

- Interactive command: `npm run mock:terminal -- --rows 40 --cols 80`
- Automated command: `npm run mock:terminal -- --rows 40 --cols 80 --trace`
- The parent inspector owns the 4-column row gutter, Frame IDs, phase/header state,
  pause/previous/next/live controls, and optional column ruler.
- The child PTY runs the real `VspiApp`, `ScrollbackTUI`, Composer, panels, and status.
  Only the backend, attachments, scripted input, and clock-sensitive delays are deterministic.

## Verification

- `npm run check`: passed, 209 files checked.
- `npx vitest run --reporter=dot`: passed, 107 files and 778 tests.
- Target PTY continuity suite: passed, 5 tests.
- Interactive outer-shell smoke: passed; Frame header observed, `Ctrl+G q` exited 0,
  and the host alternate screen was restored.
- Trace result: no violations.
- Trace controls: startup viewport clear 1; post-start viewport clear 0;
  post-start scrollback clear 0; Resume Home 0; expected resize viewport clears 2.
- Trace hydration: partial Resume frames 0; complete restored-surface frames 2.
- Trace output: streaming 13,217 bytes; Resume 7,866 bytes.

## Behavioral Boundaries

- Streaming transcript tails remain append-only until a stable boundary.
- The stable boundary waits for the rendered frame, then rebases only a verified
  offscreen prefix including transcript separator rows.
- Question and lower-surface height changes do not change the retained transcript start.
- Sessions and restored transcripts begin append-only surface epochs without CSI 2J,
  CSI 3J, or Home; the epoch starts after the prior logical surface end.
- Resume collects backend, Plan, usage, and attachment hydration while render requests
  are suppressed, then publishes one complete restored surface.
- New/Clear Session replacement remains distinct from Resume append behavior.

## Distribution Boundary

- No local `vspi` installation or wrapper refresh was performed.
- `dist/index.js` retained its pre-milestone mtime (`2026-08-01 14:06:58 +0800`).
- Production integration remains gated by `stone-terminal-mock-review`.
