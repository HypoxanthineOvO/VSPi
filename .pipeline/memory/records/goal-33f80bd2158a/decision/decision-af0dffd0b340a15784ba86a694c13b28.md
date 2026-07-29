---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T08:33:45.768Z
dedupe_key: goal.vspi-live-run-control.plan
id: decision-af0dffd0b340a15784ba86a694c13b28
kind: decision
schema_version: '1'
scope:
  ref: vspi-live-run-control
  type: goal
semantic_hash: af0dffd0b340a15784ba86a694c13b28bb2530e49316356ace45ad9f53ded908
source_refs:
  - locator: compiled-plan
    ref: goal:vspi-live-run-control:revision:0
    type: delivery_plan
supersedes: []
updated_at: 2026-07-25T08:33:45.768Z
---
# 修复 VSPi 运行中消息、Working 状态与 ESC 连续性

VSPi 在 Agent 工作期间能可靠接收 steer/follow-up 消息、持续显示真实 Working 状态，并在 ESC 中断后保留当前 Session 与 Transcript，同时完成刚才未收尾的 Model 分组改动。

```json
{
  "acceptance_criteria": [
    {
      "id": "busy-steer",
      "statement": "busy 时 Enter 接收消息并通过 Pi steer 在当前工具批次之后、下一次模型调用之前送达。",
      "verification": "App 与 Pi runtime 事件模拟验证消息不丢失、可连续排队且 composer 清空。"
    },
    {
      "id": "busy-follow-up",
      "statement": "busy 时 Alt+Enter 接收 follow-up，并在 Agent 完全空闲后送达。",
      "verification": "队列行为与 Pi 原生 streamingBehavior 契约测试通过。"
    },
    {
      "id": "working-status",
      "statement": "从提交到真正 idle 始终显示动态 Working 状态，并显示 steering/follow-up 队列数量。",
      "verification": "agent_start/end、queue_update、工具静默阶段和窄宽度渲染测试通过。"
    },
    {
      "id": "escape-continuity",
      "statement": "ESC 只中断当前运行，不创建/切换 Session，不删除已发送用户消息或本轮部分输出，也不覆盖正在编辑的草稿。",
      "verification": "取消事件、Session identity、Transcript、running tool 终态和 composer 草稿测试通过。"
    },
    {
      "id": "recent-model-work",
      "statement": "保留并完成最近 VSPi Session 中的 Provider 分组、长标题、空模型组与 GPT Effort Map 改动。",
      "verification": "Model/Provider focused tests 和完整测试通过。"
    },
    {
      "id": "quality",
      "statement": "check、build、full test、source/dist smoke、package install 与 diff check 通过。",
      "verification": "按顺序执行发布验证，避免 build/test 的 dist 并发竞态。"
    }
  ],
  "constraints": [
    "复用 Pi 原生 steer/followUp/queue_update，不自行实现第二套 Agent 队列。",
    "保留当前 dirty worktree 和刚才 VSPi 写入的 Provider/Model 改动。",
    "不调用付费模型，不提交、推送、发布或重启服务。",
    "不新增手工 Stone；实现完成后统一请求最终验收。"
  ],
  "delivery_kind": "goal",
  "design": {
    "acceptance_criteria": [
      {
        "id": "busy-steer",
        "statement": "busy 时 Enter 接收消息并通过 Pi steer 在当前工具批次之后、下一次模型调用之前送达。",
        "verification": "App 与 Pi runtime 事件模拟验证消息不丢失、可连续排队且 composer 清空。"
      },
      {
        "id": "busy-follow-up",
        "statement": "busy 时 Alt+Enter 接收 follow-up，并在 Agent 完全空闲后送达。",
        "verification": "队列行为与 Pi 原生 streamingBehavior 契约测试通过。"
      },
      {
        "id": "working-status",
        "statement": "从提交到真正 idle 始终显示动态 Working 状态，并显示 steering/follow-up 队列数量。",
        "verification": "agent_start/end、queue_update、工具静默阶段和窄宽度渲染测试通过。"
      },
      {
        "id": "escape-continuity",
        "statement": "ESC 只中断当前运行，不创建/切换 Session，不删除已发送用户消息或本轮部分输出，也不覆盖正在编辑的草稿。",
        "verification": "取消事件、Session identity、Transcript、running tool 终态和 composer 草稿测试通过。"
      },
      {
        "id": "recent-model-work",
        "statement": "保留并完成最近 VSPi Session 中的 Provider 分组、长标题、空模型组与 GPT Effort Map 改动。",
        "verification": "Model/Provider focused tests 和完整测试通过。"
      },
      {
        "id": "quality",
        "statement": "check、build、full test、source/dist smoke、package install 与 diff check 通过。",
        "verification": "按顺序执行发布验证，避免 build/test 的 dist 并发竞态。"
      }
    ],
    "constraints": [
      "复用 Pi 原生 steer/followUp/queue_update，不自行实现第二套 Agent 队列。",
      "保留当前 dirty worktree 和刚才 VSPi 写入的 Provider/Model 改动。",
      "不调用付费模型，不提交、推送、发布或重启服务。",
      "不新增手工 Stone；实现完成后统一请求最终验收。"
    ],
    "evidence": [
      {
        "ref": "src/app/vspi-app.ts:562",
        "summary": "submit currently returns whenever busy and input dispatch explicitly blocks Enter and Alt+Enter.",
        "type": "repository"
      },
      {
        "ref": "src/app/vspi-app.ts:1469",
        "summary": "Escape cancellation calls restoreCancelledSubmission, which splices the current transcript and restores the original prompt as a draft.",
        "type": "repository"
      },
      {
        "ref": "node_modules/@earendil-works/pi-coding-agent/docs/rpc.md:56",
        "summary": "Pi already supports steer before the next LLM call and followUp after the agent becomes idle.",
        "type": "repository"
      },
      {
        "ref": "~/.pi/agent/sessions/--home-heyx-VSPi--/2026-07-25T07-51-24-482Z_019f9841-ea42-7b6e-bfd1-f4530e83f1cb.jsonl",
        "summary": "The latest VSPi run implemented Model grouping/Effort Map changes and ended while adjusting the no-group Model hint test.",
        "type": "session"
      }
    ],
    "outcome": "VSPi 在 Agent 工作期间能可靠接收 steer/follow-up 消息、持续显示真实 Working 状态，并在 ESC 中断后保留当前 Session 与 Transcript，同时完成刚才未收尾的 Model 分组改动。"
  },
  "evidence": [
    {
      "ref": "src/app/vspi-app.ts:562",
      "summary": "submit currently returns whenever busy and input dispatch explicitly blocks Enter and Alt+Enter.",
      "type": "repository"
    },
    {
      "ref": "src/app/vspi-app.ts:1469",
      "summary": "Escape cancellation calls restoreCancelledSubmission, which splices the current transcript and restores the original prompt as a draft.",
      "type": "repository"
    },
    {
      "ref": "node_modules/@earendil-works/pi-coding-agent/docs/rpc.md:56",
      "summary": "Pi already supports steer before the next LLM call and followUp after the agent becomes idle.",
      "type": "repository"
    },
    {
      "ref": "~/.pi/agent/sessions/--home-heyx-VSPi--/2026-07-25T07-51-24-482Z_019f9841-ea42-7b6e-bfd1-f4530e83f1cb.jsonl",
      "summary": "The latest VSPi run implemented Model grouping/Effort Map changes and ended while adjusting the no-group Model hint test.",
      "type": "session"
    }
  ],
  "id": "vspi-live-run-control",
  "outcome": "VSPi 在 Agent 工作期间能可靠接收 steer/follow-up 消息、持续显示真实 Working 状态，并在 ESC 中断后保留当前 Session 与 Transcript，同时完成刚才未收尾的 Model 分组改动。",
  "revision": 0,
  "schema_version": "1",
  "status": "draft",
  "title": "修复 VSPi 运行中消息、Working 状态与 ESC 连续性",
  "plan_hash": "006c73bac347e3b04020e47de11934f377037b84730c9b3106ff32f9da925063"
}
```
