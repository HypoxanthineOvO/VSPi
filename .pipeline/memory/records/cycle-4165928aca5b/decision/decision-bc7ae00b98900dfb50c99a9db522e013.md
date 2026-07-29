---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T05:33:49.537Z
dedupe_key: cycle.vspi-v0-2-0-workflow-integration.plan
id: decision-bc7ae00b98900dfb50c99a9db522e013
kind: decision
schema_version: '1'
scope:
  ref: vspi-v0-2-0-workflow-integration
  type: cycle
semantic_hash: bc7ae00b98900dfb50c99a9db522e0138dc333eacdef775e7aa2b0c503cdf579
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-v0-2-0-workflow-integration:revision:7
    type: delivery_plan
supersedes:
  - decision-b8ef01334883f6d99f724008fc6f9287
updated_at: 2026-07-25T05:33:49.537Z
---
# VSPi v0.2.0 动态工具收束与 Policy 标签修订

保留工具执行时的实时瀑布可见性，在完成后按默认开启的设置收束为单行摘要，并将审批 Policy 呈现为独立、固定宽度的背景标签。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "live-then-collapse",
        "statement": "工具组在 queued/running 阶段完整实时展开，全部终态后才根据设置自动收成一行。",
        "verification": "逐事件渲染 queued、running、success、error、cancelled，确认完成前树存在、完成后单行替换且消息顺序不变。"
      },
      {
        "id": "collapse-setting",
        "statement": "Settings 提供低强调的“完成后折叠工具调用”开关，默认开启，并支持 Global/Project 分层持久化。",
        "verification": "缺失旧配置回退 true；Apply/Cancel、继承、切换和重启加载测试通过；关闭后完整树持续显示。"
      },
      {
        "id": "summary-expand",
        "statement": "完成后的单行摘要保留总数及失败/取消计数，Inspect/Enter 可展开完整树、输出和 diff。",
        "verification": "成功、混合失败和取消三类摘要，以及折叠/展开往返和 40/80/120 列渲染通过。"
      },
      {
        "id": "policy-badge",
        "statement": "审批 Policy 在类别上方独占一行，以固定宽度背景标签显示，四档名称在最长名称宽度内居中。",
        "verification": "Safe、Standard、YOLO、Auto badge 宽度一致、文字居中、前景对比和无色降级通过。"
      },
      {
        "id": "r6-regression",
        "statement": "末项转角、标题颜色、最低充分权限、审批 gutter、ESC 取消和 Workflow 单一权威保持有效。",
        "verification": "focused、全量 test/check/build、source/dist/package smoke 和真实 Fixture TUI 通过。"
      }
    ],
    "scope": "plan"
  },
  "acceptance_criteria": [
    {
      "id": "live-then-collapse",
      "statement": "工具组在 queued/running 阶段完整实时展开，全部终态后才根据设置自动收成一行。",
      "verification": "逐事件渲染 queued、running、success、error、cancelled，确认完成前树存在、完成后单行替换且消息顺序不变。"
    },
    {
      "id": "collapse-setting",
      "statement": "Settings 提供低强调的“完成后折叠工具调用”开关，默认开启，并支持 Global/Project 分层持久化。",
      "verification": "缺失旧配置回退 true；Apply/Cancel、继承、切换和重启加载测试通过；关闭后完整树持续显示。"
    },
    {
      "id": "summary-expand",
      "statement": "完成后的单行摘要保留总数及失败/取消计数，Inspect/Enter 可展开完整树、输出和 diff。",
      "verification": "成功、混合失败和取消三类摘要，以及折叠/展开往返和 40/80/120 列渲染通过。"
    },
    {
      "id": "policy-badge",
      "statement": "审批 Policy 在类别上方独占一行，以固定宽度背景标签显示，四档名称在最长名称宽度内居中。",
      "verification": "Safe、Standard、YOLO、Auto badge 宽度一致、文字居中、前景对比和无色降级通过。"
    },
    {
      "id": "r6-regression",
      "statement": "末项转角、标题颜色、最低充分权限、审批 gutter、ESC 取消和 Workflow 单一权威保持有效。",
      "verification": "focused、全量 test/check/build、source/dist/package smoke 和真实 Fixture TUI 通过。"
    }
  ],
  "constraints": [
    "折叠只发生在整组全部进入 success/error/cancelled 终态之后；运行信息不得提前消失。",
    "默认开启完成后折叠；关闭设置时始终保留完整工具树。",
    "折叠是展示层状态，不删除 ToolMessage、output、diff 或 group identity。",
    "摘要必须用文字和计数表达异常，不能只依赖颜色。",
    "Policy badge 使用主题 token，不写死仅适用于一个终端的颜色。",
    "保留 dirty worktree，不提交、不推送、不发布，不调用未授权付费模型。"
  ],
  "delivery_kind": "cycle",
  "delivery_mode": "plan",
  "evidence": [
    {
      "ref": "revision-6-m1-stone-rejection",
      "summary": "用户要求工具执行中保持瀑布，完成后再折叠为单行，并把行为放入低强调 Settings 选项。",
      "type": "user-feedback"
    },
    {
      "ref": "conversation-2026-07-25-collapse-default",
      "summary": "用户选择“完成后折叠工具调用”默认开启。",
      "type": "user-decision"
    },
    {
      "ref": "src/config/settings.ts and src/ui/panels.ts",
      "summary": "现有 Settings 支持 boolean fallback、Global/Project 分层、Apply/Cancel 和分组展示，可兼容新增字段。",
      "type": "repository"
    },
    {
      "ref": "src/ui/transcript.ts",
      "summary": "Revision 6 已有工具 group identity、完整树、末项转角、异常状态和 Inspect 输出基础。",
      "type": "repository"
    }
  ],
  "id": "vspi-v0-2-0-workflow-integration",
  "milestones": [
    {
      "depends_on": [],
      "id": "M1",
      "order": 1,
      "outcome": "交付运行时展开、完成后按设置收束的工具组，以及独立固定宽度 Policy badge。",
      "stone": {
        "acceptance_criteria": [
          "折叠开启时执行过程可见，完成后自然收束为一行，不再长期刷屏。",
          "折叠关闭时完整树稳定保留，Enter 仍可查看输出与 diff。",
          "完成摘要清楚显示总数及失败或取消数量。",
          "Policy badge 位于类别上方、四档等宽居中，背景克制且不拥挤。",
          "Settings 选项低强调、默认开启，并保持 Apply/Cancel 语义。"
        ],
        "id": "S-live-collapse-and-policy-badge",
        "review": "真实查看工具组从执行中完整树过渡到完成后单行摘要，切换 Settings 验证永久展开，并检查四档 Policy badge 的位置、宽度和居中。"
      },
      "title": "动态工具收束与 Policy Badge Stone",
      "verification_criteria": [
        "renderTranscript 接收 collapseCompletedTools 设置；组内任一 queued/running 时始终显示完整树。",
        "全部终态且设置开启时只显示单行组摘要；失败与取消使用文本计数。",
        "Inspect 选中或组内任一 tool expanded 时恢复完整树；退出后重新收束。",
        "AppSettings、defaults、normalizeSettings、Fixture 和 Settings Panel 完整接入 collapseTools=true。",
        "Policy badge 上移一行，固定 8 列内容宽度，四档居中并使用独立背景 token。",
        "Revision 6 的 requiredPolicy、gutter、heading、corner 和取消隔离测试不回退。",
        "focused、全量测试与真实 Fixture TUI 通过。"
      ]
    },
    {
      "depends_on": [
        "M1"
      ],
      "id": "M2",
      "order": 2,
      "outcome": "确认显示偏好不会写入 Workflow 或恢复 Local Plan 双权威。",
      "title": "Workflow 与设置边界回归",
      "verification_criteria": [
        "collapseTools 只存在 VSPi Settings，不进入 Workflow Runtime、Continuation 或模型工具参数。",
        "生产工具清单仍无 plan_*，Workflow Provider 仍只读。"
      ]
    },
    {
      "depends_on": [
        "M2"
      ],
      "id": "M3",
      "order": 3,
      "outcome": "确认动态收束不会跨 Session 或吞掉取消和迟到事件。",
      "title": "Session 与取消过渡回归",
      "verification_criteria": [
        "new、switch、fork、resume 后工具组不跨 Session 合并。",
        "取消使当前组进入可解释终态，迟到事件仍隔离到下一次 send。"
      ]
    },
    {
      "depends_on": [
        "M3"
      ],
      "id": "M4",
      "order": 4,
      "outcome": "完成构建、安装、文档和能力边界验证，重新请求最终验收。",
      "title": "全量质量与扩展边界回归",
      "verification_criteria": [
        "npm test、check、build、package install、source/dist smoke、docs 和 diff check 通过。",
        "Fixture 默认隔离、Pi 默认恢复、Browser/MCP/Persistent PTY 状态不回退。"
      ]
    }
  ],
  "outcome": "保留工具执行时的实时瀑布可见性，在完成后按默认开启的设置收束为单行摘要，并将审批 Policy 呈现为独立、固定宽度的背景标签。",
  "revision": 7,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi v0.2.0 动态工具收束与 Policy 标签修订",
  "plan_hash": "741cde3a2739aad920fdc3fc73aa57e6ae97dd566e0c0c67fdd30700aec7c38c"
}
```
