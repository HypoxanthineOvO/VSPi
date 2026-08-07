# Mock Surface Oracle Evidence

Milestone: `mock-surface-oracle`

## Artifact

- Terminal interactive: `npm run mock:terminal -- --rows 40 --cols 80 --theme terminal`
- Light interactive: `npm run mock:terminal -- --rows 40 --cols 80 --theme light`
- Terminal trace: `npm run mock:terminal -- --rows 40 --cols 80 --theme terminal --trace`
- Light trace: `npm run mock:terminal -- --rows 40 --cols 80 --theme light --trace`
- The parent inspector owns the 4-column row gutter, Frame IDs, phase/header state,
  pause/previous/next/live controls, and optional column ruler.
- The child PTY runs the real `VspiApp`, `ScrollbackTUI`, Composer, panels, and status.
  Only the backend, attachments, scripted input, and clock-sensitive delays are deterministic.

## Verification

- `npm run check`: passed, 209 files checked.
- Target unit and PTY Vitest: passed, 4 files and 62 tests.
- Full `npx vitest run`: passed, 107 files and 784 tests.
- Target PTY continuity suite: passed, 5 tests.
- Interactive outer-shell smoke: passed; Frame header observed, `Ctrl+G q` exited 0,
  and the host alternate screen was restored.
- Terminal and Light trace results: no violations.
- Trace controls: startup viewport clear 1; post-start viewport clear 0;
  post-start scrollback clear 0; Resume Home 0; expected resize viewport clears 2.
- Trace hydration: partial Resume Frames 0.
- Terminal output: streaming 14,097 bytes; Resume 7,507 bytes.
- Light output: streaming 18,646 bytes; Resume 9,695 bytes; the increase is expected RGB SGR payload.

## Question, Focus, And Notice Geometry

- Terminal Question Frame 11 and Light Question Frame 9 both occupy child rows 25-37 at 80x40.
- Question metadata is row 26 and prompt is row 29.
- Continue, Cancel, and Other occupy consecutive rows 33, 34, and 35.
- Row 36 is a fixed blank option-footer gap, immediately followed by the Question footer at row 37.
- Trace reports `consecutive: true` and `decorationVisible: false` in both themes.
- Transcript rows intersecting the Question frame: none. Prior `mock response` content remains outside the frame and in native scrollback.
- The main Composer is absent while Question is active; its draft and focus restore after Question closes.
- The Question-local direct-answer field is row 35 and is the only visible text input/cursor in that mode.
- It uses a local `›` marker plus a bottom horizontal rule, with no vertical input rail.
- Question bottom row 37 is followed by a blank gutter at row 38 and the fixed two-line Status at rows 39-40.
- The completion notice is Terminal Frame 18 / Light Frame 15 row 39, exactly the first row of the Status footprint at rows 39-40.
- Notice presentation uses explicit semantic labels: `通知`, `完成`, `警告`, `错误`, and `进行中`.
- While a notice is visible, Status row 40 compresses Model, Effort, cwd, and Policy so model identity remains visible; Token and Cost yield temporarily.
- Notice appearance and disappearance preserve the active interaction surface and Status coordinates and never add a layout row.

## Option, Theme, And Inspector Styling

- Single choice uses `(●)/( )`, multi-choice uses `[✓]/[ ]`, ranking uses stable numeric labels, and `其他` retains a visible type-appropriate marker.
- Ordinary short options form a continuous row list with no blank rows, separators, rails, or inner boxes.
- The selected item uses only `›`, its type marker, bold, and focus foreground without inverse or a fixed background.
- Labels and descriptions share one aligned row when they fit; otherwise wrapped rows follow immediately with indentation.
- Terminal `theme.selected` uses bold rather than inverse, keeping terminal-owned black and white backgrounds usable.
- No-color snapshots retain controls, focus symbols, and separators; Light trace uses the explicit `VSPi Light` palette with identical geometry.
- The parent inspector stores both plain and ANSI-styled rows for every Frame. Frame identity changes on style-only changes.
- Styled row serialization preserves RGB and palette foreground/background plus bold, dim, italic, underline, blink, inverse, invisible, strikethrough, and overline attributes.
- Terminal and Light Question/Session option rows report no selection background or inverse; paused historical Frames replay captured styles rather than borrowing live styles.
- The row gutter and optional column ruler are reset outside the child style stream and do not alter child dimensions, bytes, cursor coordinates, or plain Frame geometry.

## Behavioral Boundaries

- Streaming transcript tails remain append-only until a stable boundary.
- The stable boundary waits for the rendered frame, then rebases only a verified
  offscreen prefix including transcript separator rows.
- Question and lower-surface height changes do not change the retained transcript start.
- Question metadata, prompt, direct answer, and review headings use grouped vertical spacing;
  ordinary answer choices remain consecutive without decorative spacing.
- Option rendering publishes the selected item's semantic start/end rows to viewport logic.
- Option-mode viewport capacity reserves one non-scrollable footer-gap row; ordinary, wrapped, first/last-item,
  and short-terminal scrolling cannot consume it. Free text and Review do not receive this option-only gap.
- On short terminals, metadata/title remain pinned while the option lane scrolls; the PTY regression
  confirms the title, selected item, fixed footer gap, footer, outer gutter, and Status remain usable together.
- Question owns the lower interaction surface while active: the main Composer, its Working label, and queued-message lane are suppressed without losing logical state.
- Question footer actions stay fixed and muted inside the bottom frame; one physical gutter separates that frame from Status.
- Notices render inside the existing Status footprint without a full-row background.
- Sessions and restored transcripts begin append-only surface epochs without CSI 2J,
  CSI 3J, or Home; the epoch starts after the prior logical surface end.
- Resume collects backend, Plan, usage, and attachment hydration while render requests
  are suppressed, then publishes one complete restored surface.
- Resume selected and next Sessions occupy rows 3 and 5 with a full blank entity spacer at row 4.
- Session selection maps to body row `index * 2`, remains visible on short terminals, and uses no inverse/background.
- New/Clear Session replacement remains distinct from Resume append behavior.

## Distribution Boundary

- The first target-test invocation used `npm test`, whose `pretest` unexpectedly ran `npm run build`;
  the local wrapper executes this repository's `dist/index.js` directly.
- Before Stone handoff, revision 2 source semantics were temporarily restored, `dist` was rebuilt,
  and revision 3 source was restored byte-for-byte. This removed revision 3 from the local wrapper.
- Current revision 6 source hashes:
  - `src/ui/panels.ts`: `b38201f276edfe2701a58d0f8166b67a4eeb69272850208d62f63333ede65b77`
  - `src/ui/theme.ts`: `42b923ec146322d9f65083f09e11f4e513a79c5904d1926679166339a05221b1`
  - `scripts/terminal-mock.ts`: `425732732fe68a6f6110560b248952fb826a4ff0f5f198a2241fc52cc21f014f`
- `dist/index.js` stayed unchanged throughout revision 6 at
  `e752fe7154747b09ecedab8c9f6d113b7b7607b0167f200e3ae95c1184e23dee`.
- Compiled `dist` continues to contain revision 2 rails, compact controls, and Terminal inverse selection.
- No wrapper edit, package installation, commit, push, or release was performed.
- Production integration remains gated by `stone-terminal-mock-review`.
