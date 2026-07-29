---
authority_role: record
confidence: confirmed
created_at: 2026-07-24T16:32:21.716Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.plan
id: decision-5a7bb7573abaa22b1e23d58c51980dad
kind: decision
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: 5a7bb7573abaa22b1e23d58c51980dadd440c62c6f1e6355605457199a512913
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-v0-2-0-workflow-integration:revision:4
    type: delivery_plan
supersedes:
  - decision-ff351e9d4433699ce4b2d64ffea2bc3d
updated_at: 2026-07-24T16:32:21.716Z
---
# VSPi v0.2.0 可用性优先与 Workflow 集成

交付可靠、可中断、按事件瀑布展示的原生工具体验，并完成 Workflow 单一权威、Session 隔离及扩展工具边界。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "native-tools",
        "statement": "模型使用 Pi 原生文件、目录、搜索、命令、编辑和写入工具，VSPi 自有 Question 通过 Pi 工具接口注册。",
        "verification": "真实会话验证 read、ls、find、grep、bash、edit、write、question，包含图片读取、流式输出、超时、取消、截断与 diff。"
      },
      {
        "id": "host-approval",
        "statement": "四档 Policy 只控制审批强度，正常工具在 Host 执行，不再把 bwrap 当成执行边界。",
        "verification": "各档审批矩阵、会话同类放行、放宽一级、拒绝及理由均有单元和 TUI 交互覆盖，状态区不再宣称 Sandboxed。"
      },
      {
        "id": "interruptible-ui",
        "statement": "ESC 对覆盖层和生成采取分层退出，Ctrl+C 保留直接取消，取消后不泄漏迟到事件或丢失草稿附件。",
        "verification": "Question、审批、设置、Effort、主界面生成和工具执行均有交互测试与真实终端验证。"
      },
      {
        "id": "usable-settings",
        "statement": "用户消息、Effort 和 Settings 的视觉与保存反馈符合紧凑、可撤销、分层明确的交互。",
        "verification": "40/80/120 列快照、Apply/Cancel、Global/Project 分层和有意义确认文案通过测试。"
      },
      {
        "id": "workflow-honesty",
        "statement": "M1 不扩展未定的 Workflow 深度集成，不再向模型暴露与 UI Workflow 状态冲突的 Local Plan 工具。",
        "verification": "生产工具清单无 plan_* 双权威，现有 Workflow 启动能力不回退，M2 在 M1 Stone 之后继续讨论。"
      },
      {
        "id": "waterfall-transcript",
        "statement": "用户消息、思考、工具调用、工具结果与最终回答按真实事件顺序形成只追加的瀑布时间线。",
        "verification": "覆盖多工具流式会话、工具前后文本、迟到事件与 40/80/120 列渲染顺序。"
      },
      {
        "id": "adaptive-effort",
        "statement": "Effort 选项来自当前模型能力并保留原生档位语义。",
        "verification": "不同 Provider/模型的 off、low、medium、high、xhigh、max 能力映射和切换行为有契约测试。"
      }
    ],
    "scope": "plan"
  },
  "acceptance_criteria": [
    {
      "id": "native-tools",
      "statement": "模型使用 Pi 原生文件、目录、搜索、命令、编辑和写入工具，VSPi 自有 Question 通过 Pi 工具接口注册。",
      "verification": "真实会话验证 read、ls、find、grep、bash、edit、write、question，包含图片读取、流式输出、超时、取消、截断与 diff。"
    },
    {
      "id": "host-approval",
      "statement": "四档 Policy 只控制审批强度，正常工具在 Host 执行，不再把 bwrap 当成执行边界。",
      "verification": "各档审批矩阵、会话同类放行、放宽一级、拒绝及理由均有单元和 TUI 交互覆盖，状态区不再宣称 Sandboxed。"
    },
    {
      "id": "interruptible-ui",
      "statement": "ESC 对覆盖层和生成采取分层退出，Ctrl+C 保留直接取消，取消后不泄漏迟到事件或丢失草稿附件。",
      "verification": "Question、审批、设置、Effort、主界面生成和工具执行均有交互测试与真实终端验证。"
    },
    {
      "id": "usable-settings",
      "statement": "用户消息、Effort 和 Settings 的视觉与保存反馈符合紧凑、可撤销、分层明确的交互。",
      "verification": "40/80/120 列快照、Apply/Cancel、Global/Project 分层和有意义确认文案通过测试。"
    },
    {
      "id": "workflow-honesty",
      "statement": "M1 不扩展未定的 Workflow 深度集成，不再向模型暴露与 UI Workflow 状态冲突的 Local Plan 工具。",
      "verification": "生产工具清单无 plan_* 双权威，现有 Workflow 启动能力不回退，M2 在 M1 Stone 之后继续讨论。"
    },
    {
      "id": "waterfall-transcript",
      "statement": "用户消息、思考、工具调用、工具结果与最终回答按真实事件顺序形成只追加的瀑布时间线。",
      "verification": "覆盖多工具流式会话、工具前后文本、迟到事件与 40/80/120 列渲染顺序。"
    },
    {
      "id": "adaptive-effort",
      "statement": "Effort 选项来自当前模型能力并保留原生档位语义。",
      "verification": "不同 Provider/模型的 off、low、medium、high、xhigh、max 能力映射和切换行为有契约测试。"
    }
  ],
  "constraints": [
    "保留用户现有 dirty worktree，不覆盖无关修改。",
    "不在本轮实现深层 Bash 安全分析、小模型审批、持久 PTY、浏览器或 MCP。",
    "审批的本会话同类放行与放宽一级只驻留内存，不静默写入全局或项目配置。",
    "拒绝理由作为结构化工具结果返回；人工审批与模型主动 question 保持独立。",
    "不提交、打 tag、推送、发布、重启服务或执行付费请求。",
    "用户已授权修订后的 M1 自动通过，并连续执行 M2-M4；整个 Cycle 最终结果仍等待用户验收。"
  ],
  "delivery_kind": "cycle",
  "delivery_mode": "plan",
  "evidence": [
    {
      "ref": "conversation-2026-07-24-native-tools-and-approval",
      "summary": "用户确认 Host 执行、审批四档、五项审批动作、自有 Question、ESC 分层退出和先可用后增强。",
      "type": "user-feedback"
    },
    {
      "ref": "src/policy/pi-policy-tools.ts",
      "summary": "当前覆盖完整 execute 导致 Pi 原生图片、流式、截断、diff 和友好错误能力丢失，并存在 timeout 单位错误。",
      "type": "repository"
    },
    {
      "ref": "@earendil-works/pi-coding-agent 0.81.1",
      "summary": "依赖已提供 read/bash/edit/write/ls/find/grep ToolDefinition、图片读取、AbortSignal、流式输出与 operations 扩展点。",
      "type": "upstream-api"
    },
    {
      "ref": "src/questions/tool.ts and src/ui/panels.ts",
      "summary": "VSPi 已有自有结构化 Question schema、工具定义和完整 Panel 交互，可直接保留。",
      "type": "repository"
    },
    {
      "ref": "2026-07-24 real M1 trial",
      "summary": "真实试用确认工具高频失败、ESC 无效、用户消息高亮过强、Effort/Settings 保存交互不合格。",
      "type": "session-trace"
    },
    {
      "ref": "conversation-2026-07-25-waterfall-ui-and-cycle-authorization",
      "summary": "用户拒绝覆盖式消息、错序工具链、弱层次 Question/Plan 与固定三档 Effort，并授权连续完成整个 Cycle。",
      "type": "user-feedback"
    }
  ],
  "id": "vspi-v0-2-0-workflow-integration",
  "milestones": [
    {
      "depends_on": [],
      "id": "M1",
      "order": 1,
      "outcome": "交付真实按事件追加的瀑布对话、Pi 原生工具与审批、分层 Question/Plan、全宽用户消息以及模型自适应 Effort。",
      "stone": {
        "acceptance_criteria": [
          "常用工具调用不再因 VSPi 自制执行器失败，图片、流式、超时、取消和 diff 表现正常。",
          "审批器紧凑可用，五项选择语义正确，会话放行与放宽一级不污染持久配置。",
          "Question 或其他面板内首次 ESC 退出当前界面，无面板时 ESC 能中断生成或工具，且没有迟到输出。",
          "用户消息高亮克制，Effort 能进入编辑界面，Settings 有清楚的 Apply/Cancel 和分层状态，不再用保存路径覆盖有用反馈。",
          "M1 没有偷偷决定 Workflow 最终形态，也没有保留模型侧 Local Plan 双权威。",
          "多工具会话按用户消息、工具链、最终回答顺序瀑布展示，不覆盖旧内容。",
          "用户消息为稳定全宽深色块；Tool 显示动作摘要；Question 与 Plan 有明确视觉层次。",
          "Plan 展示标题可读化但内部 ID 不变；Effort 与当前模型能力和原生命名一致。"
        ],
        "id": "S-usable-native-runtime",
        "review": "真实启动 VSPi，验证多工具瀑布顺序、全宽用户消息、Tool/Question/Plan 层次、模型自适应 Effort、审批与 ESC；通过后连续执行剩余 Cycle。"
      },
      "title": "原生工具、Host 审批与交互稳定化 Stone",
      "verification_criteria": [
        "Pi 原生 read、ls、find、grep、bash、edit、write 被直接复用；VSPi 只在执行前评估审批并委托原生 execute，不重写原生工具行为。",
        "read 保留文本和图片能力；bash 保留秒制 timeout、流式更新、AbortSignal 与输出截断；edit 保留预览和结果 diff。",
        "VSPi 自有 question schema、Panel、答案归一化和取消行为保持唯一实现。",
        "Policy 从执行器改为审批器，所有档位报告 Host；正常路径无 bwrap，Safe/Standard/中间档/Auto 的规则以简单类别实现。",
        "审批 Panel 支持允许一次、本会话允许同类、放宽一级并执行、拒绝、拒绝并说明；会话规则不持久化。",
        "ESC 先关闭 Question、审批、Effort、Settings 等覆盖层，再在无覆盖层时取消生成或工具；Ctrl+C 可直接取消活跃工作。",
        "模型工具清单不含 Local Plan plan_*，避免与 UI Workflow 状态形成双权威。",
        "用户消息改为紧凑低强调标记；Effort 使用可选择和取消的编辑界面；Settings 分离 Global/Project 并使用 Apply/Cancel，保存反馈不显示生硬文件路径。",
        "focused tests、npm test、npm run check、clean build、source/dist smoke 与真实 TUI 试用通过。",
        "流式文本不会覆盖已沉淀消息；工具开始、增量、完成与最终回答按后端事件顺序追加或就地更新同一工具节点，最终回答位于工具链之后。",
        "用户消息使用全宽约三行的深色表面和白色文字；短消息也保持稳定块高，窄屏无溢出。",
        "Tool 标题下以次级文字展示命令或动作摘要；Question 用独立标题、问题正文、选项和输入区形成视觉层次。",
        "Workflow Plan 的 slug 只在展示层转换为空格与标题式大小写，持久 ID 不变；标题、元数据、里程碑层次清楚。",
        "Effort 由当前模型能力动态生成，使用原生档位名并做首字母大写展示，不再固定为中文低中高。"
      ]
    },
    {
      "depends_on": [
        "M1"
      ],
      "id": "M2",
      "order": 2,
      "outcome": "根据 M1 真实试用决定 Workflow 是可选能力还是深度集成，并确定唯一 Plan/Delivery 权威。",
      "title": "Workflow 集成深度与单一权威决策",
      "verification_criteria": [
        "明确比较无 Workflow、可选 Workflow Provider 和深度集成三种方案的用户价值、耦合、失败面与迁移成本。",
        "生产 UI 和模型工具只暴露一个 Plan/Delivery 来源，不再双读或双写。",
        "根据 M1 结果和仓库证据选择方案，记录理由并实现唯一权威；用户已授权连续执行。"
      ]
    },
    {
      "depends_on": [
        "M2"
      ],
      "id": "M3",
      "order": 3,
      "outcome": "仅在 M2 选择需要 Workflow 后，将 Session 生命周期与明确的 Workstream 绑定并验证并发隔离。",
      "title": "Session 与 Workstream 隔离",
      "verification_criteria": [
        "new、switch、fork、resume、evidence 与 continuation 不跨 Session 或 Delivery 写入。",
        "绑定在重启后可恢复，冲突在产品写入前失败。",
        "若 M2 选择不集成 Workflow，则以修订方案明确替代本里程碑。"
      ]
    },
    {
      "depends_on": [
        "M3"
      ],
      "id": "M4",
      "order": 4,
      "outcome": "在核心交互稳定后分别评估 Git、浏览器、MCP、远程执行、路由和打包，不把它们塞入 M1。",
      "title": "扩展工具与发布集成",
      "verification_criteria": [
        "Git、浏览器、MCP、SSH 和图片增强各自有结构化接口与独立失败边界。",
        "中文可见思考摘要和回复约束经过真实模型会话验证。",
        "完整测试、检查、构建、安装与终端流程通过后才进入最终验收。"
      ]
    }
  ],
  "outcome": "交付可靠、可中断、按事件瀑布展示的原生工具体验，并完成 Workflow 单一权威、Session 隔离及扩展工具边界。",
  "revision": 4,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi v0.2.0 可用性优先与 Workflow 集成",
  "plan_hash": "0e2624e4d96dd157c3986a102edb586c12c8a0f276cb43236aee090c8ee95d1b"
}
```
