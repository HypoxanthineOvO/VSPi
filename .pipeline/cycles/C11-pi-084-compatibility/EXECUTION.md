---
kind: execution-log
cycle: C11-pi-084-compatibility
updated: 2026-08-09T12:05:00+08:00
---

# Pi 0.84 兼容迁移与 Agent Core 跟进执行记录

## 2026-08-08 - Proposal 调研与编译探针

- **计划项：** Proposal 前置调查（对应 `M1` 输入）
- **目的：** 判断 Pi 0.84 release 是否值得跟进，以及 agent-core 新 API 是否应进入 VSPi 架构。
- **结果：** 建议升级到 0.84.1，但将依赖/TUI 兼容迁移与 agent-core v4 架构采用拆开；后者先隔离 spike。
- **证据：** Pi 官方 0.83.0/0.84.0/0.84.1 release notes；npm latest；临时目录 0.84.1 `tsc --noEmit` 失败清单；仓库调用点扫描。
- **计划影响：** 新建独立 C11，不扩张尚未开始的 C07；S2 决策完成后再同步 C07 的实现假设。
- **遇到的问题：** 0.84 release 的 headline 未突出 TUI class→interface 的直接影响，必须以实际类型检查确认；agent-core v2 harness 尚有明确未实现路径。
- **下一步：** 等待 Proposal 确认；确认并开始后执行 `M1`。

## 2026-08-08 - Proposal 范围修订

- **计划项：** Proposal review（对应 `M1` 前置范围确认）
- **目的：** 根据用户讨论决定，将本轮从宽泛的 Agent Core 跟进收紧为 fullscreen TUI 与 Markdown 交付。
- **结果：** 计划调整为 `M1 → M2 → M3 → M4 → S1 → M5`；RemoteSession、Session Handoff 替换与 Agent Core 明确暂缓。
- **证据：** upstream fullscreen 实现使用 `TuiAltScreen`、`ScrollView`、`VStack` 与固定 dock；`ScrollView` 仍调用 child 全量 render，因此 VSPi window/cache 保留。
- **计划影响：** 仅保留一个真实产物 Stone；不修改 C07 Agent 架构假设。
- **下一步：** 等待修订 Proposal 确认并决定是否立即开始 `M1`。

## 2026-08-08 - Proposal 已确认但暂不开始

- **计划项：** Proposal confirmation（`M1` 前置 gate）
- **目的：** 记录用户对 fullscreen TUI 与 Markdown 交付范围的决定。
- **结果：** Proposal 已确认；用户选择暂不开始，全部 `M1 → M2 → M3 → M4 → S1 → M5` 保持 pending。
- **证据：** 本 Session 的结构化 Proposal 决策为 `confirm_hold`。
- **计划影响：** 无源码、依赖或测试变更；RemoteSession/Agent Core 继续排除在本 Cycle 外。
- **下一步：** 等待用户明确开始后进入 `M1`。

## 2026-08-09 - 开始执行 M1

- **计划项：** `M1`
- **目的：** 建立 Pi 0.84.1 与 TypeBox 1.3.7 的可编译、可测试基线。
- **结果：** 用户已明确开始；`M1` 标记为 in_progress。
- **证据：** 本 Session 用户指令“开始吧”。
- **下一步：** 升级依赖、迁移 TUI class/interface API 并运行 check。

## 2026-08-09 - M1 完成并进入 M2

- **计划项：** `M1` → `M2`
- **目的：** 建立 Pi 0.84.1 可编译基线后开始 dual TUI shell。
- **结果：** 依赖统一到 Pi 0.84.1/TypeBox 1.3.7；`ScrollbackTUI` 改用 `TuiMainScreen` 公开 render-state API；M1 completed，M2 in_progress。
- **证据：** `npm ls` 无重复/invalid；`npm run check` 通过；5 个定向文件 49 tests passed。
- **遇到的问题：** upstream `TUI` 已变为 interface，headless/auth/tests 的直接实例化均需改为 `TuiMainScreen`。
- **下一步：** 拆分 transcript/dock surfaces 并接入 fullscreen/regular renderer。

