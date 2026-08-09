---
kind: discussion-summary
cycle: C11-pi-084-compatibility
updated: 2026-08-09
---

# Pi 0.84 兼容迁移与 Agent Core 跟进讨论摘要

## Discover

- 用户希望依据 Pi 官方最新 release/news 判断 VSPi agent core 等组件是否需要跟进。
- VSPi 固定在 0.82.1，最新为 0.84.1；直接升级已确认不能编译。
- 本次工作与 C07 的 Agent 能力有关，但也影响 TUI、provider、session 与通用 SDK，独立 Cycle 更便于控制兼容迁移和架构决策。

## Technical

- 必须处理 TypeBox 1.3.7 对齐与 Pi TUI class/interface 拆分。
- coding-agent 的 JSON/RPC delta 变更不等于 SDK `AgentSessionEvent` 必然破坏；需要 contract tests 而非按文案盲改。
- Pi 0.84 新增的 fullscreen、remote client、Markdown rendering 和 provider 能力均为选择性产品功能，不属于兼容升级必选项。

## Architecture

- 当前 `PiAgentManager` 自建树调度、并发 lease 与 Teammate lane，并用 coding-agent `SessionManager` 持久化。
- pi-agent-core v4 的 lane/session repo/durable operation 与 C07 有潜在重叠，但 AgentHarness v2 尚未全路径完成。
- 推荐先升级兼容层，再用隔离 spike 决定是否采用稳定 primitives；禁止同时维护两套 session authority。

## 已确认范围

- 本轮优先完成 Pi 0.84 fullscreen TUI 迁移与微调，并主动增强 Markdown。
- 现有 Box 与 VSPi 视觉规范继续保留；fullscreen 使用 upstream viewport/dock primitives，性能继续由 VSPi window/cache 控制。
- RemoteSession、Session Handoff 替换、pi-agent-core v4 与 AgentHarness v2 暂不实施。
- Proposal 已确认；用户选择暂不开始执行。

## 未决决定

- `S1` 已接受：默认 fullscreen、regular fallback、固定 dock、长历史边界与 Markdown/LaTeX/Mermaid 产物符合当前审阅范围。
- Cycle 最终结果已接受并关闭；RemoteSession、PiClient、Agent Core v4 继续明确暂缓。
