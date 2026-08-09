# VSPi Subagent and Teammate Delivery Verification

Date: 2026-07-31
Worker role: implement
Worker identity: root

## Acceptance evidence

- Task Agent isolation and custom runtime selection: `src/agents/manager.ts`, `test/agents-manager.test.ts`.
  Tests cover empty-by-default history, explicit inherited context, sensitive-data filtering, custom instructions,
  system prompt, model, effort, tools, inherited defaults, allowlist rejection, and quota-only fallback.
- Nested scheduler: `src/agents/scheduler.ts`, `test/agents-scheduler.test.ts`. Tests cover depth 5, tree size
  128, configurable concurrency, ancestor lease suspension/resume, and single-writer serialization.
- Project Teammates and routing: `src/agents/config.ts`, `src/agents/manager.ts`,
  `test/agents-config.test.ts`, `test/agents-manager.test.ts`. Evidence covers trusted project configuration,
  persistent lanes, required routing, explicit root-turn Subagent requirements, sticky fallback, explicit model
  switching, cancellation state, and persistence rollback.
- Permission boundary: `src/policy/pi-policy-tools.ts`, `src/agents/workspace-tools.ts`,
  `test/agents-security.test.ts`. File tools reject absolute and symlink escapes; tools cannot exceed the parent
  allowlist; Recovery disables delegation; child Bash uses bubblewrap with a blank HOME, cleared environment,
  workspace-only write mount, and a read-only hidden `.vspi` mount.
- Status visibility and non-tutorial capability contract: `src/agents/types.ts`,
  `src/backend/pi-runtime-backend.ts`, `src/ui/panels.ts`, `src/ui/transcript.ts`, `test/agents-ui.test.ts`, and
  `test/transcript.test.ts`. `/agents` and Transcript expose role, lane, isolated/inherited/lane context mode,
  current/preferred model, effort, task, run state, and fallback state at 40, 80, and 120 columns. Model-facing
  text describes available capability, current policy, and hard limits without prescribing a workflow.

## Verification commands

- `npm run check`: passed; TypeScript and Biome checked 197 files.
- `npm test`: passed; build succeeded and Vitest reported 102 files and 748 tests passed.
- `npm run smoke`: passed with the Fixture render-once terminal surface.
- `npm audit`: passed with 0 vulnerabilities.
- `git diff --check`: passed.
- Live bubblewrap probe: ordinary workspace writes succeeded; `.vspi/probe` failed with a read-only filesystem
  error and did not appear on the host.

No version was published, no remote was pushed, no provider credential was modified, and the pre-existing
Session and PTY worktree changes were preserved.
