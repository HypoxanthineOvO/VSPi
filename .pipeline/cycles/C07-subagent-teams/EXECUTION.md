---
kind: execution-log
cycle: C07-subagent-teams
updated: 2026-08-09T14:23:00+08:00
---

# VSPi Subagent 与项目 Teammate 完整计划执行记录

## 2026-07-30 - 计划提出并等待交付审批

- **计划项：** 计划（m1-m5）提出
- **目的：** 将 Task Agent/Teammate 完整能力计划（含 2 个 Stone）提出，等待交付审批。
- **结果：** delivery `vspi-subagent-teams` 状态 proposed，revision 0；continuation `next_action: request_delivery_approval`。
- **证据：** `.pipeline/runtime/objects/delivery/vspi-subagent-teams/runtime.yaml`、`continuation.yaml`。
- **计划影响：** Cycle active，尚无 milestone 完成。
- **遇到的问题：** 能力范围大，拆分为 m1-m5 与 2 个 Stone 控制验收粒度。
- **下一步：** 等待交付审批；审批后执行 m1。

## 2026-08-09 - 启动前设计与现状审计

- **范围：** 只审计 C07 proposal 与当前 `src/agents/` / tests，不启动源码执行。
- **结论：** 不建议批准 revision 0 原计划。m1–m4 的大量能力已由 C05 后续源码实现，继续按旧顺序会重复；m3 与安全边界仍有实质缺口。
- **高风险发现：** explicit `model` + `inherit_parent_context` 可在 `crossProviderDelegation=false` 下把父历史发往另一 Provider；Teammate 调用可用 `system_prompt` 覆盖持久角色；Bash 的 read-only 启发式把可写 `node`/`npm` 命令放出单写者边界；lane 无跨进程 Session lease；无 per-run/tree token、cost、time 熔断。
- **重要不一致：** Plan/决策声明 depth 5 / tree 128 / concurrency 16 且可配置；production scheduler 默认 3 / 12 / 16，仅 concurrency 可配置，UI/backend fallback 又硬编码 5/128/16。
- **验收结构缺口：** 现有 Stone 未单独审查授权 intent、跨 Provider 数据边界、持久 lane 多进程一致性和资源预算；`/agents` Transcript 当前只是 output preview。
- **证据：** `src/agents/{manager,scheduler,config,workspace-tools}.ts`、`src/policy/pi-policy-tools.ts`、`test/agents-*.test.ts`；全量 110 files / 801 tests 通过说明现有测试未覆盖上述设计风险。
- **下一步：** 重写为基于现状的 corrective Plan，并在任何实现前增加安全/权限 Stone。

## 2026-08-09 - M1 Corrective Plan 与安全合同完成

- **计划项：** `M1` → `S1 waiting-review`
- **授权：** 用户确认“按你的来”，同意采用启动前审计提出的 corrective 方向。
- **动作：** 用稳定 ID 重写 Plan；将安全审阅前置；创建 `SECURITY-CONTRACT.md`，冻结 limits、Provider/context、identity/authority、workspace writer、lane lease、预算、取消和 UI 合同。
- **结果：** `M1 completed`；`S1 security-contract-review` 等待用户审阅。Agent 源码尚未修改。
- **验证：** Plan 与 Progress 的八个 ID 完整镜像，`current: S1` 存在；legacy Delivery 未修改。
- **下一步：** 展示安全合同核心内容；接受后进入 `M2`。

## 2026-08-09 - S1 安全合同接受

- **计划项：** `S1` → `M2`
- **用户决定：** “接收并继续”。
- **接受范围：** 接受 `SECURITY-CONTRACT.md` 的 limits、Provider/context、identity/authority、writer、lane、budget、cancel 与 audit/UI 边界，并授权进入 M2。
- **保留审阅点：** `S2 agent-runtime-review` 与 `S3 agents-ui-review` 未被提前接受。
- **下一步：** M2 Scheduler 与 Task Agent corrective implementation。

## 2026-08-09 - M2 Scheduler 与 Task Agent corrective implementation

- **实现：** config 增加 depth/tree/concurrency、run/tree token、tree cost 和 run deadline；默认 3/12/16、120k/500k/20 USD/900s，可信项目 ceiling 5/128/16。
- **隔离：** Task Agent 改用 `SessionManager.inMemory()`；完整父历史只允许同 Provider；显式开启跨 Provider 时仍只发送 task + explicit context。
- **资源：** scheduler 聚合成功与失败 attempt usage，fallback/descendant 前检查 tree budget；deadline abort；root cancel 传播到 active/queued descendants。
- **写入：** 所有 Bash 均按 writer；writer 使用 workspace identity 的可取消跨进程 lease，并支持 heartbeat/stale owner 回收；Bubblewrap 将 `.vspi` 控制目录只读挂载。
- **验证：** limits、budget、deadline、cross-Provider、in-memory、cancel、writer contention、stale owner 与间接 `node -e writeFileSync` 均有定向回归。
- **遇到的问题：** 旧测试依赖未授权跨 Provider fallback；已改为同 Provider fixture，并新增 fail-closed / explicit-context 正向测试。审计中发现失败 quota attempt 未计费，已将 usage 记录下沉到每个 Session attempt。
- **结果：** `M2 completed`，自动进入 M3。

## 2026-08-09 - M3 Teammate authority 与持久连续性

