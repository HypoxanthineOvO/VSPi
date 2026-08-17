---
kind: discussion-summary
cycle: C17-prompt-cache-deepseek-adaptation
updated: 2026-08-17T23:31:21+08:00
---

# 前缀缓存与 DeepSeek Harness 适配讨论摘要

## 已确认要求与决定

- 目标项目是独立 TypeScript 项目 VSPi，不是 VSP-Codex Rust 客户端；建立独立 C17，不并入已关闭的 C16 或 VSP-Codex C22。
- 缓存目标是尽量保持 request prefix 不变，使正常对话只在历史尾部追加；system prompt 与 tool surface 的变化必须限定为明确 cache epoch。
- Pi 已提供的 `cacheRead`/`cacheWrite` 必须进入 VSPi 正式 Usage surface；Cache Hit Rate 与费用直接相关，需要在状态栏和 `/usage` 中展示并解释。
- 动态 Plan、Workflow、Goal、Review 状态不应每轮注入模型；稳定提示词鼓励/要求模型在相关边界自行查询，查询结果作为正常 tool result 追加。
- DeepSeek Feature 采用完整 `pi-dsh-minimal` anchored-standard，不采用仅添加提示词的近似方案；默认研究 V4 Pro 与 V4 Flash。
- S1 需要一份详细 Before/After 模拟报告，按短、中、长上下文说明命中率到底提高多少；主表使用人民币，计费覆盖 DeepSeek Flash/Pro 官方旧版单一价与新版峰谷价、GLM 5.2、Kimi K3、GPT-5.6 Sol/Luna。

## 仓库事实

- VSPi 与 `pi-dsh-minimal` 均基于 Pi SDK 0.84.2，已有 `before_agent_start` 与 `before_provider_request` 接入点。
- 当前 VSPi 的 Prompt Profile 本身在模型不变时通常稳定；主要 cache 破坏源是 Plan/Workflow/Goal/Review 的动态 system overlay。
- Local Plan `plan_read` 当前要求 `plan_id`，Goal 已有无参数 `goal_status`，Hypo-Workflow 只有宿主 snapshot 而没有模型只读 status tool；M2 需要补齐无需预知 ID 的查询入口。
- VSPi 当前 `UsageSnapshot` 只暴露 input/output 与总费用，遗漏 Pi session stats 中的 cacheRead/cacheWrite。

## 上游调研结论

- 固定版本：`Averyyy/pi-dsh-minimal v0.4.0@bdc2bec3c5fbd8ec2f9497e61d0a30e2ca079386`，MIT。
- 激活机制不是显式 CoT guidance；关键是首个 provider request 的 exact system/tool schema。`We need...` / `I need...` 只是行为探针。
- bootstrap system 为 `You are a helpful software engineer assistant.`；工具严格为 `bash`、`str_replace_editor`，不得带 `strict`/`additionalProperties`。
- 首个 assistant message 或 tool call 后 promotion；compaction 后下一个普通请求重新 bootstrap。该两阶段切换会造成一次有意 cache reset。
- 上游测试通过，但公开仓库未包含 README 所称 113 题逐题数据，因此本 Cycle 必须自行做真实 A/B。

## 价格与模拟证据

- DeepSeek 2026-04-24 官方旧价为单一人民币价：Flash 缓存命中/未命中/输出 `0.20/1.00/2.00`，Pro `1.00/12.00/24.00`，单位元/百万 tokens。
- DeepSeek 新价自 2026-08-17 00:00（北京时间）生效：空闲档 Flash `0.05/1.50/4.50`、Pro `0.15/4.50/13.50`；高峰档 Flash `0.10/3.00/9.00`、Pro `0.30/9.00/27.00`。高峰为北京时间 09:00-12:00、14:00-18:00。
- `models.dev` 的 OpenCode Go USD catalog 变化不是 DeepSeek 官方人民币价；此前识别的 Flash `2x usage` 促销快照不进入主模拟，只保留为 catalog provenance/freshness 风险证据。
- S1 固定交付 `CACHE-SIMULATION.md`，主表统一为人民币，将实测 cache read 和请求结构推导的可缓存 token 分开，覆盖约 4K/32K/256K，并对 1M context 模型增加约 512K 场景。
- GPT-5.6 Sol/Luna 属于 VSPi `vsplab` provider，继承 Pi `openai-codex` 成本/tier/context（272K context）；M1 需进一步核对 VSPLab 实际人民币账单。GLM 5.2 与 Kimi K3 同样优先采用实际计费 Provider 的人民币价。
- 用户确认外币换算使用 `1 USD = ¥6.80`。VSPi 现有固定 `7.18` 已过期；M1 将修正并在 UI/报告显示汇率与估算属性。DeepSeek 官方人民币价不经过换算。
- 用户接受 S1 的 Cache/UI、稳定 prompt、按需状态工具和修订后三口径模拟，授权继续 M3/M4；全部完成并通过 S2/M5 后发布为 `1.1.0`。
- Kimi K3 官方人民币价为命中/未命中/输出 `2.00/20.00/100.00` 元/百万 tokens。GLM 5.2 官方文档确认自动缓存但没有公开确切人民币价；OpenCode Go catalog × 6.80 仅作估算。
- VSPLab 未公开 Sol/Luna 人民币价；Pi catalog × 6.80 的 Luna 命中/未命中/cache-write/输出估算为 `0.136/1.36/1.70/8.16` 元，Sol 为 `3.40/34.00/42.50/204.00` 元，实际账单价保持 unknown。
- 用户确认完整 Proposal 但要求暂不开始。随后补充：状态栏在 Context 左侧实时显示当前与平均输出速度；compaction 后 Context 数字不能消失。
- 吞吐口径确定为最近 2 秒滚动 `now` 与 Session 完成输出加权 `avg`，排除 TTFT/工具/等待；空闲保留 avg，窄屏优先 now。
- Pi compaction result 已提供 `estimatedTokensAfter`，VSPi 可在下一次可信 assistant usage 前显示带 `~` 的 Context 估算；失败/取消保留压缩前值。
- 正式输出视觉方案已确认：中间 assistant 文本使用灰色 `·`；普通 stop 输出前使用无文字横线，正文首行用亮色 `✦ ` 且保留一个空格。不使用 `Final result` 标签、完整框或背景色。
- 输出层级按协议 stop reason/tool-call 结构区分，不要求判断整个任务是否真正 final；error/aborted 保留现有语义。横线和符号只在渲染层添加，不污染上下文或 Session 正文。
- 用户接受 S2，确认 direct/relay DeepSeek V4 Pro/Flash 默认启用 anchored-standard，并保留 `VSPI_DEEPSEEK_HARNESS=0` 关闭开关。
- M5 发布前门禁完成后，用户要求在任何 commit/tag/push/Release 动作前暂停，先使用 VSPi 自己修改 README；README 完成后重新复核并重建发布包。

## 未决事项

- 无。用户完成 README 后明确反馈不应为 README 设置静态测试；README 测试已移除，1.1.0 已完成双平台发布。

## Discussion Ledger

完整用户原文保存在 local-private Ledger：`.pipeline/local/discussions/C17-prompt-cache-deepseek-adaptation/01a00ed7-119b-7d82-a459-055f4a37979c.md`。
