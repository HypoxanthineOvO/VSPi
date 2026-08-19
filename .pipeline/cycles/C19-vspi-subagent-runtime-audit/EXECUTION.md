---
kind: execution
cycle: C19-vspi-subagent-runtime-audit
updated: 2026-08-19T13:05:00+08:00
---

# Execution Checkpoints

## 2026-08-18 - C19 建立与调查对象纠正

- **计划项：** `M1`/`M2`/`M3`
- **目的：** 检查用户最近 VSPi 会话中涉及 Subagent runtime 的巨大 Bug，先整理现状，用户批准后才讨论方案。
- **纠正：** 首轮错误读取 `~/.codex/sessions/` 并分析 VSP-Codex Agent Workspace；用户指出对象错误后，该证据链全部作废。本 Cycle 的唯一会话来源改为 VSPi 原生 `~/.pi/agent/sessions/`。
- **目标会话：** `01a01527-4d36-7d6a-ac2c-1c0567bd2a4c`，cwd 为本仓库。
- **首轮事实：** 讨论 Subagent 的文本触发 `explicitAgentRequired`；4 个并行调用中 3 个报 run token budget exceeded，1 个报 child limit 3；用户再次追问时同一触发条件再次出现。
- **源码确认：** `beginRootTask` 使用关键词正则推断明确要求；`assertRootTaskComplete` 在无成功 Subagent 时抛错；run/tree token 统计包含 cacheRead/cacheWrite；预算检查位于 `session.prompt` 完成后；scheduler 存在未在工具描述中披露的 per-parent 3 child 上限。
- **下一步：** 核实发送失败如何回到 UI、现有测试为何固化/漏检这些行为，并输出 M4 报告。

## 2026-08-18 - M3/M4 完成，进入 S1

- **计划项：** `M3`/`M4`/`S1`
- **提交回滚确认：** backend 的 `assertRootTaskComplete()` 异常进入 `VspiApp.submit()` catch；app 删除本轮新增 transcript、恢复提交前消息长度，并把用户原文放回 composer。用户“问题被退回来”的观察得到源码直接支持。
- **测试：** Agent 定向套件 8 files / 49 tests 全绿；现有测试固化关键词 gate、per-parent child=3 和小型预算错误，但缺少最终成果被预算/authority 覆盖及 app 回滚的组合测试。
- **报告：** `AUDIT.md` 记录 P0×2、P1×2、P2×1，明确区分确认事实和未量化边界；没有写修复方案。
- **下一步：** S1 等待用户批准或要求补充调查；批准前不进入方案设计。

## 2026-08-18 - S1 接受，进入 M5 方案讨论

- **接受范围：** 用户批准 `AUDIT.md` 的现状、因果链、问题分级与未决边界。
- **验证依据：** 正确 VSPi Pi session、当前源码静态链路、Agent 定向套件 8 files / 49 tests。
- **未授权事项：** 接受不等于批准修复方案或源码实施；产品源码仍未修改。
- **下一步：** M5 分开讨论 P0 立即止血与长期 v2 runtime，形成可在 S2 审阅的实施计划。

## 2026-08-18 - M5 第一组架构决定

- **交付：** 两阶段；先解除 P0 事务故障，再实施 v2 runtime。
- **生命周期：** Agent 绑定 Root Session，跨 turn 与进程 resume 保留，Root Session 之间严格隔离。
- **Teammate：** 先 Ban 而非删除；关闭入口与自动/手动路由，保留代码、配置兼容和历史数据，后续另议。
- **预算：** token/cache/cost/elapsed 全部只做 telemetry，不作为 VSPi Agent 的停止、拒绝或成果作废条件。
- **下一步：** 决定 v2 API 兼容、并发排队、上下文 fork、工具继承和用户交互边界。

## 2026-08-18 - M5 第二组运行时决定

- **旧工具：** v2 上线时直接删除旧 `subagent`，不保留兼容 wrapper 或双工具面。
- **并发：** VSPi 不设 active generation capacity；spawn 立即运行，仅受 provider/系统资源与显式 interrupt 约束。
- **上下文：** 未指定时默认 `fork_turns=all`，从 spawn 时的完整可见历史建立结构化分叉。
- **工具：** 继承 caller 工具，排除 Root Session 所有权和直接用户交互控制；保留 execution policy 与共享工作区约束。
- **下一步：** 决定嵌套深度、完成回传、崩溃恢复和 UI 交互边界。

## 2026-08-18 - M5 需求讨论完成，仅保存 Plan

- **本轮边界：** 用户明确要求只讨论需求并记录 Plan，因额度原因不开始真实修改。
- **P0：** 选择完整范围，包含意图/final 事务、预算与 scheduler、Teammate Ban、bash 分类和基础进度。
- **树与恢复：** depth 可配置默认 3；resume 保留 identity/history，未完成 turn 标记 interrupted，不自动重跑。
- **通信：** child final 全文自动给直接 parent，Root 仅收后代状态/摘要；interrupt 默认目标，可选 descendants。
- **UI：** Root-only composer + 只读 Inspector；Transcript 和 `/agents` 共用事件模型。
- **Identity：** 稳定 path 寻址 + 可选中文 nickname。
- **产出：** `PLAN.md` 已包含 `P0-1`~`P0-6` 与 `V2-1`~`V2-8` 的两阶段实施计划和验证目标。
- **未授权：** 未修改 `src/`、`test/`、依赖、版本、构建或发布记录；S2 留待以后恢复。

## 2026-08-19 - S2 批准，P0-1~P0-7 实施完成，停在人工审阅

