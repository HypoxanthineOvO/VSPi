---
authority_role: record
confidence: confirmed
created_at: 2026-07-31T15:21:16.116Z
dedupe_key: goal.vspi-persistent-goal-runner.plan
id: decision-baffd8ff43460fad6d6158f1ad3f6d3b
kind: decision
schema_version: '1'
scope:
  ref: vspi-persistent-goal-runner
  type: goal
semantic_hash: baffd8ff43460fad6d6158f1ad3f6d3b49cb36cfdc3ef080e23dfe632bf37fc2
source_refs:
  - locator: compiled-plan
    ref: goal:vspi-persistent-goal-runner:revision:0
    type: delivery_plan
supersedes: []
updated_at: 2026-07-31T15:21:16.116Z
---
# VSPi 持久 Goal Runner

VSPi 通过 `/goal` 提供项目持久、可恢复且有安全边界的长期任务执行：模型维护 Working Plan 与 Progress Markers，普通阶段总结不会终止未完成 Goal，只有真实完成、阻塞、暂停、取消或预算边界能够停止自动续跑。

```json
{
  "acceptance_criteria": [
    {
      "id": "goal-command-contract",
      "statement": "`/goal <request>` 创建并启动一个 workspace 持久 Goal；`/goal status|pause|resume|cancel|accept` 提供明确控制，同一 Session 只绑定一个 Goal，同一 Goal 同时只有一个执行 owner。",
      "verification": "命令解析、CAS 状态转换、并发 owner、重复命令、非法转换和跨 Session 绑定测试通过。"
    },
    {
      "id": "user-authoritative-contract",
      "statement": "Goal Contract 保存用户目标与完成标准，模型和 Working Plan 更新不能静默删除、缩小或替换该 Contract；只有明确用户操作能够修改、取消或接受。",
      "verification": "权限与状态机测试证明模型工具不能改写 Contract，用户修改具有显式 revision，并覆盖陈旧 revision 冲突。"
    },
    {
      "id": "working-plan-markers",
      "statement": "每个 Goal 引用一个可变 Local Plan，并维护紧凑 Progress Markers，记录当前项、已完成工作、证据、下一项和最近有效进展；Plan 更新和 Marker 记录均不是完成信号。",
      "verification": "持久化、重启、CAS 冲突、500 项边界、checkpoint 压缩与 Plan 普通模式兼容测试通过。"
    },
    {
      "id": "automatic-continuation",
      "statement": "Goal 为 executing 且完成标准未满足时，模型普通 final response 或阶段总结会通过 Pi 原生 followUp 继续同一任务，不要求用户重复发送继续，也不通过递归 send 制造重入。",
      "verification": "Backend 事件测试覆盖正常 final、连续多轮、流式队列、steer/followUp、重复 agent_end、取消竞态和无递归 generation。"
    },
    {
      "id": "structured-stop-states",
      "statement": "结构化 goal_complete 只把 Goal 置为 pending_acceptance；goal_block 记录阻塞、已尝试方案和所需用户输入；paused、stalled、cancelled 与 completed 在状态和界面上明确区分。",
      "verification": "工具 schema、状态转换、伪完成、开放 Plan、缺失证据、真实阻塞、用户接受与拒绝恢复测试通过。"
    },
    {
      "id": "budget-and-stall-safety",
      "statement": "自动执行具有可配置的轮次、用量与无进展边界；达到边界时暂停或 stalled 并通知用户，绝不静默继续计费或伪报完成。",
      "verification": "确定性虚拟时钟与 usage 测试覆盖所有预算、阈值、重置、恢复和连续无进展行为。"
    },
    {
      "id": "session-continuity",
      "statement": "Goal、Plan、Marker 与执行状态跨 compaction、resume、fork 和安全 handoff 保留；退出进程或失去 owner 时停止生成，恢复必须显式且不会重复执行已完成工作。",
      "verification": "SessionManager、compaction、进程 handoff、lease、restart 和恢复测试证明单 owner、无重复 followUp 与一致 checkpoint。"
    },
    {
      "id": "worker-integration",
      "statement": "Goal Runner 可以使用 Task Agent 与持久 Teammate lane 作为 Worker，但 Goal Contract、停止权和最终状态仍由 root Goal authority 管理；模型 fallback 不改变 Goal 语义。",
      "verification": "集成测试覆盖 Task Agent、Teammate lane、sticky fallback、取消传播、Worker 失败与 root Goal 继续或阻塞。"
    },
    {
      "id": "goal-visibility",
      "statement": "Transcript、Status 与 `/goal` 面板展示目标、状态、当前项、进度、有效模型、自动轮次、预算、最近 Marker、阻塞和下一动作，40/80/120 列均不溢出。",
      "verification": "面板、Transcript、交互、ANSI 宽度、长文本和真实 PTY 测试通过。"
    },
    {
      "id": "compatibility-boundary",
      "statement": "普通聊天和普通 `/plan` 保持被动语义；Recovery 禁用 Goal 自动续跑；Policy、Question、Skill、Subagent、Session cancel 与 Workflow 只读投影不回归。",
      "verification": "现有合同测试、Recovery、Policy、Question、Skill、Plan、Subagent、Session lifecycle 和 handoff 回归全部通过。"
    },
    {
      "id": "regression-quality",
      "statement": "TypeScript、Biome、目标 Vitest、全量 Vitest、build、render-once smoke、package install、PTY 与依赖审计均通过，验证证据存放在 Record Store 之外的 `.pipeline` evidence 路径。",
      "verification": "完整分层验证记录与文件 SHA-256 由 Goal Core 校验。"
    }
  ],
  "constraints": [
    "无中间 Stone；确认开始后连续实现，最终统一人工验收。",
    "复用 Pi Native AgentSession、followUp、SessionManager 与现有 VSPi Local Plan，不新增第三方运行时或通过 CLI 子进程模拟 Agent。",
    "Goal authority 与 Working Plan 分离：模型可修改 Plan，但不可修改用户 Contract。",
    "v1 只在前台 VSPi 进程自动执行；退出、显式暂停、取消、预算或失去 owner 都停止生成，不实现后台 daemon 或定时任务。",
    "不实现云同步、多写者 Goal、自动模型恢复或独立 worktree；模型显式切换与既有 sticky fallback 语义保持不变。",
    "模型上下文只暴露 Goal 的真实状态、可用结构化接口和硬停止边界，不注入任务拆解教程或领域工作流。",
    "保留当前 dirty worktree 中用户已有 Session、PTY 与 Subagent 修改，不回滚、不覆盖，不提交、不推送、不发布、不调用真实付费模型。",
    "既有 accepted Delivery 的受保护证据不直接移动或修改；本 Goal 的验证证据必须写在 Record Store 外，避免扩大已知 Workflow 索引冲突。"
  ],
  "delivery_kind": "goal",
  "design": {
    "acceptance_criteria": [
      {
        "id": "goal-command-contract",
        "statement": "`/goal <request>` 创建并启动一个 workspace 持久 Goal；`/goal status|pause|resume|cancel|accept` 提供明确控制，同一 Session 只绑定一个 Goal，同一 Goal 同时只有一个执行 owner。",
        "verification": "命令解析、CAS 状态转换、并发 owner、重复命令、非法转换和跨 Session 绑定测试通过。"
      },
      {
        "id": "user-authoritative-contract",
        "statement": "Goal Contract 保存用户目标与完成标准，模型和 Working Plan 更新不能静默删除、缩小或替换该 Contract；只有明确用户操作能够修改、取消或接受。",
        "verification": "权限与状态机测试证明模型工具不能改写 Contract，用户修改具有显式 revision，并覆盖陈旧 revision 冲突。"
      },
      {
        "id": "working-plan-markers",
        "statement": "每个 Goal 引用一个可变 Local Plan，并维护紧凑 Progress Markers，记录当前项、已完成工作、证据、下一项和最近有效进展；Plan 更新和 Marker 记录均不是完成信号。",
        "verification": "持久化、重启、CAS 冲突、500 项边界、checkpoint 压缩与 Plan 普通模式兼容测试通过。"
      },
      {
        "id": "automatic-continuation",
        "statement": "Goal 为 executing 且完成标准未满足时，模型普通 final response 或阶段总结会通过 Pi 原生 followUp 继续同一任务，不要求用户重复发送继续，也不通过递归 send 制造重入。",
        "verification": "Backend 事件测试覆盖正常 final、连续多轮、流式队列、steer/followUp、重复 agent_end、取消竞态和无递归 generation。"
      },
      {
        "id": "structured-stop-states",
        "statement": "结构化 goal_complete 只把 Goal 置为 pending_acceptance；goal_block 记录阻塞、已尝试方案和所需用户输入；paused、stalled、cancelled 与 completed 在状态和界面上明确区分。",
        "verification": "工具 schema、状态转换、伪完成、开放 Plan、缺失证据、真实阻塞、用户接受与拒绝恢复测试通过。"
      },
      {
        "id": "budget-and-stall-safety",
        "statement": "自动执行具有可配置的轮次、用量与无进展边界；达到边界时暂停或 stalled 并通知用户，绝不静默继续计费或伪报完成。",
        "verification": "确定性虚拟时钟与 usage 测试覆盖所有预算、阈值、重置、恢复和连续无进展行为。"
      },
      {
        "id": "session-continuity",
        "statement": "Goal、Plan、Marker 与执行状态跨 compaction、resume、fork 和安全 handoff 保留；退出进程或失去 owner 时停止生成，恢复必须显式且不会重复执行已完成工作。",
        "verification": "SessionManager、compaction、进程 handoff、lease、restart 和恢复测试证明单 owner、无重复 followUp 与一致 checkpoint。"
      },
      {
        "id": "worker-integration",
        "statement": "Goal Runner 可以使用 Task Agent 与持久 Teammate lane 作为 Worker，但 Goal Contract、停止权和最终状态仍由 root Goal authority 管理；模型 fallback 不改变 Goal 语义。",
        "verification": "集成测试覆盖 Task Agent、Teammate lane、sticky fallback、取消传播、Worker 失败与 root Goal 继续或阻塞。"
      },
      {
        "id": "goal-visibility",
        "statement": "Transcript、Status 与 `/goal` 面板展示目标、状态、当前项、进度、有效模型、自动轮次、预算、最近 Marker、阻塞和下一动作，40/80/120 列均不溢出。",
        "verification": "面板、Transcript、交互、ANSI 宽度、长文本和真实 PTY 测试通过。"
      },
      {
        "id": "compatibility-boundary",
        "statement": "普通聊天和普通 `/plan` 保持被动语义；Recovery 禁用 Goal 自动续跑；Policy、Question、Skill、Subagent、Session cancel 与 Workflow 只读投影不回归。",
        "verification": "现有合同测试、Recovery、Policy、Question、Skill、Plan、Subagent、Session lifecycle 和 handoff 回归全部通过。"
      },
      {
        "id": "regression-quality",
        "statement": "TypeScript、Biome、目标 Vitest、全量 Vitest、build、render-once smoke、package install、PTY 与依赖审计均通过，验证证据存放在 Record Store 之外的 `.pipeline` evidence 路径。",
        "verification": "完整分层验证记录与文件 SHA-256 由 Goal Core 校验。"
      }
    ],
    "constraints": [
      "无中间 Stone；确认开始后连续实现，最终统一人工验收。",
      "复用 Pi Native AgentSession、followUp、SessionManager 与现有 VSPi Local Plan，不新增第三方运行时或通过 CLI 子进程模拟 Agent。",
      "Goal authority 与 Working Plan 分离：模型可修改 Plan，但不可修改用户 Contract。",
      "v1 只在前台 VSPi 进程自动执行；退出、显式暂停、取消、预算或失去 owner 都停止生成，不实现后台 daemon 或定时任务。",
      "不实现云同步、多写者 Goal、自动模型恢复或独立 worktree；模型显式切换与既有 sticky fallback 语义保持不变。",
      "模型上下文只暴露 Goal 的真实状态、可用结构化接口和硬停止边界，不注入任务拆解教程或领域工作流。",
      "保留当前 dirty worktree 中用户已有 Session、PTY 与 Subagent 修改，不回滚、不覆盖，不提交、不推送、不发布、不调用真实付费模型。",
      "既有 accepted Delivery 的受保护证据不直接移动或修改；本 Goal 的验证证据必须写在 Record Store 外，避免扩大已知 Workflow 索引冲突。"
    ],
    "evidence": [
      {
        "ref": "current-chat-2026-07-31",
        "summary": "用户确认 `/goal` 应维护用户权威 Contract、模型可变 Working Plan、Progress Markers、自动续跑和可恢复 blocked，而不是在阶段总结后停止。",
        "type": "user-decision"
      },
      {
        "ref": "src/plans/local-plan-backend.ts",
        "summary": "现有 workspace 隔离 Local Plan 已提供 revision、CAS、持久工作项、focus、blocker 和原子 HEAD。",
        "type": "repository"
      },
      {
        "ref": "src/plans/tools.ts",
        "summary": "现有结构化 Plan tools 明确 Plan 更新只记录进度，不完成或停止当前用户任务。",
        "type": "repository"
      },
      {
        "ref": "src/backend/pi-runtime-backend.ts",
        "summary": "当前 Pi runtime 已具备 native followUp、task epoch、compaction 自动续跑、完成声明检测、Plan checkpoint、Session lease 和 handoff 边界。",
        "type": "repository"
      },
      {
        "ref": "src/continuity/review-tracker.ts",
        "summary": "现有 review tracker 能检测轮次、工作事件、重复失败、压缩与完成声明，可扩展为 Goal progress/stall 信号。",
        "type": "repository"
      },
      {
        "ref": "src/agents/manager.ts",
        "summary": "Task Agent 与 Teammate 已提供持久 lane、状态、取消、模型 fallback 和 root 权限边界，可作为 Goal Worker。",
        "type": "repository"
      },
      {
        "ref": "ERR_RECORD_SCHEMA_INVALID-2026-07-31",
        "summary": "上一 accepted Goal 的 evidence Markdown 位于 Record Store 下，导致 Maintain 索引扫描失败；新 Goal 证据必须使用独立 `.pipeline/evidence` 路径。",
        "type": "workflow-diagnostic"
      },
      {
        "ref": "goal-runner-implement",
        "summary": "Worker routing critical (high_blast_radius); execution remains solo-verified because the change is tightly coupled and deterministic tests provide a strong oracle.",
        "type": "task-assessment"
      }
    ],
    "outcome": "VSPi 通过 `/goal` 提供项目持久、可恢复且有安全边界的长期任务执行：模型维护 Working Plan 与 Progress Markers，普通阶段总结不会终止未完成 Goal，只有真实完成、阻塞、暂停、取消或预算边界能够停止自动续跑。"
  },
  "evidence": [
    {
      "ref": "current-chat-2026-07-31",
      "summary": "用户确认 `/goal` 应维护用户权威 Contract、模型可变 Working Plan、Progress Markers、自动续跑和可恢复 blocked，而不是在阶段总结后停止。",
      "type": "user-decision"
    },
    {
      "ref": "src/plans/local-plan-backend.ts",
      "summary": "现有 workspace 隔离 Local Plan 已提供 revision、CAS、持久工作项、focus、blocker 和原子 HEAD。",
      "type": "repository"
    },
    {
      "ref": "src/plans/tools.ts",
      "summary": "现有结构化 Plan tools 明确 Plan 更新只记录进度，不完成或停止当前用户任务。",
      "type": "repository"
    },
    {
      "ref": "src/backend/pi-runtime-backend.ts",
      "summary": "当前 Pi runtime 已具备 native followUp、task epoch、compaction 自动续跑、完成声明检测、Plan checkpoint、Session lease 和 handoff 边界。",
      "type": "repository"
    },
    {
      "ref": "src/continuity/review-tracker.ts",
      "summary": "现有 review tracker 能检测轮次、工作事件、重复失败、压缩与完成声明，可扩展为 Goal progress/stall 信号。",
      "type": "repository"
    },
    {
      "ref": "src/agents/manager.ts",
      "summary": "Task Agent 与 Teammate 已提供持久 lane、状态、取消、模型 fallback 和 root 权限边界，可作为 Goal Worker。",
      "type": "repository"
    },
    {
      "ref": "ERR_RECORD_SCHEMA_INVALID-2026-07-31",
      "summary": "上一 accepted Goal 的 evidence Markdown 位于 Record Store 下，导致 Maintain 索引扫描失败；新 Goal 证据必须使用独立 `.pipeline/evidence` 路径。",
      "type": "workflow-diagnostic"
    },
    {
      "ref": "goal-runner-implement",
      "summary": "Worker routing critical (high_blast_radius); execution remains solo-verified because the change is tightly coupled and deterministic tests provide a strong oracle.",
      "type": "task-assessment"
    }
  ],
  "id": "vspi-persistent-goal-runner",
  "outcome": "VSPi 通过 `/goal` 提供项目持久、可恢复且有安全边界的长期任务执行：模型维护 Working Plan 与 Progress Markers，普通阶段总结不会终止未完成 Goal，只有真实完成、阻塞、暂停、取消或预算边界能够停止自动续跑。",
  "revision": 0,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi 持久 Goal Runner",
  "plan_hash": "1ad8dfc0809b41586978e0eee7c867f54f8bf57532a58826e2a48459dd7c559a"
}
```
