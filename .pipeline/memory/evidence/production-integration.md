# Production Integration Evidence

Milestone: `production-integration`

## Accepted Mock Gate

- `mock-surface-oracle` revision 6 was accepted by the user and is `verified`.
- Terminal and Light 80x40 traces both reported `violations: []`.
- In both traces, Question options occupied consecutive rows 33-35, the fixed option-footer gap was row 36,
  the Question footer was row 37, the outer gutter was row 38, and Status occupied rows 39-40.
- Selection background, option rail, decorative option box, transcript intrusion, main Composer intrusion,
  Resume Home, and partial hydration counts were all zero.

## Production Build And Package

- `npm run build`: passed.
- Compiled `dist/ui/panels.js` contains the shared `questionFooterGap` / `visibleBodyRows` implementation;
  there is no production-only layout path.
- Direct import of compiled `PanelController` at 80x22 passed geometry assertions:
  option rows 9-11, fixed blank row 12, footer row 13.
- `test/m9-package-install.test.ts`: passed, 2 tests. The package dry-run, real tarball installation in an
  empty project, declared bin, and Fixture smoke all passed.
- `npm audit`: passed with 0 vulnerabilities.

## Regression Verification

- `npm run check`: passed, 209 files checked by TypeScript and Biome.
- Target Question, Mock, and real PTY tests: passed, 62 tests across 4 files after the short-terminal title
  regression was corrected.
- Full `npx vitest run`: passed, 107 files and 784 tests.
- Real PTY continuity: 5 tests passed, including Question ownership, Resume, compaction, Plan refresh,
  viewport anchoring, and Status placement.
- Real PTY scrollback: 5 tests passed at 80x20, 80x40, and 80x60 plus completed-output and Inspect paging cases.

## Local Distribution

- `/home/heyx/.local/bin/vspi` remains the local wrapper and executes
  `/home/heyx/VSPi/dist/index.js`.
- `VSPi_FIXTURE=1 VSPi_REDUCED_MOTION=1 /home/heyx/.local/bin/vspi --render-once`: passed against the
  rebuilt production output and rendered VSPi v0.3.11 with the Composer and two-line Status.
- Production hashes:
  - `dist/ui/panels.js`: `53ea74c1903586c557b30d06be7b82cff890a8614fe149629e15714c8f91d501`
  - `dist/ui/theme.js`: `fa8412c6025743fb8e5c799a6856991f5f9a6ad65b5749890e85aae90e50414b`
  - `dist/app/vspi-app.js`: `97a7979bef17a1f337d1530ec70d18b9d60b00f4c15b51960c7fc9224ac3c2ee`
  - complete sorted `dist` file/hash manifest: `36113901bd2ee147295ea384e8ee2b3d9bf3d0433cc6199229821d0862cba627`
- `dist/index.js` remains the stable entry wrapper at
  `e752fe7154747b09ecedab8c9f6d113b7b7607b0167f200e3ae95c1184e23dee`;
  the component and full-manifest hashes above prove the rebuilt payload.
- No commit, push, remote package publication, or release was performed.