- **Authority：** 移除 natural-language mutation/override 推断；模型工具始终拒绝直接写 `.vspi/agents.json`/lane；新增 `/agents override <id|all> [turn|session]` typed action。
- **Identity/routing：** Teammate call 拒绝 `system_prompt`；required 只由当前 root task epoch 中正确 Teammate 的成功 run 满足；preferred/consult 是非阻塞提示，manual 仅显式调用。
- **Continuity：** prompt/reset 获取 teammate gate + lane lease，model switch 获取 teammate gate；config mutation 另有 config lease。获得 lease 后重新读取 project config 和最近 Session，reset 创建新 Session epoch，不删除旧历史。
- **并发与失败：** 跨 manager 同 lane prompt/reset/model switch 冲突 fail closed；sticky fallback 在 config lease 内原子保存，持久化失败回滚；旧 manager 在 lease 后采用最新 model/identity。
- **验证：** Agent 定向 suite 7 files / 44 tests 通过；`npm run check`、`npm run build`、`npm test` 通过，全量 112 files / 822 tests。
- **遇到的问题：** 自审发现仅重开 lane history 仍会保留 stale config 并可能覆盖另一进程写入；已补 config lease、lease 后 refresh 与 stale-manager 回归。
- **结果：** `M3 completed`；`S2 agent-runtime-review` 进入 `waiting-review`，未开始 M4。

## 2026-08-09 - S2 Agent Runtime Review 接受

- **计划项：** `S2` → `M4`
- **用户决定：** 在结构化审阅中选择“接受并继续”。
- **接受结果：** M2/M3 Runtime corrective implementation、Agent 定向 44 tests 与全量 112 files / 822 tests 证据。
- **接受范围：** 只接受 Runtime；不接受尚未实现的 audit/UI，也不关闭 C07。
- **下一步：** M4 审计投影与 `/agents` UI corrective implementation。

## 2026-08-09 - M4 审计投影与 /agents UI

- **审计投影：** run snapshot 增加 Provider、context chars、聚合 usage、run/tree budget、deadline 与最多 32 条固定类型 Timeline event；task/output preview 脱敏并分别限制 500/4,000 字符，不携带 Session 路径。
- **预算真值：** fallback attempt usage 聚合到同一 run；同 tree 后续 usage 刷新所有 sibling projection；主 Transcript 显示剩余 run/tree token 与 tree cost。
- **Authority/ownership：** Snapshot 展示 pending required、turn/session override、task epoch；lane 展示 idle/owned/waiting/blocked 与 owner，冲突不暴露 lease token。
- **Agent Panel：** `Map / Transcript / Tools / Pools` 改为 `Map / Timeline / Tools / Pools`；Timeline 展示 ID、Provider/model、context、usage/budget、事件与脱敏 preview；Tools 不显示绝对 Session 路径。
- **响应式：** limits、ID、context、budget、usage、model/fallback 与 owner 使用硬换行；40/80/120 列均验证关键信息可见且所有行不溢出。
- **真实终端：** 新增 PTY 测试，在 40 列真实提交 `/agents` 并导航四个 tab，再 resize 到 80/120；没有只依赖静态字符串断言。
- **额外修正：** Teammate per-call tools 现在必须是配置 tool ceiling 的子集；turn override 在 root task 完成后清除并刷新 UI。
- **验证：** Agent/UI focused 9 files / 79 tests；`npm run check`、`npm run build`、`npm test` 全部通过，完整为 113 files / 827 tests；`git diff --check` 通过。
- **结果：** `M4 completed`；`S3 agents-ui-review` 进入 `waiting-review`，未开始 M5。

## 2026-08-09 - S3 Agents UI Review 接受

- **计划项：** `S3` → `M5`
- **用户决定：** 在结构化审阅中选择“接受并继续”。
- **接受结果：** M4 bounded/redacted Timeline、budget/authority/lane owner、40/80/120 与真实 PTY `/agents`。
- **接受范围：** 授权最终安全回归与 Cycle close；不授权 commit、push、release、publish 或付费模型调用。
- **下一步：** M5 dependency、smoke、PTY、harness、docs 与最终全量门禁。

## 2026-08-09 - M5 最终安全回归与 Cycle close

- **Dependency：** `npm audit --omit=dev` 报告 0 vulnerabilities；`npm ls --depth=0` 正常，pi 为 0.84.1，嵌套 protobufjs 为 7.6.5。
- **Runtime/UI：** `npm run smoke` 通过；`npm run test:pty` 为 3 files / 11 tests；真实 `/agents` PTY 为 1/1。
- **Harness：** `npm run harness:check` 只读完成、No files changed；报告 anthropic/moonshot 上游 hash 变化和三个 `git ls-remote` warning，均不改变本地验证结果。
- **Docs：** 清除 README 中 pi 0.81.1 / protobufjs 7.6.4 陈旧说明；docs contract 10/10；旧 1-128 / Map-Transcript / Task persisted Session 文案扫描为空。
- **完整门禁：** `npm run check`、`npm run build`、`npm test` 通过，最终 113 files / 827 tests；`git diff --check` 通过。
- **Memory：** 新增 cycle-scoped decision `decision-edcc60dceb747cf67ae8e64d3fba5a39`，supersede 旧 revision 0 的 `decision-76fa...`；YAML 解析和 active mapping 已验证。
- **保护：** legacy Delivery `vspi-subagent-teams` 未修改；没有 commit、push、release、publish 或付费模型调用。
- **结果：** `M5 completed`；C07 closed。
