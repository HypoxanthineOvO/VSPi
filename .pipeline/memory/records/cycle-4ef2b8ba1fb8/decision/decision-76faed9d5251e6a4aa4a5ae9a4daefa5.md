---
authority_role: record
confidence: confirmed
created_at: 2026-07-30T16:26:44.581Z
dedupe_key: cycle.vspi-subagent-teams.plan
id: decision-76faed9d5251e6a4aa4a5ae9a4daefa5
kind: decision
schema_version: '1'
scope:
  ref: vspi-subagent-teams
  type: cycle
semantic_hash: 76faed9d5251e6a4aa4a5ae9a4daefa55483179cd61557d258f7b8d00c6165af
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-subagent-teams:revision:0
    type: delivery_plan
supersedes: []
updated_at: 2026-07-30T16:26:44.581Z
---
# VSPi Subagent 与项目 Teammate 能力

为 VSPi 增加一次性 Task Agent 与项目级持久 Teammate：支持独立或显式继承上下文、自定义提示词/模型/Effort、五层嵌套调度、混合模型职责分工、严格 required 路由、黏着式额度 fallback、可控读写边界和清晰的终端状态展示。

```json
{
  "acceptance": {
    "criteria": [
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
    "scope": "plan"
  },
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
    "本 Plan 不实现独立 Git worktree、模块所有权或多写者合并；共享 workspace 采用单写者边界。",
    "不自动发布版本、不推送远端、不修改真实 Provider 凭据。"
  ],
  "delivery_kind": "cycle",
  "delivery_mode": "plan",
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
    }
  ],
  "id": "vspi-subagent-teams",
  "milestones": [
    {
      "depends_on": [],
      "id": "m1-contract-and-scheduler",
      "order": 1,
      "outcome": "形成可验证的 Task Agent/Teammate 类型、profile 与设置 schema、上下文传递规则、模型策略和中央树调度器，默认限制为深度 5、累计 128、全局并发 16。",
      "title": "定义 Agent 合同与派生树调度器",
      "verification_criteria": [
        "Schema 测试覆盖 profile、inline override、模型池、路由模式、权限、作用域和非法组合。",
        "调度测试覆盖 tree_id、深度、累计数量、全局队列、等待父级释放生成槽、取消和配置覆盖。",
        "Prompt 合同只暴露能力、状态和硬约束，不包含委派教程。"
      ]
    },
    {
      "depends_on": [
        "m1-contract-and-scheduler"
      ],
      "id": "m2-task-agent-runtime",
      "order": 2,
      "outcome": "使用 Pi SDK 构建内存子 Session，支持最小上下文、显式完整继承、提示词两种模式、模型/Effort、嵌套派生、并行、流式结果、usage 和级联取消。",
      "stone": {
        "acceptance_criteria": [
          "演示中父对话未默认进入子 Session。",
          "模型、有效 Effort、tree 深度与剩余额度可见且与配置一致。",
          "达到限制、取消或权限拒绝时行为明确且 fail closed。"
        ],
        "id": "task-agent-runtime-review",
        "review": "检查真实 Task Agent 演示与测试证据：默认上下文隔离、自定义 prompt/model/Effort、跨模型探索、嵌套调度、状态流和取消行为。"
      },
      "title": "接入独立 Task Agent runtime",
      "verification_criteria": [
        "真实 SDK 集成测试证明子 Session 与父历史隔离，且不通过 VSPi CLI 子进程启动。",
        "权限与模型测试覆盖继承、显式覆盖、路径边界、工具收窄、Effort 裁剪和错误传播。",
        "嵌套与并行 fixture 证明五层/128/16 限制和取消语义。"
      ]
    },
    {
      "depends_on": [
        "m2-task-agent-runtime"
      ],
      "id": "m3-project-teammates",
      "order": 3,
      "outcome": "增加兼容 Agent profile 的项目角色注册、持久 lane Session、显式管理授权、required/preferred/consult/manual 路由、模型切换和黏着式额度 fallback。",
      "title": "实现项目 Teammate 与模型生命周期",
      "verification_criteria": [
        "角色创建、更新、暂停、归档、重置和模型切换均经过用户授权并留下结构化状态。",
        "项目/工作线恢复测试覆盖独立上下文、Session lease、分支变化与陈旧状态检测。",
        "额度错误触发配置 fallback，其他错误不误切换，且不自动恢复 preferred model。"
      ]
    },
    {
      "depends_on": [
        "m3-project-teammates"
      ],
      "id": "m4-host-status-and-ui",
      "order": 4,
      "outcome": "为主 Agent提供精简的能力/团队状态和用户约束，并在 transcript 与 /agents 面板展示 Task Agent、Teammate、模型、Effort、lane、上下文、任务和 fallback。",
      "stone": {
        "acceptance_criteria": [
          "用户能清楚分辨一次性 Task Agent 与持久 Teammate。",
          "当前模型、首选模型、fallback 原因和黏着状态不会混淆。",
          "required 阻塞、显式覆盖和管理授权在界面与主回复中可理解。"
        ],
        "id": "teammate-ui-review",
        "review": "检查真实 /agents 与 transcript 交互：项目角色、工作线、当前/首选模型、黏着 fallback、活动 Task Agent、上下文和权限状态。"
      },
      "title": "接入主 Agent 协调与终端状态界面",
      "verification_criteria": [
        "主 Agent可自动派遣现有角色，但不能在无授权时执行持久管理操作。",
        "fallback 通过结构化事件进入主上下文，并要求当前回复向用户说明。",
        "40/80/120 列状态和详情视图稳定、可操作、无重叠或信息截断错误。"
      ]
    },
    {
      "depends_on": [
        "m4-host-status-and-ui"
      ],
      "id": "m5-hardening-and-documentation",
      "order": 5,
      "outcome": "完成输入/路径/权限/并发/恢复安全审计，更新用户配置和使用文档，并通过全量质量门禁而不发布版本。",
      "title": "完成安全加固、回归验证与文档",
      "verification_criteria": [
        "npm run check、目标 Vitest、全量 npm test、npm run build 与 render-once smoke 全部通过。",
        "安全测试覆盖项目 prompt 信任、路径逃逸、权限升级、递归预算绕过、管理操作越权和错误信息脱敏。",
        "README 与测试文档说明 Task Agent、Teammate、路由强度、模型策略、fallback、限制、状态界面和 deferred worktree 边界。"
      ]
    }
  ],
  "outcome": "为 VSPi 增加一次性 Task Agent 与项目级持久 Teammate：支持独立或显式继承上下文、自定义提示词/模型/Effort、五层嵌套调度、混合模型职责分工、严格 required 路由、黏着式额度 fallback、可控读写边界和清晰的终端状态展示。",
  "revision": 0,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi Subagent 与项目 Teammate 能力",
  "plan_hash": "d3ccb4890ecb73311c424d36e133bfa2d06773f7df152c8a45f8aeb865c7034d"
}
```
