---
kind: review-artifact
cycle: C07-subagent-teams
stone: S2
status: accepted
updated: 2026-08-09
---

# Agent Runtime Review

## Review Outcome

M2/M3 已把 S1 安全合同落实到 Agent runtime。当前实现没有调用真实付费模型；证据来自真实 filesystem/process/Bubblewrap/SessionManager fixture 和完整仓库测试。

## Boundaries To Review

| Boundary | Implemented behavior | Evidence |
| --- | --- | --- |
| Limits | 默认 depth/tree/concurrency 3/12/16；可信 ceiling 5/128/16 | config + scheduler ceiling tests |
| Task isolation | Task Agent in-memory；默认仅 task/context | Session file 为 undefined；parent history 不泄漏 |
| Provider | 完整历史永不跨 Provider；显式跨 Provider只发 task/context | session creation 前拒绝 + positive explicit-context test |
| Budget | run 120k/900s；tree 500k/20 USD；失败 attempt 计费 | run/tree/deadline/fallback tests |
| Cancellation | tree signal abort active 与 queued descendants | maxConcurrency=1 cascade test |
| Writer | 所有 Bash 为 writer；workspace 跨进程 lease | 双 manager `node -e` 顺序与 stale/cancel tests |
| Control files | model tools 不直接修改 config/lane；Bash 中 `.vspi` read-only | typed-action assertion + indirect Bubblewrap write test |
| Identity | Teammate `systemPrompt` 不可按 call 替换 | session creation 前 rejection test |
| Authority | required override 只走 typed turn/session action | natural-language negative + command parser tests |
| Routing | required 阻塞；preferred/consult 非阻塞提示；manual 显式调用 | routing semantics test |
| Lane continuity | prompt/reset/model switch 有跨进程 ownership；锁后重读 config/history | contention、stale-manager、reset-after-release tests |
| Persistence failure | sticky fallback/config save 失败回滚 | symlink failure rollback test |

## Verification

- Agent targeted: 7 files, 44 tests passed.
- Static quality: `npm run check` passed.
- Build: `npm run build` passed.
- Full regression: 112 files, 822 tests passed.
- `git diff --check` passed.

## Deferred After S2

- M4 adds bounded redacted audit projection and changes Agent detail naming from preview-as-Transcript to Timeline, while reserving Transcript for persistent lane history.
- M4 adds truthful remaining-budget, override scope and lane-owner presentation at 40/80/120 columns.
- No commit, push, release, package publish, or paid model call was performed.

## Acceptance Scope

Accepting S2 approves the M2/M3 runtime behavior and authorizes M4. It does not accept the future `/agents` UI or close C07; S3 remains a separate review point.

## Acceptance

- 2026-08-09：用户在 `S2 Agent Runtime Review` 选择“接受并继续”，授权进入 M4。
