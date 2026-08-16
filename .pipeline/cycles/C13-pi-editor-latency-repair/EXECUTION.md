---
kind: execution
cycle: C13-pi-editor-latency-repair
updated: 2026-08-16T18:29:19+08:00
---

# Execution Checkpoints

## 2026-08-15 - M1 Cycle 建立与讨论聚焦

- **计划项：** `M1`
- **目的：** 将 0.6.3 验收修订从长期 Release Train 中分离，并在实现前说明官方 Editor 外观与卡顿根因。
- **结果：** C13 通过 `builds_on: C12-release-train` 创建并聚焦；用户选择先看官方/包裹版原型，不授权 M2 产品实现。
- **证据：** 当前聊天的 Cycle 与 Composer 结构化选择；Pi 0.84.2 公开 Editor API 和 VSPi Composer 调用链审计。
- **计划影响：** 候选计划保持 discussing；S1 未完成。
- **遇到的问题：** 工作区存在讨论前的未提交探索改动，不能把它们当作已接受实现。
- **下一步：** 只读渲染两种输入框并建立按键延迟 trace。

## 2026-08-15 - M1 官方 Editor 外观与左移热路径原型

- **计划项：** `M1`
- **目的：** 回答官方 Editor 的真实外观，并区分 upstream 输入算法与 VSPi 二次绘图的性能责任。
- **结果：** 官方 Editor 为上下横线夹输入区；0.6.2 包裹版切除官方边框、缩窄两列并重画圆角四边框。Pi 0.84.2 每次水平左移仍会重建完整 visual-line map，并分段光标前全部 grapheme；VSPi 的二次布局增加成本，但不是主要根因。
- **证据：** 10K 字符、120 次左移+重绘：官方 Editor 1505.4ms；只替换水平左移定位算法的临时运行时原型 547.4ms，提升 2.75x；200/2K/10K 的每键总成本随文本长度约为 0.39/2.47/12.39ms。
- **计划影响：** S1 需要同时选择外观所有权和 narrow upstream compatibility patch；不能把全局 glyph 替换当成性能修复。
- **遇到的问题：** 即使优化左移，官方 `render()` 仍对未变化全文重新 layout；10K 字符 120 次纯 render 约 542ms，后续需评估 upstream layout cache 或可接受输入上限。
- **下一步：** 向用户展示两种外观、调用链和推荐修复层级，等待 S1 决策。

## 2026-08-15 - M1 cache 架构原型与 S1 方向选择

- **计划项：** `M1`、`S1`
- **目的：** 验证是否存在接近 Codex 体感的更快算法，并确定 Composer 外观所有权。
- **结果：** 临时原型缓存每个逻辑行的 grapheme boundaries 与 word-wrap chunks，纯 cursor move 只叠加 cursor；用户选择保留 0.6.2 圆角 hybrid，并要求采用更快算法。
- **证据：** 10K 字符、120 次左移+重绘 baseline 1494.1ms，cached prototype 7.1ms，211.9x，约 0.059ms/key；2K 场景 81.1x。原型未修改产品文件。
- **计划影响：** M1/S1 completed；形成 M2-M4/S2 完整 Proposal，等待开始授权。
- **遇到的问题：** 原型只覆盖普通 grapheme/word wrap；正式实现必须保留 paste marker 原子性、emoji/combining character、IME、autocomplete、undo 和竖向 sticky-column 语义。
- **下一步：** 用户确认并开始、确认但不开始，或继续讨论。

## 2026-08-15 - Proposal 确认并开始

- **计划项：** `M2`
- **目的：** 冻结 C13 计划并取得产品修改授权。
- **结果：** 用户确认并开始 M1→S1→M2→M3→M4→S2；hybrid Composer、narrow Pi patch、0.84.2 模型目录与 Windows 验收边界冻结。
- **证据：** 当前 Session 的结构化 Proposal 决策。
- **计划影响：** Cycle status active；M2 in_progress。
- **遇到的问题：** 讨论前探索 diff 混合了正式候选和已否决的旧动画试验，需先重组。
- **下一步：** 撤掉旧动画试验，分离 Editor、模型和视觉工作流并定向验证。

## 2026-08-15 - 实机 freeze incident diagnosis