## 2026-08-09 - M2–M4 完成，S1 等待审阅

- **计划项：** `M2`、`M3`、`M4` → `S1`
- **目的：** 交付默认 fullscreen、regular fallback、长会话边界与 Markdown 增强的真实可审阅产物。
- **结果：** transcript/dock 拆分为 upstream layout；模式和滚动条可持久切换；fullscreen tail 使用 80 blocks/60k chars 有界反向读取；LaTeX 与 Mermaid 已接入，链接点击采用 HTTP(S) allowlist 和无 shell launcher。
- **证据：** `npm run check` 通过；fullscreen/Markdown/settings/media/transcript 五个文件 61 tests passed；10k tail proxy 断言 indexed reads <500。
- **遇到的问题：** regular 三屏裁剪最初限制了 fullscreen 历史，已改为独立上限；Pi Mermaid transformer 未公开 export，改用其同版本底层 `grok-mermaid@0.2.2` direct dependency 与等价 top-level transform。
- **安全：** 模型输出链接仅在用户点击后打开，只允许 HTTP(S)，限制 8192 字符，launcher 使用参数数组且不经过 shell。
- **下一步：** 等待用户审阅 fullscreen/regular 与 Markdown 真实产物；接受后执行 M5。

## 2026-08-09 - S1 已接受并进入 M5

- **计划项：** `S1` → `M5`
- **接受范围：** Pi 0.84.1 fullscreen 默认体验、固定 dock、regular fallback、长历史性能边界以及 Markdown/LaTeX/Mermaid 呈现。
- **接受证据：** 用户在结构化 Stone review 中选择“接受并继续 M5”。
- **剩余风险：** 全量 regression、PTY、build、smoke 与依赖 audit 尚待 M5 验证。
- **下一步：** 执行 M5 全量质量门禁并更新文档/交付证据。

## 2026-08-09 - M5 完成，提交 Cycle 最终审阅

- **计划项：** `M5` → `final-review`
- **结果：** 文档已更新 fullscreen 默认、regular fallback、滚动语义、TUI/Mermaid 设置与 PTY 验证方法；Pi 0.84 auth interaction 与 package postinstall 兼容断点已修复。
- **完整证据：** `npm run check` passed；`npm test` 在 build 后 110 files/800 tests passed；fullscreen PTY、regular scrollback PTY、Session handoff、真实 tarball install 均通过；`npm run smoke` passed；`npm audit --omit=dev` 为 0 vulnerabilities；`git diff --check` passed。
- **依赖证据：** Pi coding-agent/tui 0.84.1、TypeBox 1.3.7、brace-expansion 5.0.9、grok-mermaid 0.2.2 单一有效树。
- **问题与处理：** Pi 0.84 `ModelRuntime.login` 会 spread interaction，已把 prototype dialog 方法绑定为 own properties；Pi nested brace-expansion 已到 5.0.9，postinstall 现在接受安全版本并只替换 5.0.7/5.0.8；旧 PTY 测试通过显式 renderer 覆盖分别验证两种模式。
- **剩余风险：** RemoteSession/PiClient/Agent Core v4 按 Cycle 边界未采用；开发依赖 audit 仍由既有工具链管理，生产依赖 audit 为 0。
- **下一步：** 等待用户接受 Cycle 最终结果；接受后关闭 C11 并生成 Summary。

## 2026-08-09 - Cycle 最终结果已接受

- **接受范围：** C11 全部 M1–M5、S1 产物、验证证据、文档与明确暂缓边界。
- **接受证据：** 用户在结构化 Cycle final review 中选择“接受并关闭 C11”。
- **结果：** C11 状态改为 closed，生成 `SUMMARY.md`，项目与 Cycle 索引同步。
- **剩余边界：** RemoteSession、PiClient、Agent Core v4 留待未来独立 Cycle；本 Cycle 不发布版本。