- **授权：** 用户 S2 批准 P0 完整范围（含后续补充的 P0-6 界面微调、P0-7 回归+人工审阅门），目标版本 v1.1.2；v2 runtime 另行发 v1.2.0。
- **P0-1（门禁整体删除）：** 删除 `explicitAgentRequired`、`mentionsAgent`/`rejectsAgent` 正则、`assertMainAction`/`assertRootTaskComplete` 中的关键词 gate 与轮末 authority 断言；仅保留 persistent-agent-mutation 防护（C07 契约）。
- **P0-2（预算降级遥测）：** 删除 `assertRunTokenBudget`、scheduler `assertBudget()`、per-parent children/tree-size 强制；`child()` 仅保留 cancelled + depth≤3 检查。6 个 max* 字段留在 config，`runBudget()` 计算 `warnRunTokens/warnTreeTokens/warnTreeCost/warnElapsed` 仅用于 UI 标黄。
- **P0-3（Teammate 完全隐藏）：** `PiAgentManager.teammatesEnabled = false` 静态开关；routing、`task.teammate` 参数、`/agents model|reset|override` 命令全部拒绝并提示"暂不可用"；UI 面板/transcript 不再渲染 teammate 块；`agents.json` 配置数据原样保留。
- **P0-4（bash 分类修正）：** `looksReadOnly` 重写为 fd 语义——只有打开文件写入的重定向（`>file`、`2>err`、`&>all`、`| tee`）才降级；丢弃式（`>/dev/null`、`2>/dev/null`）与纯 fd 复制（`2>&1`、`>&2`）保持只读分类。19/19 分类矩阵通过。
- **P0-5（进度可见）：** 订阅 `tool_execution_start`/`tool_execution_end` 事件，snapshot 新增 `currentTool`/`lastActivityAt`；`/agents` Map 行显示 `· tool X · tN · HH:MM:SS`，Timeline 显示当前工具+已运行时长；transcript 子代理卡片显示 Progress（当前工具/轮次/活动时间）与 Usage（run/tree 含 ⚠ 超警戒线标黄）。
- **P0-6（状态栏微调）：** Speed 只显示平均吞吐（`42t/s`，瞬时值与 CH 缩写移除）；Cache Hit Rate 并入 Token 行（`Token ↑x ↓y Hit Rate: z%`，最近请求口径）——**仅 ≥120 列显示**，80 列维持原 Token 槽宽以保住 cwd 不被截断。Speed 槽 22→16/12 列。
- **P0-7（回归）：** `npx vitest run` 129 files / 954 tests 全绿；`tsc --noEmit` 干净；`biome check` 无问题。适配的测试文件：agents-authority（8 重写为 ban 语义）、agents-manager（6）、agents-scheduler（3）、transcript、agents-ui、agents-pty（`limits d3`→`depth 3`）、status-presentation、m1-status-runtime-labels、m5-status-layout-contract（值着色含 `Hit Rate: —`）。
- **实现偏差记录：** Hit Rate 原计划并入 Token 行未限定宽度，回归发现 80 列下 cwd 被挤至 8 列（`/workspa…`），违反 M1 状态栏契约，故改为 ≥120 列限定；已在 status.ts 注释说明。
- **未授权事项：** 未改版本号、未构建、未发布、未提交 git；按 Plan 停在人工审阅，等待用户确认后才进入 v1.1.2 发布流程。

## 2026-08-19 - S3 免审通过；新增 F1-F3 快速修复并直接发布 v1.1.2

- **用户决定：** 跳过 P0 人工审阅直接发布 v1.1.2；同轮批准 F1-F3 快速修复（外部会话事故归因后）一并进版；提示词引导保持通用口径，不点名具体配置文件或事故。
- **事故归因：** 用户转来的会话 JSONL（`tmp/2026-08-19T04-49-48-142Z_*.jsonl`，Windows、vsplab/gpt-5.6-sol）显示模型把 `node_modules/@earendil-works/pi-coding-agent/docs/`（含 `/reload` 热加载、`shellPath`、扩展注册命令）当事实来源，先后推荐不存在的 `/reload`、`/wsl-fix`、`vspi -c`；约六成 Harness 缺陷（无命令契约、捆绑误导文档、产品差异零声明）+ 四成模型越权（最终直接 patch 了 npm 安装的产品 dist）。
- **F1：** `describeCommandsForPrompt()` 从 `ACTION_REGISTRY` 动态生成命令清单 + 产品差异声明 + `/reload` 通用引导，注入 `VSPI_LANGUAGE_CONTRACT`（`src/domain/commands.ts`、`src/prompts/pi-prompt-profile-extension.ts`）。
- **F2：** `/reload` 注册为 canonical 命令；handler 在空闲时 spawn `process.execPath + [argv[1], "continue"]`（stdio inherit、同 tty），依赖既有 session lease handoff 完成接管，3 秒未移交兜底 `onExit`；运行中（runActive）拒绝。`reloadLauncher` 注入口供测试。
- **F3：** `scripts/trim-pi-docs.mjs` 挂 postinstall，移除 pi-coding-agent 的 `docs/`、`examples/`、上游 README 与 pi-tui 的 `docs/`（均描述上游 CLI 行为）；CLI 补 `-c/--continue`、`-r/--resume` 别名（`startupSessionMode` 与入口分发双处归一），help 更新。全新 tarball 安装实测：文档目录不存在、`vspi --version` 正常。
- **测试：** `test/c19-command-contract.test.ts`（10 tests：契约同步/产品差异声明/引导口径无事故细节/系统提示词嵌入/CLI 别名一帧渲染/help）+ `m1-action-registry-contract` 新增 3 个 `/reload` 用例。
- **发布：** 按 C18 流程执行 v1.1.2：bump → 回归 → commit → tag → GitLab CI → permalink 验证。