- **计划项：** `M2`
- **目的：** 响应“运行一会儿直接卡死”的新反馈，避免把不同故障误归因于已知 Editor 长文本热路径。
- **结果：** 暂停实现。异常 VSPi `PID 3435980`（`/dev/pts/0`）连续 5 秒 CPU/IO 为 0、RSS 约 163MiB、无外网 socket；系统仍有约 396GiB 可用内存。进程已成为 PPID 1、后台 PGID `3435978`，而前台 shell `PID 3408262` 阻塞于 `iterate_tty_write`。TTY 已禁用 IXON，排除 Ctrl+S 软件流控。
- **证据：** Session `2026-08-15T08-59-22-575Z_01a004a5-b04f-7a3d-a2af-7f9f89e0d603.jsonl` 约 180KB，在本地 17:06:38 的正常 tool result 后停止追加；`pidstat`、`ss`、`/proc`、`stty` 和 process-group 快照。
- **计划影响：** M2 保持 in_progress，但正式 patch 暂缓；先恢复并用诊断构建区分 PTY ownership、runtime wake-up、provider wait 与 Editor layout。
- **遇到的问题：** 同期 delegated workers 的上游 503 是独立证据，不能解释该 VSPi 进程无网络连接且终端 process-group 异常的状态。
- **下一步：** 用户关闭/重开该终端，或确认终止孤儿 VSPi 并重置 `/dev/pts/0`；恢复后进行带 timing/TTY trace 的受控复现。

## 2026-08-15 - Freeze audit wrap-up

- **计划项：** `M2` incident diagnosis
- **目的：** 在用户 Token 耗尽前收束证据，不把未完成的修复当成结果。
- **结果：** 已备份冻结 Session（180425 bytes，SHA-256 `5fac7dc14005904459a4e6e6282629e07ea054ebe11146434cb5c8c03e6c0d1c`），并按用户授权终止孤儿 `PID 3435980`。终止后 shell 从 `iterate_tty_write` 解阻塞；`/dev/pts/0` 曾残留 raw mode，关闭/重开终端是恢复方式。
- **根因链：** (1) 实际冻结 Session 使用 Pi 0.84.1，最后落盘事件是 toolResult，无后续 assistant/message_end；Pi 0.84.2 changelog 明确修复 upstream request buffer failure 不触发 assistant retry，当前 VSPi 无 prompt watchdog。(2) `shutdownInteractiveSession` 先 await `app.dispose()`，而 backend/AgentManager 的 abort 可能不收敛，导致 TUI.stop 未执行、raw mode 残留。(3) 本次配置是 fullscreen + expanded thinking + 未折叠工具；因此 regular active/waterfall 的无界 tail 不是本次现场的已证实路径，但仍是另一个风险。fullscreen 下单个超长 streaming thinking block 仍可能被完整送入 Markdown/layout；Pi TUI 直接写 stdout 不处理 backpressure，需单独回归验证。另有 handoff double-stop/drain 竞态。
- **验证：** targeted terminal/handoff/continuity tests 中 handoff/continuity 通过；完整 transcript/startup 集合有既存 Unicode/visual baseline 失败，不能作为本轮修复通过证据。当前未保留本轮未完成的 shutdown/active-tail 代码改动。
- **计划影响：** C13 保持 active；下一轮应先加 deferred-dispose、launcher-parent-death、巨型 streaming message/backpressure 回归，再实现并验证最小修复。
- **下一步：** 等待用户后续 Token/授权；不继续执行模型请求、全量测试或源码修改。

## 2026-08-15 - M2/M3 实现与 freeze 加固

