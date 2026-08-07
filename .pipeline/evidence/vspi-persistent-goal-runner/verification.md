# VSPi Persistent Goal Runner Verification

Date: 2026-07-31 (Asia/Shanghai)
Delivery: `vspi-persistent-goal-runner`
Plan hash: `1ad8dfc0809b41586978e0eee7c867f54f8bf57532a58826e2a48459dd7c559a`
Topology: `solo-verified` / role `implement`

## Delivered Surface

- `/goal <request>` creates a workspace-scoped persistent Goal, a mutable Local Plan, and durable Session bindings, then immediately starts the request.
- Creation-time bounds are configurable with `--rounds`, `--no-progress`, and `--tokens`.
- `/goal status|pause|resume|cancel|accept` provides explicit user lifecycle operations.
- The Goal Contract is separate from the mutable Working Plan. Model tools expose only `goal_status`, `goal_checkpoint`, `goal_block`, and `goal_complete`; no model tool can mutate or accept the Contract.
- `goal_complete` enters `pending_acceptance`; only `/goal accept` enters `completed`.
- Pi automatic continuation is triggered once at `agent_end` through native `AgentSession.followUp`. It is not recursive VSPi `send`.
- Automatic continuation stops for pause, cancellation, structured block, pending acceptance, completion, stall, round/token budget, lost owner, Session handoff, generation cancellation, or follow-up failure.
- Explicit resume acquires the current Session owner and starts a fresh bounded run window while preserving Contract, Plan, and markers.
- Recovery and read-only Workflow modes do not construct the Goal runtime.
- Task Agents and Teammates remain ordinary worker tools; they have no Goal authority surface.

## Persistence And Integrity

- Goal revisions use workspace-isolated storage, CAS revisions, content hashes, immutable revision files, atomic `HEAD`, and a writer lock.
- Goal IDs and Session binding values are allowlisted.
- Storage rejects symlinked Goal directories and terminal-control characters.
- Mutable marker values are XML-escaped and explicitly treated as execution data rather than system/Policy instructions in the bounded capsule.
- Empty or repeated bookkeeping markers do not by themselves count as semantic progress, and checkpoints do not reset no-progress counters.

## Verification Results

- `npm run check`: passed. TypeScript `--noEmit` and Biome checked 206 files with no findings.
- `npm test`: passed. 106 test files and 768 tests passed.
- `npm run test:pty`: passed. 2 PTY files and 6 real-terminal tests passed.
- `npm run build`: passed as the `pretest` stage of the final full run.
- `npm run smoke`: passed with explicit Offline Fixture.
- Local installed command smoke: `VSPi_FIXTURE=1 VSPi_REDUCED_MOTION=1 /home/heyx/.local/bin/vspi --render-once` passed and rendered VSPi 0.3.11 from the local `dist` build.
- Package artifact install test passed inside the full suite; the generated tarball installed in an empty project and its `vspi` bin rendered successfully.
- `npm pack --dry-run --json --ignore-scripts`: passed; Goal runtime output is present under `dist/goals` and `dist/continuity/goal-capsule`.
- `npm audit --omit=dev --audit-level=high`: passed with 0 vulnerabilities.
- `git diff --check`: passed.

## Focused Goal Coverage

- `test/goal-backend.test.ts`: immutable Contract, CAS, markers, completion/acceptance split, blocker state, bounds, control-character rejection, symlink rejection, no-progress bookkeeping, and resume budget window.
- `test/goal-tools-capsule.test.ts`: narrow tool schemas, no Contract mutation tool, bounded capsule, and mutable marker escaping.
- `test/goal-runner.test.ts`: `agent_end` continuation, multi-block deduplication, pending-acceptance stop, budget stop, process restart/lost owner, and explicit resume.
- `test/goal-startup.test.ts`: normal-mode enablement, Recovery/Workflow disablement, and workspace isolation.
- `test/input-dispatch-regression.test.ts`: command creation, configurable bounds, status, and explicit resume dispatch.
- `test/panels.test.ts`: Goal panel at 40, 80, and 120 columns.
- Existing compaction, Session lifecycle, same-host handoff, Plan, Policy, Question, Skill, Subagent, package, Recovery, and PTY suites passed unchanged in the final full run.

## Security Review

OWASP Agentic AI review covered goal hijack, tool misuse, memory poisoning, owner loss, kill switches, input bounds, path traversal/symlinks, terminal control injection, error behavior, and dependency audit. The review resulted in marker data escaping, control-character rejection, symlink-safe directory creation, semantic progress checks, handoff pausing, and preserving the existing `AdaptiveBackend` positional API.

## Environment Note

Two pre-final full runs encountered environment-only failures while `/home` was full: one npm install process ended during cache work, and one PTY Session write returned `ENOSPC`. `npm cache verify` used npm's controlled garbage collection to remove approximately 5.6 GB of invalid cache content without deleting project files, Sessions, or valid npm content. The failed package test then passed alone, the PTY suite passed, and the final complete 106-file / 768-test run passed.
