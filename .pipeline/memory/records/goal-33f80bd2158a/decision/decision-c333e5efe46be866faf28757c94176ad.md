---
authority_role: record
confidence: confirmed
created_at: 2026-07-25T09:31:44.839Z
dedupe_key: goal.vspi-live-run-control.plan
id: decision-c333e5efe46be866faf28757c94176ad
kind: decision
schema_version: '1'
scope:
  ref: vspi-live-run-control
  type: goal
semantic_hash: c333e5efe46be866faf28757c94176ad62e4089873635ce0d92a09624a38f394
source_refs:
  - locator: compiled-plan
    ref: goal:vspi-live-run-control:revision:1
    type: delivery_plan
supersedes:
  - decision-af0dffd0b340a15784ba86a694c13b28
updated_at: 2026-07-25T09:31:44.839Z
---
# 修复 VSPi 运行控制与反馈层级

VSPi 在 Agent 工作期间可靠接收消息并保留 ESC 连续性，同时以独立 Working 活动带、浅灰 Markdown Thinking 和顶部非抢焦点 Toast 提供清晰反馈。

```json
{
  "acceptance_criteria": [
    {
      "id": "busy-steer",
      "statement": "busy 时 Enter 使用 Pi steer 在下一次模型调用前送达，Alt+Enter 使用 followUp 在 Agent idle 后送达。",
      "verification": "App、Pi runtime 与 Fixture 队列测试通过。"
    },
    {
      "id": "escape-continuity",
      "statement": "ESC 只中断当前运行，保留 Session、Transcript、partial output 与当前草稿，running Tool 收束为 cancelled。",
      "verification": "取消、迟到事件、队列恢复与 Session identity 测试通过。"
    },
    {
      "id": "working-rail",
      "statement": "工作期间 composer 上方始终显示独立动态 Working 活动带，并展示 Steer/Follow-up 数量。",
      "verification": "busy 生命周期、动画帧、40/80/120 列和 queue_update 测试通过。"
    },
    {
      "id": "thinking-tone",
      "statement": "Thinking 正文使用明显弱于普通回答的浅灰基础前景，并继续完整渲染 Markdown 强调、代码、列表和链接。",
      "verification": "ANSI 前景与 Markdown 结构渲染测试通过。"
    },
    {
      "id": "notice-toast",
      "statement": "保存与其他短时通知不再追加在最底部；真实 TUI 使用 non-capturing 顶部 Toast，保存通知说明对象与路径。",
      "verification": "overlay anchor、焦点保持、自动消失、窄屏 fallback 与保存通知测试通过。"
    },
    {
      "id": "recent-model-work",
      "statement": "保留并完成最近 Session 的 Provider 分组、长标题、空模型组和 GPT Effort Map 改动。",
      "verification": "Model/Provider focused 与 full suite 通过。"
    },
    {
      "id": "quality",
      "statement": "check、build、full test、source/dist smoke、package install 与 diff check 通过。",
      "verification": "发布验证按顺序通过。"
    }
  ],
  "constraints": [
    "Working 与 Toast 不抢 composer 焦点，不创建嵌套卡片。",
    "复用 Pi 原生 steer/followUp/queue_update 与 pi-tui overlay。",
    "保留当前 dirty worktree 和既有 Provider/Model 改动。",
    "不调用付费模型，不提交、推送、发布或重启服务。",
    "无中间 Stone；完成后统一请求最终验收。"
  ],
  "delivery_kind": "goal",
  "design": {
    "acceptance_criteria": [
      {
        "id": "busy-steer",
        "statement": "busy 时 Enter 使用 Pi steer 在下一次模型调用前送达，Alt+Enter 使用 followUp 在 Agent idle 后送达。",
        "verification": "App、Pi runtime 与 Fixture 队列测试通过。"
      },
      {
        "id": "escape-continuity",
        "statement": "ESC 只中断当前运行，保留 Session、Transcript、partial output 与当前草稿，running Tool 收束为 cancelled。",
        "verification": "取消、迟到事件、队列恢复与 Session identity 测试通过。"
      },
      {
        "id": "working-rail",
        "statement": "工作期间 composer 上方始终显示独立动态 Working 活动带，并展示 Steer/Follow-up 数量。",
        "verification": "busy 生命周期、动画帧、40/80/120 列和 queue_update 测试通过。"
      },
      {
        "id": "thinking-tone",
        "statement": "Thinking 正文使用明显弱于普通回答的浅灰基础前景，并继续完整渲染 Markdown 强调、代码、列表和链接。",
        "verification": "ANSI 前景与 Markdown 结构渲染测试通过。"
      },
      {
        "id": "notice-toast",
        "statement": "保存与其他短时通知不再追加在最底部；真实 TUI 使用 non-capturing 顶部 Toast，保存通知说明对象与路径。",
        "verification": "overlay anchor、焦点保持、自动消失、窄屏 fallback 与保存通知测试通过。"
      },
      {
        "id": "recent-model-work",
        "statement": "保留并完成最近 Session 的 Provider 分组、长标题、空模型组和 GPT Effort Map 改动。",
        "verification": "Model/Provider focused 与 full suite 通过。"
      },
      {
        "id": "quality",
        "statement": "check、build、full test、source/dist smoke、package install 与 diff check 通过。",
        "verification": "发布验证按顺序通过。"
      }
    ],
    "constraints": [
      "Working 与 Toast 不抢 composer 焦点，不创建嵌套卡片。",
      "复用 Pi 原生 steer/followUp/queue_update 与 pi-tui overlay。",
      "保留当前 dirty worktree 和既有 Provider/Model 改动。",
      "不调用付费模型，不提交、推送、发布或重启服务。",
      "无中间 Stone；完成后统一请求最终验收。"
    ],
    "evidence": [
      {
        "ref": "feedback-2dc39de0dbbb77493cac3135e83d2a25",
        "summary": "真实验收指出 Thinking 太白、Working 不可见、保存通知位于最底部。",
        "type": "user-feedback"
      },
      {
        "ref": "src/app/vspi-app.ts:520",
        "summary": "当前 notice 在 status 之后追加为最后一行；Working 只作为 status Effort 后缀。",
        "type": "repository"
      },
      {
        "ref": "src/ui/transcript.ts",
        "summary": "Thinking 正文使用默认 Markdown 基础颜色，与普通回答共享白色 text tone。",
        "type": "repository"
      },
      {
        "ref": "node_modules/@earendil-works/pi-tui/dist/tui.d.ts:194",
        "summary": "TUI 提供 showOverlay、top-right anchor 与 nonCapturing 选项。",
        "type": "repository"
      }
    ],
    "outcome": "VSPi 在 Agent 工作期间可靠接收消息并保留 ESC 连续性，同时以独立 Working 活动带、浅灰 Markdown Thinking 和顶部非抢焦点 Toast 提供清晰反馈。"
  },
  "evidence": [
    {
      "ref": "feedback-2dc39de0dbbb77493cac3135e83d2a25",
      "summary": "真实验收指出 Thinking 太白、Working 不可见、保存通知位于最底部。",
      "type": "user-feedback"
    },
    {
      "ref": "src/app/vspi-app.ts:520",
      "summary": "当前 notice 在 status 之后追加为最后一行；Working 只作为 status Effort 后缀。",
      "type": "repository"
    },
    {
      "ref": "src/ui/transcript.ts",
      "summary": "Thinking 正文使用默认 Markdown 基础颜色，与普通回答共享白色 text tone。",
      "type": "repository"
    },
    {
      "ref": "node_modules/@earendil-works/pi-tui/dist/tui.d.ts:194",
      "summary": "TUI 提供 showOverlay、top-right anchor 与 nonCapturing 选项。",
      "type": "repository"
    }
  ],
  "id": "vspi-live-run-control",
  "outcome": "VSPi 在 Agent 工作期间可靠接收消息并保留 ESC 连续性，同时以独立 Working 活动带、浅灰 Markdown Thinking 和顶部非抢焦点 Toast 提供清晰反馈。",
  "revision": 1,
  "schema_version": "1",
  "status": "draft",
  "title": "修复 VSPi 运行控制与反馈层级",
  "plan_hash": "3c75fe8c1eb3fdd0c4e02a90ddca5c88fbc58166bb6ab6c2c7baf4c33ac54341"
}
```