- **计划项：** `M2`、`M3`
- **目的：** 按用户“尝试修复”授权，实现并验证 Pi Editor 性能补丁、模型目录修订与 freeze 根因链的最小修复。
- **结果：** M2/M3 completed。`scripts/patch-pi-editor-performance.mjs` 通过 `postinstall` 对 `@earendil-works/pi-tui` 0.84.2 的 direct 与 pi-coding-agent nested 两份安装应用版本守卫补丁（grapheme/折行缓存 + 水平移动优化），源码锚点/版本不匹配时 fail closed；shutdown 改为先 stop TUI 再 dispose 并加 10s 超时；新增 launcher parent-death watchdog（`VSPi_NO_PARENT_WATCHDOG=1` 关闭）；thinking 渲染端 200K 字符截断。模型侧完成 0.84.2 升级、GLM-5.3/baseten/qwen-token-plan-individual curated 可见性、availability refresh 合并与模型排序缓存，并恢复 0.6.2 Unicode 视觉基线（capability ASCII 回退）。
- **证据：** 10K/120 左移+重绘回归 64ms（阈值 500ms）；grapheme/ZWJ/paste marker/vertical 语义测试；`test/pi-editor-patch.test.ts` 8 项、`test/startup-shutdown.test.ts` 3 项、`test/parent-watchdog.test.ts` 4 项；全量 117 文件/859 测试通过；`npm run check`、`npm run build` 通过；`npm audit --omit=dev` 0 漏洞；m9 pack+install+smoke 在空项目验证 postinstall 补丁生效。
- **计划影响：** M2/M3 completed；M4 的 check/test/build/PTY/audit/pack/install 门禁通过，剩余 S2 Windows 实机验收。
- **遇到的问题：** 工作区探索 diff 中混有与 0.6.3 已验证方向冲突的 glyph 迁移；经逐文件与 0.6.2 对比确认该迁移正是 M3“恢复 0.6.2 视觉基线”的正式候选（composer 圆角、splash、语义字形），保留并同步测试。pack 后的 postinstall 曾因 resolve 返回文件路径而 ENOTDIR，已修复 walk-up 与 ENOTDIR 处理。
- **下一步：** 等待 Windows 实机验收（S2）或拒绝反馈。

## 2026-08-15 - 版本与验收目标修正

- **计划项：** `S2`
- **目的：** 澄清 S2 验收目标与发布版本号。
- **结果：** 用户确认本机是实际使用环境，S2 由“Windows 最终验收”改为“本机最终验收”（Windows 仅当实际使用场景存在时补充）；发布候选版本号确认为 v0.6.4，`package.json` 已从 0.6.3 提升。
- **证据：** 当前 Session 的用户反馈；`package.json` version 0.6.4。
- **计划影响：** PLAN/S2、PROGRESS、DISCUSSION-SUMMARY 同步更新；新增 Memory 决策记录。
- **下一步：** 本机安装 v0.6.4 候选并验证输入、开屏与模型列表；接受后收尾 M4 发布门禁并提交。

## 2026-08-16 - 本机安装复测与 AIMoniker Gemini 配置

- **计划项：** `S2`、`M4`
- **目的：** 完成本机 v0.6.4 候选安装与可运行性验证，并按用户要求配置 Google Gemini（AIMoniker）。
- **结果：** v0.6.4 已全局安装（Volta store 副本，两份 pi-tui 均带 patch 标记；`vspi --version` = 0.6.4）。PTY 实测：2K/10K 文本输入后 120 次左移均 1–2ms，probe 响应约 20ms；全屏帧基准（300 条消息 + 10K 输入）1.53ms/帧。AIMoniker Gemini 已写入 `/home/heyx/.pi/agent/models.json`（provider `custom-gemini-via-aimoniker-32efcb06`，openai-completions，8 个 gemini 模型），Node fetch chat 验证 200。
- **证据：** PTY 时序日志；`tmp/bench-frame` 1.53ms/帧；AIMoniker `/v1/models` 与 `/v1/chat/completions` 实测；VSPi catalog 加载 8 模型；models.json 备份 `.bak-20260816000536-aimoniker-gemini`。
- **计划影响：** S2 保持 in_progress——安装与自动化验证通过，但用户实机反馈“光标效果毫无变化”，与 PTY 测量不一致；需要用户提供精确复现条件（文本长度、IME、持续按键、运行时长、终端类型、`vspi --version`、fullscreen/regular），并区分“光标卡顿”与“运行数分钟后整机 freeze”。
- **遇到的问题：** aimoniker.top 拦截 Python urllib 默认 UA（403），带浏览器 UA 或 Node fetch 正常；已记录。Gemini key 未写入仓库或输出。
- **下一步：** 用户复测 v0.6.4 并回报复现条件；若 freeze 复现则按 incident 根因链继续实现 runtime 修复；Gemini 可在 Provider/模型面板直接选择。

