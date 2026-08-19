---
kind: audit-report
cycle: C19-vspi-subagent-runtime-audit
milestone: M4
status: waiting-review
updated: 2026-08-18T22:34:00+08:00
---

# VSPi Subagent Runtime 现状审计

## 一、结论

当前 VSPi Subagent 存在一个可稳定触发的复合故障：用户只要在消息中讨论 `Subagent`，runtime 就可能把它误判为“本轮明确要求必须使用 Subagent”；一旦子代理因预算或 child 限制全部失败，回合末断言会否决已经生成的主代理回答，app 再删除本轮 transcript 并把用户原文恢复到 composer。用户看到的“问题被退回来”是这条失败恢复链的直接结果。

该故障在当前 `main` / v1.1.1 源码中仍存在，没有未提交的 Agent 修补。它不是单一 UI 问题，而是意图识别、调度限制、预算结算和提交事务四层组合后的系统性失败。

## 二、证据范围

- 正确会话：`~/.pi/agent/sessions/--home-heyx-Workspace-VSP-VSPi--/2026-08-18T13-54-52-342Z_01a01527-4d36-7d6a-ac2c-1c0567bd2a4c.jsonl`。
- session header：cwd 为 `/home/heyx/Workspace/VSP/VSPi`，确认由 VSPi 原生 Pi runtime 保存。
- 排除项：`~/.codex/sessions/` 中的 VSP-Codex Agent Workspace 会话与源码不属于本审计对象。
- 静态证据：当前 `src/agents/`、`src/backend/pi-runtime-backend.ts`、`src/app/vspi-app.ts` 与相关测试。
- 动态验证：现有 Agent 定向测试 8 files / 49 tests 全部通过。

## 三、故障时间线

1. 21:57:04（UTC+8，下同）：用户要求“研究”Subagent 稳定性、预算机制和 Codex v2；原文没有要求本轮必须调用 Subagent。
2. 同轮在用户消息前自动插入隐藏 `vspi.agent-capabilities`：`The user explicitly required subagent use for this turn.`
3. 21:57:19：主代理两次 bash 侦察均被 `The user explicitly required a subagent before main-agent mutation` 拒绝。命令本身是读取，但包含 `&&`/pipe，被 bash 分类器归为非只读 process。
4. 21:58:36：主代理并行发出 4 个 Subagent 调用。
5. 22:09:07：约十分钟后，三个调用分别报 `Agent run token budget exceeded (340362/120000)`、`(520600/120000)`、`(485097/120000)`；第四个报 `Agent child limit exceeded (3)`。
6. 22:09:07：用户明确反馈“全是 Error”“发 4 个结果发 3 个就失效”“卡得要死”“进度信息不全面”。
7. 22:19:47：相同问题再次出现，并追加“我问的问题都给我退回来”。源码确认 app 在 backend send 抛错时会恢复原始 draft，因此该现象有直接实现依据。
8. 22:22:42：用户在当时会话选择先产出设计文档；22:24:03 主响应 aborted，仓库中未生成相应设计文档或源码修补。

## 四、问题分级

### P0：讨论关键词被误判为强制委派，并可回滚完整主回答

- `beginRootTask()` 使用宽泛正则匹配 `subagent`、`子代理`、`子智能体` 等词；只要没有命中少量否定词，就设置 `explicitAgentRequired=true`。
- runtime 随后把“用户明确要求使用 Subagent”作为隐藏 capability 注入模型上下文。
- 在没有成功 Subagent 时，`assertRootTaskComplete()` 于 `session.prompt()` 完成后抛错。
- `VspiApp.submit()` 捕获异常后把 transcript 截回提交前长度，并把用户原文恢复到 composer。

结果：讨论 Subagent 本身就会改变执行权限；即使主模型已生成有效回答，也可能在回合提交阶段全部消失。用户继续在恢复后的原文中谈论 Subagent，又会重新触发同一规则，形成自强化失败循环。

证据：`src/agents/manager.ts:267`、`:301`、`:333`、`:346`；`src/backend/pi-runtime-backend.ts:502`；`src/app/vspi-app.ts:1209`。

### P0：run budget 在完整执行后结算，并用预算错误覆盖已有成果

- 默认单 run 上限为 120,000 tokens。
- usage 汇总对子 session 的每条 assistant 消息累加 input、output、cacheRead、cacheWrite。
- 四类 token 被等权相加作为 `runTokensUsed`，tree usage 使用同一口径。
- `assertRunTokenBudget()` 位于完整 `await session.prompt()` 之后；超限时不返回已生成的 final output，而是抛出预算错误。
- catch 路径会再次优先执行同一预算断言，因此原始 provider/agent error 也可能被预算错误覆盖。

