---
kind: review-artifact
cycle: C07-subagent-teams
stone: S3
status: accepted
updated: 2026-08-09
---

# Agents UI Review

## Review Outcome

M4 已将 Agent runtime 的结构化状态投影到 `/agents` 与主 Transcript。UI 不读取或显示 Task Agent Session 路径，也不把 bounded output preview 称为完整 Transcript。

## Views To Review

| View | Visible truth |
| --- | --- |
| Map | run tree、current/preferred/fallback、routing、pending required、turn/session override、lane state/owner |
| Timeline | run/tree/parent IDs、Provider/model、context mode/chars、usage、剩余 run/tree budget、最多 32 条事件、4K redacted preview |
| Tools | 当前 run 的实际 tool set，不显示绝对 Session 路径 |
| Pools | 每个 Provider 的 source 与四个 role mapping |
| Main Transcript | Subagent identity/model/context/lane/fallback、剩余 run/tree token 和 tree cost、bounded preview |

## Failure States

- lane 冲突显示 `blocked@<host>:<pid>`，不显示 owner token。
- 同进程 lane 排队显示 `waiting`；持有时显示 `owned`，释放后显示 `idle`。
- budget/deadline/cancel 分别进入固定 `budget` / `cancelled` Timeline event，不持久化原始异常对象。
- task、output preview 与 error summary 对常见 credential 形态脱敏；audit snapshot 无 `sessionFile`。

## Responsive And Terminal Evidence

- Production `PanelController` 的 Map/Timeline/Tools/Pools 在 40、80、120 列逐 view 验证所有行不溢出。
- 40 列不截掉 limits、current/preferred、fallback、context 与剩余 budget；长字段换行显示。
- 真实 PTY 在 40 列提交 `/agents`，依次导航 Map → Timeline → Tools → Pools，再 resize 到 80/120，面板保持可用。

## Verification

- Agent/UI focused: 9 files, 79 tests passed.
- Static quality: `npm run check` passed.
- Build: `npm run build` passed.
- Full regression: 113 files, 827 tests passed.
- `git diff --check` passed.

## Acceptance Scope

Accepting S3 approves the M4 audit/UI behavior and authorizes M5 final security regression and Cycle close. It does not itself close C07 or authorize commit, push, release, publish, or paid model calls.

## Acceptance

- 2026-08-09：用户在 `S3 Agents UI Review` 选择“接受并继续”，授权进入 M5。