## 2026-08-16 - S2 拒绝、根因纠正与 corrective Proposal

- **计划项：** `S2` → `M2`
- **目的：** 根据完整用户原文重新判断“光标完全不移动，输入后才刷新”，纠正把裸 Editor 性能基准当作产品验收的错误。
- **结果：** S2 拒绝并退回 M2。端到端复现显示 Editor cursor 从 col 6 移到 5，但 fullscreen `renderSections` 连续返回相同对象和文本；字符输入触发 `VspiApp.requestRender` 后帧才变化。根因是 VSPi 0.6.0 自行加入的跨帧整页 `renderRevision/renderSectionsCache` 与 Pi 官方“输入后 immediate render + previous-lines differential”契约冲突。
- **范围变化：** 用户确认删除 SSH Attachment Bridge 的服务、通知、设置、CLI 与文档，保留本地附件和 SSH 安全/认证；默认 Execution Policy 改为 Auto；继续修复 Question Submit 对比度、动态模型显示，并以 Pi remote catalog 更新模型目录而不单独替换 shrinkwrap 内的 pi-ai。
- **验证变化：** M2 必须验证 fullscreen 可见帧而非内部 cursor；M3 增加无 Bridge surface、Auto 默认/Recovery、Question truecolor、模型切换帧与 catalog refresh 门禁；旧 M4 门禁因漏测用户路径而失效。
- **下一步：** 按用户“开工”授权直接执行重开的 M2→M3→M4，完成后重新进入 S2 本机验收。

## 2026-08-16 - Corrective M2/M3/M4 完成并重新提交 S2

- **计划项：** `M2`、`M3`、`M4` → `S2 waiting-review`
- **目的：** 修复用户真实可见的 fullscreen cursor 冻结，完成已授权的 Bridge 删除、Auto 默认、Question/model catalog 修订，并重建可信发布门禁。
- **结果：** 删除 VSPi 跨帧整页 `renderRevision/renderSectionsCache`，恢复 Pi 每帧 layout 与 differential terminal output；模型切换同步 startup/Goal model label。SSH Attachment Bridge 服务、CLI、配置、通知、文档及专测全部删除；本地附件和 SSH 安全边界保留。普通 Policy 缺省改为 Auto，Recovery 继续强制 Standard。Question Review 仅将 `Enter 提交` 作为 focus+bold 主操作。Pi runtime 启动执行一次 `force: true`、1 秒有界 remote model catalog refresh，绕过四小时节流；异常/超时降级 local models-store snapshot。
- **验证：** fullscreen 端到端测试确认 cursor col `6→5` 后 marker 与完整 frame 立即变化，并覆盖 startup/已有 Goal 的模型标签刷新；catalog 测试验证强制 network refresh、snapshot 复用、失败与超时降级。300 消息 + 10K 输入完整 section 重建约 1.03ms/次。`npm run check` 通过；最终全量 116 files / 862 tests 通过；本机 PTY 11/11；Harness read-only 为 5 upstream changes、0 diagnostics、0 writes；`git diff --check` 通过。CI 风格 pack 验证 `vspi-0.6.4.tgz`、291 files；临时空目录安装与 Fixture smoke 通过。
- **版本与安装：** `package.json`、lockfile 两处 workspace identity 均为 0.6.4，`verify-package` 新增 lock/manifest 一致性门禁。候选已安装到 Volta，旧 `~/.local/bin/vspi` wrapper 改为转发 Volta shim；从 `/home/heyx` 验证 `vspi --version = 0.6.4`、首屏 `Policy Auto · Host`，direct/nested `pi-tui` 均有 0.84.2 patch marker。
- **遇到的问题：** 初次全量测试暴露 4 条 Standard 旧预期和 remote refresh 5 秒默认值撞 Vitest 超时；预期已改为 Auto，默认网络等待收紧到 1 秒后相关测试和全量门禁通过。`/tmp/package.json` 自身固定 vspi 0.2.1，Volta 在该目录按项目依赖解析旧版；本机全局验收使用无项目 pin 的 `/home/heyx`。
- **计划影响：** M2/M3/M4 completed；S2 重新进入 waiting-review。未创建 tag、Release 或远端发布。
- **下一步：** 用户在本机真实交互验收；接受后关闭 C13，拒绝则记录具体 surface/输入序列并返回对应 Milestone。