结果：真实长任务可以耗费完整时间与调用成本、产生输出，然后在最后一步把结果丢弃。目标会话中的三次 34 万至 52 万超限均属于该路径。

可以确认这些数值来自子 session 多轮 assistant usage 的累计；现有日志不足以量化其中 cacheRead/cacheWrite 的精确占比，也不支持“计入父会话累计 token”这一更强说法。

证据：`src/agents/config.ts:23`；`src/agents/manager.ts:782`、`:1188`、`:1379`；`src/agents/scheduler.ts:144`。

### P1：未披露的 per-parent 累计 child=3 限制

- scheduler 另有硬编码 `DEFAULT_AGENT_MAX_CHILDREN=3`。
- 同一 parent 的 child 计数只增不减，直到整棵 tree 被销毁；它不是“同时运行 3 个”的并发槽语义。
- 工具描述只告诉模型 depth、12 agents per tree、16 concurrent generations，没有披露 per-parent 3。

结果：root 在同一 turn 中发第 4 个并行任务时必定失败，即使 tree 总量和全局 generation concurrency 都有余量。目标会话精确复现该行为。

证据：`src/agents/scheduler.ts:3`、`:99`；`src/agents/manager.ts:210`。

### P1：当前 Task Agent 是阻塞式一次性调用，不是可交互个体

- `subagent` tool 直接等待 `run()` 完成后才返回。
- Task Agent 使用 `SessionManager.inMemory()`，run 结束后 dispose。
- runtime 没有可寻址的 spawn/send/follow-up/wait/interrupt 生命周期；持久 lane 仅用于预配置 Teammate。
- `AgentRunSnapshot` 使用随机 run/tree ID，缺少 durable agent identity 与 root Session/turn 归属。

这与用户期望的“独立个体，Main Agent 可继续 interact、插入消息”存在结构性差距。按 C07 历史合同，一次性 Task Agent 是当时的明确边界，因此这是当前能力模型与新需求不一致，不是无意实现偏差。

证据：`src/agents/manager.ts:228`、`:506`、`:718`；`src/agents/types.ts:58`；C07 `SECURITY-CONTRACT.md`。

### P2：进度投影存在，但信息粒度不足且以剩余预算为中心

- 主 transcript 仅显示 task、budget left 和单行 `outputPreview`；无当前 tool、turn 阶段、最近活动时间或可交互入口。
- `/agents` Timeline 只有 queued/started/fallback/completed/failed/cancelled/budget 等 run 级事件。
- Agent snapshot、active/recent、message ID 去重均为进程内状态，没有 session replay/rehydration 合同。

结果：长达十分钟的运行对用户主要表现为 `Working...`、截断 preview 和持续下降的 `run/tree tokens left`，无法判断正在调用什么工具、是否仍有进展、能否介入。

证据：`src/ui/transcript.ts:548`；`src/ui/panels.ts:2424`；`src/agents/manager.ts:1210`。

## 五、为何测试没有拦住

现有测试明确覆盖并固化了若干当前语义：

- “提到 subagent”会触发 required gate，成功一次后解除。
- 同一 parent 创建第 4 个 child 会失败。
- 小型 synthetic session 超过 1,000 tokens 会报 budget error。
- 单个 live manager 内的 queued/running/success/error/cancelled 投影、权限、lane ownership 与 UI 渲染。

缺少的组合场景：

- 仅讨论 Subagent、没有祈使委派意图时不得改变权限。
- 子代理已经产出 final answer 后预算检查不得让成果不可见。
- 大量 cacheRead/cacheWrite 的真实多轮运行。
- 主模型已经给出 final，但回合末 authority assertion 失败时 app 的端到端表现。
- 工具公开 limits 与 scheduler 实际最先触发限制的一致性。
- resume/replay 后 Agent snapshot、root Session 归属和终态恢复。

因此 8 files / 49 tests 全绿与当前 Bug 并不矛盾：测试验证的是局部实现按既定规则工作，没有验证这些规则组合后的用户级事务语义。

## 六、当前状态与未决边界

- 当前 `main` HEAD 为 `48f85a0`，发布版本为 v1.1.1；相关 Agent 源码无未提交修补。
- C07 的安全、writer 互斥、workspace boundary、Teammate lane ownership 仍是有效历史合同；本审计没有判定这些边界应如何调整。
- 三次 run 超限中各 token 类型的精确拆分未保存在可见 tool result 中，需要可控复现才能量化。
- 本报告不决定预算应否保留、限制应采用什么语义、Task Agent 是否持久化，也不选择 Codex v2 的移植边界；这些属于用户批准现状后的方案讨论。
