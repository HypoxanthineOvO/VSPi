---
kind: design-artifact
cycle: C07-subagent-teams
stone: S1
status: accepted
updated: 2026-08-09
---

# Agent Runtime Security Contract

## 1. Limits And Budgets

- 默认：depth 3、每 tree 12 个 Agent、全局 16 个 generation。
- 可信项目可配置 `maxDepth`、`maxAgentsPerTree`、`maxConcurrency`，硬上限分别为 5、128、16。
- 默认 run 边界：120,000 tokens、900 秒；默认 tree 边界：500,000 tokens、20 USD。
- deadline 到达立即 abort；token/cost 到达后禁止新 descendant 或 follow-up。Provider 不支持硬输出上限时，UI 与事件必须标识最终响应可能产生一次有界超额，不能伪称精确硬截断。

## 2. Context And Provider Boundary

- Task Agent 默认只接收 `task` 与显式 `context`，使用 `SessionManager.inMemory()`。
- `inherit_parent_context` 仅允许发送到与 parent 相同的 Provider，并在 run snapshot 标识来源与字符数。
- `crossProviderDelegation=true` 只允许把 task 和显式 context 发给另一 Provider；完整父历史始终禁止跨 Provider。
- Redaction 是 defense-in-depth，不作为跨 Provider 授权机制。

## 3. Identity And User Authority

- Teammate 的 `systemPrompt`、tool ceiling、routing 与 identity 来自可信项目配置；单次调用不得用 `system_prompt` 替换。
- 持久创建、更新、暂停、归档、reset、model/pool change 只接受结构化 `/agents` 命令或等价 typed UI action。
- 不从普通自然语言关键词推断持久 mutation authorization 或 required override。
- required override 必须是显式 typed action，并带 `turn` 或 `session` scope；默认只作用当前 turn。
- required 状态仅由绑定当前 root task epoch、正确 Teammate ID 且成功结束的 run 满足。

## 4. Tool And Workspace Boundary

- Child tools 不得超过 parent tool allowlist 与 execution Policy。
- read/ls/find/grep 保持 workspace/symlink fail-closed 边界。
- child bash 一律按 writer 处理；不得根据 executable 名称推断 read-only。
- bash/edit/write 共享按 workspace 标识的跨进程 writer lease；等待、取消、owner loss 和 stale lock 均有确定性行为。
- child bash 默认无网络；只有明确分类为 network 且通过 Policy 的命令才共享网络 namespace。间接或无法分类的网络方式保持不可达。

## 5. Persistent Lane Continuity

- 每个 `<teammate, lane>` prompt、reset 和 model switch 必须获取跨进程 Session lease。
- owner 冲突 fail closed，并在 `/agents` 显示 owner/waiting 状态；不静默打开同一 Session。
- reset 创建新 lane epoch，不删除旧历史；stale branch 或模型身份变化需要显式重建 session runtime。
- Task Agent 不保留完整 Session；Teammate lane 按项目配置持久。

## 6. Cancellation And Cascading Failure

- root cancel 必须调用 tree cancellation，拒绝 queued waiters，并 abort active descendants。
- cancelled tree 不得再创建 child；ancestor generation slot 恢复必须带同一 AbortSignal。
- lane/session/config 持久化失败时回滚内存状态并保持 fail closed。

## 7. Audit And UI

- Task Agent 只持久化有界审计投影：run/tree/parent IDs、模型、Provider、Effort、context mode/size、tools、状态、usage、budget、时间和脱敏事件摘要。
- UI 将详情命名为 `Timeline`；只有确实读取持久 lane Session 时才使用 `Transcript`。
- 不显示原始凭据、完整 system prompt、未脱敏 tool output 或主机绝对 Session 路径。
- 40/80/120 列必须显示 current/preferred model、fallback、required/override scope、lane owner 与剩余预算且不溢出。

## 8. Threat Matrix

| Threat | Required Control | Verification |
| --- | --- | --- |
| Parent history exfiltration | Same-Provider-only inheritance | OpenAI parent → other Provider inheritance rejected before session creation |
| Teammate identity replacement | Immutable configured system prompt | Teammate call with `system_prompt` rejected |
| False user authorization | Typed action only | Negated/quoted/audit text never grants mutation or override |
| Writer bypass through shell | All bash is writer + cross-process lease | `node -e writeFileSync` serializes with edit/write |
| Lane corruption | Session lease + epoch/stale checks | Two processes cannot prompt/reset the same lane concurrently |
| Recursive cost explosion | run/tree token, cost and time gates | queued and recursive starts stop at each boundary |
| Cancelled descendants continue | tree cancellation + AbortSignal propagation | active and queued descendants terminate without new starts |
| Misleading audit UI | Structured bounded timeline | UI distinguishes preview/timeline/transcript and shows limits truthfully |

## S1 Acceptance Criteria

- 默认值和硬上限可以作为实现合同。
- 跨 Provider、Task Agent 留存与 Teammate identity 策略明确，无模型自行扩大权限的路径。
- 单写者、lane lease、预算和取消均是 M2/M3 的阻塞性验收项。
- UI 使用结构化 timeline，不把 bounded preview 描述成完整 transcript。
- 接受只授权进入 M2；不代表接受后续 Runtime/UI Stone。

## Acceptance

- 2026-08-09：用户明确“接收并继续”，接受 `S1` 并授权进入 `M2`。