## 2026-08-16 - 第二轮 S2 拒绝并返回 M3

- **计划项：** `S2` → `M3`
- **结果：** 用户拒绝关闭 C13，并给出三个明确问题：高终端中的 `/model` 选择界面应显示更多行；配置 OpenCode Go 后对应模型仍不可见；选择模型后应继续选择 Effort。
- **范围判断：** 三项均属于 M3 模型目录与模型选择 UX；M2 cursor 修复、Bridge 删除、Question 对比度和默认 Auto 未被本次反馈否定。
- **计划影响：** M3 重新标记 in_progress；S2 返回 pending。上一轮 check/test/PTY/pack/install 仅作为回归基线，修订后必须重新验证和安装。
- **下一步：** 检查真实 OpenCode Go provider/catalog/credential 投影与可见性过滤，审计 model panel 行数预算及 model event 的关闭逻辑，完成定向测试后进入 M4/S2。

## 2026-08-16 - 第二轮 M3 修订与自适应面板横向审计

- **计划项：** `M3`、`M4` → `S2 waiting-review`
- **根因：** Pi runtime 已识别 stored `opencode-go` credential，并在离线 catalog 中返回 19 个 available models；VSPi 将 `opencode-go` 列为 known builtin 却不属于 curated provider，visibility filter 因而删除全部 19 个模型。Model renderer 同时把 list rows 固定为 6，忽略 App 已分配的动态 bodyRows；model event 成功后直接 `completeOneShotPanel()`。
- **实现：** `opencode-go` 改为全量跟随 Pi catalog，不硬编码模型 ID；Model renderer 使用 bodyRows，高终端 panel cap 提升到 24；model 成功后读取 runtime Effort levels，失败时回退 catalog levels，并进入 Effort，确认后才关闭。按用户要求横向审计所有 panel，唯一同类问题是 wide Provider 固定 5 行，已改为使用 bodyRows；有限选项和固定表单保持内容高度，不强行填满。
- **验证：** 6 个定向文件 112 tests；高终端 Model frame 24 行、wide Provider frame 16 行；model→Effort→close 与 Effort lookup fallback；backend/visibility future OpenCode model。`npm run check`、`git diff --check` 通过；最终全量 116 files / 868 tests。真实本机 Pi runtime 和最终安装产物均为 OpenCode Go available 19 / visible 19。
- **Workflow：** 用户可见原文已追加 Discussion Ledger；新增项目 requirement `requirement.vspi.adaptive-panel-height`，Memory index 143 records 且 YAML 可解析。
- **发布门禁：** CI-style `npm pack`/verify 为 0.6.4、291 files；空目录安装 Fixture smoke 与 Volta 全局覆盖安装通过；`vspi --version` 为 0.6.4，首屏 Policy Auto。未创建 tag、Release 或远端发布。
- **计划影响：** M3/M4 completed；第三轮 S2 waiting-review。
- **下一步：** 用户本机复核高终端 Model/Provider 高度、OpenCode Go 模型和 Effort 连续选择。

## 2026-08-16 - 第三轮 S2 接受并关闭 C13

- **计划项：** `S2`、Cycle close
- **结果：** 用户明确选择“接受并关闭 C13”。接受范围包括第二轮修订的高终端 Model/Provider 自适应高度、OpenCode Go 19 模型可见性、Model→Effort 连续选择，以及此前的 fullscreen cursor、Question、Bridge 删除和默认 Auto corrective。
- **证据基线：** 最终 `npm run check` 通过；116 files / 868 tests；最终 tarball 291 files；空目录安装、Volta 覆盖安装、Fixture smoke 与安装产物 OpenCode Go 19/19 探针通过。
- **剩余风险：** Pi Editor compatibility patch 仍绑定 0.84.2，升级 Pi family 时必须重新审计或删除；启动 remote catalog refresh 强制网络但限制为 1 秒并可 local fallback；Harness 仍报告 5 个 upstream ref 变化、0 diagnostics。未发布 v0.6.4 tag/Release。
- **计划影响：** M1-M4、S1-S2 全部 completed；C13 closed。
- **下一步：** 1.0/GitHub 公共发布准备作为独立工作范围评估。
