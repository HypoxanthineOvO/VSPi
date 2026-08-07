---
authority_role: record
confidence: confirmed
created_at: 2026-07-30T16:30:03.141Z
dedupe_key: goal.vspi-subagent-teams-goal.plan
id: decision-deccd6104c4cd9fb7b03c6a041a48556
kind: decision
schema_version: '1'
scope:
  ref: vspi-subagent-teams-goal
  type: goal
semantic_hash: deccd6104c4cd9fb7b03c6a041a48556d0a8b88090eabac1df3e7ea84ce6908a
source_refs:
  - locator: compiled-plan
    ref: goal:vspi-subagent-teams-goal:revision:0
    type: delivery_plan
supersedes: []
updated_at: 2026-07-30T16:30:03.141Z
---
# VSPi Subagent 与项目 Teammate 能力

为 VSPi 增加一次性 Task Agent 与项目级持久 Teammate：支持独立或显式继承上下文、自定义提示词/模型/Effort、五层嵌套调度、混合模型职责分工、严格 required 路由、黏着式额度 fallback、可控读写边界和清晰的终端状态展示。

```json
{
  "acceptance_criteria": [
    {
      "id": "task-agent-isolation",
      "statement": "Task Agent 默认从独立空历史启动，只接收调用显式提供的任务与上下文；完整父上下文继承必须显式开启。",
      "verification": "集成测试证明父消息、Thinking 与工具历史默认不进入子 Session，并覆盖显式继承与敏感内容过滤。"
    },
    {
      "id": "custom-runtime-selection",
      "statement": "每个 Task Agent 可指定追加 instructions、完整 system prompt、已配置模型、Effort 与 fallback；未指定模型和 Effort 时继承派生者。",
      "verification": "模型解析、Effort 裁剪、提示词模式、继承优先级、无效模型和额度 fallback 均有确定性测试。"
    },
    {
      "id": "nested-scheduler",
      "statement": "Task Agent 可继续派生临时 Task Agent，默认最大深度 5、单树累计 128、全局并发 16，并允许用户配置。",
      "verification": "调度测试覆盖共享 tree_id、跨代计数、队列、公平释放、等待父级不占生成槽、级联取消和所有上限。"
    },
    {
      "id": "project-teammates",
      "statement": "Teammate 是项目级持久角色，拥有独立工作线上下文、职责提示词、路由模式、访问配置及可替换模型绑定。",
      "verification": "重启、主 Session 切换与模型变更测试证明角色和 lane 状态持久，且主对话不会复制进 Teammate。"
    },
    {
      "id": "routing-authority",
      "statement": "持久 Teammate 的创建、删除、重置和模型切换需要用户明确授权；已配置角色可自动派遣，required 匹配只能由用户显式覆盖。",
      "verification": "权限测试覆盖管理操作拒绝/批准、单任务/Session/持久覆盖作用域，以及 required 不可用时阻塞而非静默接管。"
    },
    {
      "id": "sticky-fallback",
      "statement": "仅可明确识别的额度耗尽触发已配置 fallback；切换后保持黏着，不探测或自动恢复首选模型。",
      "verification": "故障分类测试区分额度、限流、网络、认证与模型错误，并验证 fallback 事件进入主 Agent 上下文和当前用户回复。"
    },
    {
      "id": "permission-boundary",
      "statement": "子 Agent 工具权限独立配置但不得超过父 Policy，默认限制在当前 workspace；子 Agent不能管理持久 Teammate。",
      "verification": "安全测试覆盖路径逃逸、绝对路径、工具 allowlist、共享写入租约、项目信任、Recovery 和嵌套权限收窄。"
    },
    {
      "id": "status-visibility",
      "statement": "终端清晰展示活动 Task Agent 与持久 Teammate 的角色、lane、任务、模型、有效 Effort、活动状态、上下文和 fallback 状态。",
      "verification": "40/80/120 列渲染与交互测试覆盖 /agents 面板、transcript 更新、黏着 fallback 标记和长文本截断。"
    },
    {
      "id": "capability-not-tutorial",
      "statement": "提供给模型的内容只描述可用能力、真实状态、用户配置和硬边界，不注入规定何时 Research/Test/Implement/Audit 的工作教程。",
      "verification": "Prompt 合同测试检查动态团队快照与工具描述，并拒绝预设委派步骤或复杂度决策树。"
    },
    {
      "id": "regression-quality",
      "statement": "实现不破坏现有 Session、Policy、Model/Effort、Question、Skill、PTY、transcript 与 Recovery 行为。",
      "verification": "TypeScript、Biome、目标测试、全量 Vitest、构建与 render-once smoke 全部通过。"
    }
  ],
  "constraints": [
    "保留当前工作树中用户已有的未提交 Session 与 PTY 修改，不回滚、不覆盖。",
    "使用现有 Pi SDK 和 VSPi 基础设施，不新增第三方运行时依赖，不通过重新调用 vspi CLI 模拟 Pi JSON 子进程。",
    "项目本地 Agent profile 只在受信任项目加载；未受信任项目和 Recovery 必须 fail closed。",
    "默认不复制父对话；任何完整上下文继承都必须显式、可见且经过过滤。",
    "不把模型选择、任务分离或审计启发式写成教学型系统提示词。",
    "本 Goal 不实现独立 Git worktree、模块所有权或多写者合并；共享 workspace 采用单写者边界。",
    "不自动发布版本、不推送远端、不修改真实 Provider 凭据。"
  ],
  "delivery_kind": "goal",
  "design": {
    "acceptance_criteria": [
      {
        "id": "task-agent-isolation",
        "statement": "Task Agent 默认从独立空历史启动，只接收调用显式提供的任务与上下文；完整父上下文继承必须显式开启。",
        "verification": "集成测试证明父消息、Thinking 与工具历史默认不进入子 Session，并覆盖显式继承与敏感内容过滤。"
      },
      {
        "id": "custom-runtime-selection",
        "statement": "每个 Task Agent 可指定追加 instructions、完整 system prompt、已配置模型、Effort 与 fallback；未指定模型和 Effort 时继承派生者。",
        "verification": "模型解析、Effort 裁剪、提示词模式、继承优先级、无效模型和额度 fallback 均有确定性测试。"
      },
      {
        "id": "nested-scheduler",
        "statement": "Task Agent 可继续派生临时 Task Agent，默认最大深度 5、单树累计 128、全局并发 16，并允许用户配置。",
        "verification": "调度测试覆盖共享 tree_id、跨代计数、队列、公平释放、等待父级不占生成槽、级联取消和所有上限。"
      },
      {
        "id": "project-teammates",
        "statement": "Teammate 是项目级持久角色，拥有独立工作线上下文、职责提示词、路由模式、访问配置及可替换模型绑定。",
        "verification": "重启、主 Session 切换与模型变更测试证明角色和 lane 状态持久，且主对话不会复制进 Teammate。"
      },
      {
        "id": "routing-authority",
        "statement": "持久 Teammate 的创建、删除、重置和模型切换需要用户明确授权；已配置角色可自动派遣，required 匹配只能由用户显式覆盖。",
        "verification": "权限测试覆盖管理操作拒绝/批准、单任务/Session/持久覆盖作用域，以及 required 不可用时阻塞而非静默接管。"
      },
      {
        "id": "sticky-fallback",
        "statement": "仅可明确识别的额度耗尽触发已配置 fallback；切换后保持黏着，不探测或自动恢复首选模型。",
        "verification": "故障分类测试区分额度、限流、网络、认证与模型错误，并验证 fallback 事件进入主 Agent 上下文和当前用户回复。"
      },
      {
        "id": "permission-boundary",
        "statement": "子 Agent 工具权限独立配置但不得超过父 Policy，默认限制在当前 workspace；子 Agent不能管理持久 Teammate。",
        "verification": "安全测试覆盖路径逃逸、绝对路径、工具 allowlist、共享写入租约、项目信任、Recovery 和嵌套权限收窄。"
      },
      {
        "id": "status-visibility",
        "statement": "终端清晰展示活动 Task Agent 与持久 Teammate 的角色、lane、任务、模型、有效 Effort、活动状态、上下文和 fallback 状态。",
        "verification": "40/80/120 列渲染与交互测试覆盖 /agents 面板、transcript 更新、黏着 fallback 标记和长文本截断。"
      },
      {
        "id": "capability-not-tutorial",
        "statement": "提供给模型的内容只描述可用能力、真实状态、用户配置和硬边界，不注入规定何时 Research/Test/Implement/Audit 的工作教程。",
        "verification": "Prompt 合同测试检查动态团队快照与工具描述，并拒绝预设委派步骤或复杂度决策树。"
      },
      {
        "id": "regression-quality",
        "statement": "实现不破坏现有 Session、Policy、Model/Effort、Question、Skill、PTY、transcript 与 Recovery 行为。",
        "verification": "TypeScript、Biome、目标测试、全量 Vitest、构建与 render-once smoke 全部通过。"
      }
    ],
    "constraints": [
      "保留当前工作树中用户已有的未提交 Session 与 PTY 修改，不回滚、不覆盖。",
      "使用现有 Pi SDK 和 VSPi 基础设施，不新增第三方运行时依赖，不通过重新调用 vspi CLI 模拟 Pi JSON 子进程。",
      "项目本地 Agent profile 只在受信任项目加载；未受信任项目和 Recovery 必须 fail closed。",
      "默认不复制父对话；任何完整上下文继承都必须显式、可见且经过过滤。",
      "不把模型选择、任务分离或审计启发式写成教学型系统提示词。",
      "本 Goal 不实现独立 Git worktree、模块所有权或多写者合并；共享 workspace 采用单写者边界。",
      "不自动发布版本、不推送远端、不修改真实 Provider 凭据。"
    ],
    "evidence": [
      {
        "ref": "src/backend/pi-runtime-backend.ts",
        "summary": "现有生产 runtime 已集中创建 Pi services/session，并注册 Policy、Question、Skill 与 Plan 工具。",
        "type": "repository"
      },
      {
        "ref": "src/policy/pi-policy-tools.ts",
        "summary": "现有工具执行具备 VSPi Policy 包装，可扩展为子 Agent 的权限上限和 workspace 边界。",
        "type": "repository"
      },
      {
        "ref": "src/domain/types.ts and src/ui/transcript.ts",
        "summary": "已有 SubAgentMessage 类型和终端渲染入口，可承载专用状态投影。",
        "type": "repository"
      },
      {
        "ref": "@earendil-works/pi-coding-agent@0.82.1 examples/extensions/subagent",
        "summary": "上游示例证明隔离上下文、并行、链式、流式更新、取消、usage 与 Agent profile 形态。",
        "type": "dependency"
      },
      {
        "ref": "@earendil-works/pi-coding-agent@0.82.1 SDK",
        "summary": "SDK 提供独立 AgentSession、SessionManager.inMemory、持久 Session、ModelRuntime、模型和 ThinkingLevel 控制。",
        "type": "dependency"
      },
      {
        "ref": "current-chat-2026-07-30-to-2026-07-31",
        "summary": "用户确认两类 Agent、项目角色、严格 required、最小上下文、嵌套 5/128/16、模型继承与混用、黏着 fallback、状态可见和非教学原则。",
        "type": "discussion"
      },
      {
        "ref": "current-chat-2026-07-31-goal-conversion",
        "summary": "用户确认取消两个中间 Stone，改为连续执行并在最终结果统一验收的 Goal。",
        "type": "discussion"
      }
    ],
    "outcome": "为 VSPi 增加一次性 Task Agent 与项目级持久 Teammate：支持独立或显式继承上下文、自定义提示词/模型/Effort、五层嵌套调度、混合模型职责分工、严格 required 路由、黏着式额度 fallback、可控读写边界和清晰的终端状态展示。"
  },
  "evidence": [
    {
      "ref": "src/backend/pi-runtime-backend.ts",
      "summary": "现有生产 runtime 已集中创建 Pi services/session，并注册 Policy、Question、Skill 与 Plan 工具。",
      "type": "repository"
    },
    {
      "ref": "src/policy/pi-policy-tools.ts",
      "summary": "现有工具执行具备 VSPi Policy 包装，可扩展为子 Agent 的权限上限和 workspace 边界。",
      "type": "repository"
    },
    {
      "ref": "src/domain/types.ts and src/ui/transcript.ts",
      "summary": "已有 SubAgentMessage 类型和终端渲染入口，可承载专用状态投影。",
      "type": "repository"
    },
    {
      "ref": "@earendil-works/pi-coding-agent@0.82.1 examples/extensions/subagent",
      "summary": "上游示例证明隔离上下文、并行、链式、流式更新、取消、usage 与 Agent profile 形态。",
      "type": "dependency"
    },
    {
      "ref": "@earendil-works/pi-coding-agent@0.82.1 SDK",
      "summary": "SDK 提供独立 AgentSession、SessionManager.inMemory、持久 Session、ModelRuntime、模型和 ThinkingLevel 控制。",
      "type": "dependency"
    },
    {
      "ref": "current-chat-2026-07-30-to-2026-07-31",
      "summary": "用户确认两类 Agent、项目角色、严格 required、最小上下文、嵌套 5/128/16、模型继承与混用、黏着 fallback、状态可见和非教学原则。",
      "type": "discussion"
    },
    {
      "ref": "current-chat-2026-07-31-goal-conversion",
      "summary": "用户确认取消两个中间 Stone，改为连续执行并在最终结果统一验收的 Goal。",
      "type": "discussion"
    }
  ],
  "id": "vspi-subagent-teams-goal",
  "outcome": "为 VSPi 增加一次性 Task Agent 与项目级持久 Teammate：支持独立或显式继承上下文、自定义提示词/模型/Effort、五层嵌套调度、混合模型职责分工、严格 required 路由、黏着式额度 fallback、可控读写边界和清晰的终端状态展示。",
  "revision": 0,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi Subagent 与项目 Teammate 能力",
  "plan_hash": "dd727b8c3d92160a3ff4f06aa6fe42142f8eb0762f58076a32f6462a7bc194a4"
}
```
