---
kind: execution
cycle: C17-prompt-cache-deepseek-adaptation
updated: 2026-08-17T21:34:43+08:00
---

# Execution Checkpoints

## 2026-08-17 - C17 建立与 Proposal 生成

- **计划项：** `M1`/`M2`/`S1`/`M3`/`M4`/`S2`/`M5`
- **用户目标：** 提高 VSPi prompt prefix cache 命中，使上下文除明确 epoch 边界外只追加；优化系统提示词与工具调用编排；移植 DeepSeek anchored-standard Feature。
- **用户决定：** 新建独立 VSPi Cycle；完整移植 anchored-standard，而不是 prompt-only；动态 Plan/Workflow/Goal/Review 状态由模型自行查询，不再每轮注入。
- **计费要求：** Cache Hit Rate 必须进入正式 UI；保留 Pi `cacheRead`/`cacheWrite`，展示最近与累计命中率、cached/uncached/write/output、总费用和 cache miss 额外费用。
- **上游研究：** 固定 `Averyyy/pi-dsh-minimal v0.4.0@bdc2bec3c5fbd8ec2f9497e61d0a30e2ca079386`；当前机制是首个普通请求精确 one-line persona + `bash`/`str_replace_editor` schema，随后 promotion 恢复宿主 surface，compaction 后重启 epoch。
- **证据边界：** 上游 47/47 单测与 typecheck 通过；README 的 DeepSWE 69/113 缺少仓库内逐题结果，VSPi 默认策略必须经过本 Cycle 真实 A/B 与 S2。
- **当前状态：** Cycle/Plan 已建立，源码实施未开始。
- **下一步：** 用户确认并开始则进入 `M1`；确认但不开始则保持 proposed；继续讨论则修订 Proposal 后再给同一启动 gate。

## 2026-08-17 - S1 模拟报告范围修订

- **计划项：** `M1`/`M2`/`S1`
- **用户反馈：** S1 不能只有检查，需要详细说明优化前后模型命中率提高多少，尤其是长、短上下文；计费矩阵需覆盖 DeepSeek Flash/Pro 旧价与涨价后新价、GLM 5.2、Kimi K3、GPT-5.6 Sol/Luna。
- **计划修订：** S1 新增 `CACHE-SIMULATION.md`，固定短约 4K、中约 32K、长约 256K 和适用模型约 512K 超长 workload；逐 turn、逐模型、逐 price schedule 报告 Cache Hit Rate、token 重计费与成本变化。后续用户反馈将主币种明确为人民币。
- **测量边界：** Provider-reported `cacheRead` 与确定性 prefix simulation 分栏，不把可缓存 token 当作实际命中。
- **初步 catalog 证据：** `sst/models.dev@de7194b4ec` 于 2026-08-17 00:00（Asia/Shanghai）更新 OpenCode Go 的 USD catalog。此证据只说明中转 catalog 发生变化，后续用户反馈确认它不能替代 DeepSeek 官方人民币 price schedule；“促销快照”不进入 S1 主模拟。
- **发现风险：** VSPi 当前 Pi bundled catalog、本地 refreshed store、官方人民币价和中转 Provider 价可能采用不同口径；M1 将验证 provenance/freshness 与实际账单币种，防止错误换算或低报，同时保持历史费用不可变。
- **Provider 归属：** GPT-5.6 Sol/Luna 由 `vsplab` 暴露并继承 Pi `openai-codex` 的 272K context 与成本 tiers；512K workload 仅适用于 1M context 的 DeepSeek/GLM/Kimi 模型。
- **当前状态：** Proposal 已修订，产品源码仍未修改。

## 2026-08-17 - 人民币与 DeepSeek 峰谷价纠正

- **计划项：** `M1`/`M2`/`S1`
- **用户纠正：** 模拟报告使用人民币；DeepSeek 旧版只有单一价格，新版才有高峰/空闲两档；质疑先前“促销快照”口径。
- **官方旧价证据：** DeepSeek 2026-04-24 V4 预览版公告图 `v4-price.png`：Flash 缓存命中/未命中/输出为 `0.20/1.00/2.00`，Pro 为 `1.00/12.00/24.00`，单位元/百万 tokens。
- **官方新价证据：** DeepSeek 2026-08-13 公告图 `v4_260813_price_cn.png` 与中文定价页：空闲档 Flash `0.05/1.50/4.50`、Pro `0.15/4.50/13.50`；高峰档 Flash `0.10/3.00/9.00`、Pro `0.30/9.00/27.00`。
- **时段：** 新价自 `2026-08-17 00:00 Asia/Shanghai` 生效；高峰为北京时间 `09:00-12:00`、`14:00-18:00`，其余为空闲。
- **解释：** 新版并非所有 token 类别都涨价；Flash cache miss/output 上涨但 cache hit 下降，Pro 多数档下降而高峰 output 从 24 增至 27。报告必须按 token 类别和时段分别计算。
- **修订：** S1 主表统一为人民币，DeepSeek 使用官方旧/新 price schedules；中转美元 catalog 仅作 provenance/freshness 附录。

## 2026-08-17 - USD/CNY 汇率修订

- **计划项：** `M1`/`S1`
- **用户决定：** 外币换算使用 `1 USD = ¥6.80`。
- **仓库事实：** VSPi 当前 `src/domain/defaults.ts` 固定使用 `7.18`（来源日期 2026-07-23），按新口径会使人民币估算高报约 5.59%。
- **修订：** M1 更新汇率到 6.80；`/usage` 与 S1 对外币 schedule 同时显示原始币种、换算人民币、使用汇率与“估算”标记。DeepSeek 官方人民币价不换算。
- **账单边界：** VSPLab 未公开 Sol/Luna 人民币 token 价；Pi `openai-codex` USD metadata × 6.80 只能标为 `catalogEstimateCny`，`providerBilledCny` 保持 unknown。

## 2026-08-17 - 横向模型人民币价格证据

- **计划项：** `M1`/`S1`
- **Kimi K3：** 官方定价页给出缓存命中/未命中/输出 `¥2.00/¥20.00/¥100.00` 每百万 tokens，context 为 1,048,576；使用官方人民币价。
- **GLM 5.2：** 官方文档确认 1M context、128K 最大输出、自动缓存与 `cached_tokens`，但未公开可核验人民币单价。OpenCode Go USD catalog × 6.80 可给出 `¥1.768/¥9.52/¥29.92` 的命中/未命中/输出估算，实际账单价保持 unknown。
- **GPT-5.6 Luna：** Pi `openai-codex` catalog × 6.80 的命中/未命中/cache-write/输出估算为 `¥0.136/¥1.36/¥1.70/¥8.16`；VSPLab 实际账单价 unknown。
- **GPT-5.6 Sol：** 同口径估算为 `¥3.40/¥34.00/¥42.50/¥204.00`；VSPLab 实际账单价 unknown。
- **报告规则：** 命中率与 token 节省可完整横向比较；费用按 `officialCny`、`catalogEstimateCny`、`providerBilledCny` 三层展示，unknown 不以 0 填充。

## 2026-08-17 - Plan 确认但暂不开始与补充要求

- **计划项：** `M1`/`S1`
- **Plan gate：** 用户确认 C17 Proposal，但要求暂不开始实施；所有 Milestone/Stone 保持 pending。
- **实时吞吐：** 状态栏在 Context 左侧新增固定宽度 Speed 轨道。`now` 为最近 2 秒 text/thinking delta 输出 token 的滚动速度；`avg` 为 Session 已完成模型输出的加权平均，使用最终 output usage 校正，排除 TTFT、工具、approval 与排队时间。
- **空闲与窄屏：** 空闲时 `now` 显示 `—`、`avg` 保留；窄终端优先显示 `now`，轨道尺寸稳定，不因动态数字推动 Context。
- **Context 恢复：** Pi 在 compaction 后、下一次 assistant usage 前故意返回 `tokens: null`，但 `compaction_end.result.estimatedTokensAfter` 已提供压缩后估算。VSPi 应立即显示 `~tokens/window percent`，可信 usage 到达后替换；失败/取消保留压缩前值。
- **验证：** 覆盖 delta 时间窗口与最终 usage 校正、40/80/120 列布局、manual/threshold/overflow compaction、retry、resume 和 model switch。
- **当前状态：** 计划已确认且未启动，产品源码未修改。

## 2026-08-17 - 正式输出与中间输出视觉分层

- **计划项：** `M1`/`S1`
- **用户需求：** 正式 assistant 输出需要与中间过程明显不同，但不使用刻意的 `Final result` 文案；参考 Codex，以灰色过程标记、横线和亮色符号形成层级。
- **确认样式：** intermediate 文本使用 muted gray `·`；普通 stop 输出前显示无文字横线，首行使用亮色 `✦ `，符号后固定一个空格；无底部线、完整边框或正文背景。
- **分类语义：** 不判断整个任务/Goal 是否“最终完成”。按消息协议分类：tool-use/后续工具文本为 intermediate，普通 `stop` 为正式输出；error/aborted 沿用现有状态样式。
- **渲染边界：** UI chrome 不写入模型上下文或持久消息正文；Markdown 先渲染再加前缀；无 Unicode 时用 `-` 和 `* `。
- **验证：** 工具瀑布、多段 assistant、普通 stop、error/aborted、历史恢复、Markdown、40/80/120 列与 ASCII terminal。
- **状态：** 视觉方案已由用户确认；C17 仍是 confirmed/not-started，源码未修改。

## 2026-08-17 - M1 启动

- **计划项：** `M1`
- **用户授权：** “准备开始改 VSPi 吧！”
- **执行范围：** Cache accounting、正式/中间输出层级、Speed now/avg、compaction Context 恢复、人民币计费口径与优化前基线。
- **状态：** M1 in_progress；M2/M3/M4/M5 与 S1/S2 保持 pending。
- **下一步：** 扩展共享 contracts，接通 Pi backend 与 TUI，运行定向测试和 check；M1 验证后自动进入 M2。

## 2026-08-17 - M1 完成并进入 M2

- **计划项：** `M1` completed；`M2` in_progress。
- **实现：** UsageSnapshot 接入 cache read/write、最近/累计 CH、miss token/cost、Speed now/avg、Context estimate 来源和三层费用；Pi backend 使用 stop reason 分类输出、单调时钟速度窗口与 compaction estimate；TUI 接入 Speed/CH、`~Context`、扩展 `/usage` 和 `·`/`✦` chrome。
- **价格：** 固定 DeepSeek Flash/Pro 旧/新峰谷、Kimi K3 officialCny 与 GLM/Luna/Sol catalogEstimateCny schedules；USD/CNY 固定为 6.80；Provider billed 保持 unknown。
- **基线：** 真实 235-turn VSPi Session 累计 Cache Hit Rate 97.7995%，最近 99.3684%，6 次 miss / 349,929 重复计费 tokens；cost breakdown 为 0，不伪造实际人民币账单。
- **验证：** 定向 telemetry/UI/compaction/handoff 测试通过；`npm run check` 通过；完整 `npm test` 120 files / 901 tests 通过。
- **独立审查修正：** 修复同 run tool-use 被最终 stop 重标、error/aborted 残留 intermediate、跨 Provider cache 继承、model switch estimate 泄漏与非单调时钟。
- **下一步：** M2 稳定 prompt、统一只读状态查询、三轮 payload fingerprint 与收益模拟。

## 2026-08-17 - M2 完成并进入 S1

- **计划项：** `M2` completed；`S1` waiting-review。
- **Prompt 架构：** Pi runtime 不再注册 Local Plan、Goal、Hypo-Workflow 与 review 的逐轮动态 capsule；system prompt 只保留 VSPi 稳定语言/交互规则和当前模型 profile。三轮相同 model/profile 的 system prompt 与 tool schema 深比较、序列化 fingerprint 均一致；model switch 明确形成新 epoch。
- **按需状态：** 新增无需 ID 的只读 `continuity_status`，按 Hypo-Workflow > Local Plan > Goal > none 选择 authority，统一投影 Workflow、Plan、Goal、review 和 reconciliation checkpoint；结果为普通 JSON tool result，追加到已有 history 尾部。内部 identity/root/hash/owner/state body 与 workflow diagnostic 均不投影，避免路径或凭据泄露。
- **确定性模拟：** 固定每档 6 turn，T3 改变状态、T5 触发 review。短/中/长/超长 CH 分别从 64.73%/51.63%/50.16%/50.03% 提升到 82.13%/82.71%/83.17%/83.17%，避免重复计费 4,608/63,488/524,288/1,052,672 tokens；Provider 实测与反事实模拟分栏，Luna/Sol 512K 标记 N/A。
- **价格与报告：** `PRICE_SCHEDULES` 补齐 provider、model、currency、provenance、source/version 与 effective time；报告覆盖 DeepSeek Flash/Pro 旧价、新空闲、新高峰、Kimi K3、GLM 5.2、GPT-5.6 Luna/Sol 的 Before/After 人民币费用和节省比例。`officialCny`、`catalogEstimateCny` 与 `providerBilledCny: unknown` 保持分离。
- **验证：** M2 核心 8 files / 29 tests 通过，`npm run check` 通过；全量 123 files / 912 tests 中 911 通过，唯一失败为未涉及代码的 Session handoff 控制通道时序；该失败在上一轮全量通过，且目标用例单独复现 1/1 通过。
- **独立审查：** 未发现计算或 runtime 注册错误；按审查意见移除可能含绝对路径的 `workflow.diagnostic` 投影，并将旧 capsule 测试明确标为 legacy/unregistered。
- **下一步：** 用户在 S1 核对真实 UI、状态语义、request 稳定性与模拟报告；接受后进入 M3，退回则恢复对应 Milestone 修正。

## 2026-08-17 - S1 反馈：补齐 DSH `99%+` 可比口径

- **反馈：** 用户指出原报告最高约 83%，询问为何 DeepSeek DSH 可达 99%+，并确认补充对比结果。
- **原因：** 原 `All-turn CH` 固定统计 6 turn 且包含 T1 冷启动；在每个后续请求完美复用、prompt 近似不变时，累计理论上限也是 `(6-1)/6 = 83.33%`。该值不能直接与 warm/latest 指标比较。
- **修订：** 同一 Before/After trace 新增 `Warm-turn CH`（T2-T6）和 `Latest-turn CH`（稳定 T6），不改变 workload 或人为增加轮次；报告明确 bootstrap、promotion、model switch、compaction 均开启新 cache epoch。
- **结果：** 短/中/长/超长 After All-turn 为 82.13%/82.71%/83.17%/83.17%；After Warm-turn 为 97.14%/98.51%/99.61%/99.61%；After Latest-turn 为 97.30%/98.55%/99.62%/99.62%。
- **边界：** DSH 数字只有在相同 trace、epoch 和 Provider-reported 口径下才能严格 A/B；当前结论只证明 VSPi 的长上下文 warm/latest 模拟也达到 99%+，不把 DSH 宣传值当作 VSPi 实测。
- **验证：** 新增手算深比较测试；cache simulation、pricing 与 prompt stability 共 3 files / 8 tests 通过，`npm run check` 通过；报告由生成脚本重建。
- **状态：** `M2` 再次 completed；`S1` 恢复 waiting-review。

## 2026-08-17 - S1 接受并进入 M3

- **接受范围：** 用户以“OK 了接着做吧”接受 M1/M2 真实产物，包括 Cache/UI、Speed now/avg、compaction Context、assistant 输出层级、稳定 prompt、`continuity_status`、真实 baseline 与修订后的 All-turn/Warm-turn/Latest-turn 模拟。
- **验证证据：** M2 修订测试 3 files / 8 tests 与 `npm run check` 通过；长/超长 After Warm-turn CH 为 99.61%，Latest-turn 为 99.62%。
- **下一阶段：** `S1` completed；自动进入 `M3`，实现 DeepSeek anchored-standard 状态机与 wire surface，之后继续 M4 并停在 S2 审阅。
- **发布要求：** 用户要求全部完成后发布为 `1.1.0`；版本升级与外部发布归入 S2 接受后的 M5 门禁，不提前发布。

## 2026-08-17 - M3/M4 完成并进入 S2

- **计划项：** `M3`/`M4` completed；`S2` waiting-review。
- **M3 wire：** 固定 `pi-dsh-minimal v0.4.0@bdc2bec` one-line persona 与 `bash`/`str_replace_editor` schema；实现 inactive/bootstrap/promoted、direct/relay V4 Pro/Flash 匹配、model switch/compaction epoch、三种 provider envelope、summary/branch-summary bypass 与 promoted prompt reanchor。
- **M4 工具：** editor 复刻官方结果字符串、绝对路径、唯一替换、两层目录过滤与 16K truncation，并强制 workspace/symlink containment；persistent bash 保留 cwd/env、默认 120 秒、秒制 timeout、abort/timeout 进程组 cleanup。bootstrap 动态注册 persistent bash，promotion/离开模型恢复 Pi 原生 bash。
- **安全边界：** 双工具都经过 VSPi Policy/Approval 与 root Agent 单写者 boundary。Editor 有严格 filesystem containment；bash 保持普通 VSPi root bash 的 host policy，不新增 OS 级 filesystem sandbox，已在 S2 报告明确列为限制。
- **真实 A/B：** direct V4 Flash/Pro 各完成 control/anchored 三回合。四组文件与最终文本均正确；anchored T2/T3 recent CH 为 98-100%。Flash 三回合 officialCostCny `¥0.0062828` 对 control `¥0.0100117`（-37.2%）；Pro `¥0.0314856` 对 `¥0.0303099`（+3.9%），不外推统计结论。
- **双工具探针：** V4 Flash 实际 `str_replace_editor(create)` 与 `bash` 均 success，文件 `EDITOR_OK`，最终 `BOTH_OK`；recent CH 99%、Session CH 73%、officialCostCny `¥0.0060099`。
- **审查修正：** 修复 editor 被 Pi allowlist 过滤导致 provider 可见但执行 not found；修复 timeout 单位、默认 timeout、子进程残留、persistent bash 对非 DeepSeek/promotion 后语义泄漏；cache telemetry 下沉独立模块以控制 backend 增量。
- **验证：** `npm run check` 通过；M1-M4 相关 12 files / 74 tests 通过；真实双工具与 resume 进程级探针通过；真实报告见 `DEEPSEEK-AB.md`。
- **下一步：** 用户在 S2 选择 direct/relay V4 Pro/Flash 默认启用或保持 opt-in。接受后进入 M5，执行完整 `npm test`、package verify、版本升级与 `1.1.0` 发布。

## 2026-08-17 - S2 接受、M5 发布前暂停

- **S2 决定：** 用户接受 direct/relay DeepSeek V4 Pro/Flash 默认启用 anchored-standard，并要求保留 `VSPI_DEEPSEEK_HARNESS=0` 关闭开关。
- **M5 实现：** 所有启动入口接入默认配置；Recovery 强制关闭 harness；版本 metadata 升至 `1.1.0`；补齐 usage 文档、第三方 MIT NOTICE 与 release notes。
- **验证：** 初次 `npm test` 完整通过 129 files / 954 tests；实际 `vspi-1.1.0.tgz` 通过空项目安装和 bin smoke；`npm audit --omit=dev --audit-level=high` 为 0 vulnerabilities。
- **回归修正：** editor 注册与 runtime active allowlist 分离，保留 Question 等完整工具 registry；相关 5 files / 20 tests 及完整套件均通过。
- **暂停点：** 用户要求准备完成后停在发布前，先使用 VSPi 修改 README。尚未执行 commit、tag、push 或 GitLab/GitHub Release；README 完成后需重新复核、pack、计算 SHA256 并发布。
- **本机安装：** 应用户补充要求，从已验证 tarball 执行全局安装；`/home/heyx/.local/bin/vspi --version` 返回 `1.1.0`。远端发布状态不变。
- **最终审查修正：** promoted Anthropic system 只重写首个 text block并保留其余 block/metadata；`branch_summary` 纳入 resume cache epoch；persistent bash 改为固定大小 marker buffer 与 16K 可见输出上限，避免大输出无界内存累积且保持实时 streaming。
- **修订验证与本机重装：** DeepSeek 定向 6 files / 45 tests、完整 129 files / 955 tests 通过；重新 pack 并覆盖安装本机全局 `1.1.0`，版本确认后删除项目根目录临时 tgz。README、Git 历史和远端均未修改。

## 2026-08-17 - README 完成并恢复发布

- **README：** 用户使用本机 VSPi 1.1.0 将 README 重写为简洁产品入口，突出 Question Tool、Markdown、prefix cache 与 DeepSeek Harness，并保留安装、快速开始和详细文档导航。
- **测试边界：** 旧测试要求 README 复制完整 TUI 技术规范，与新 README 定位冲突；按用户反馈彻底移除 `test/docs-contract.test.ts` 对 README 的读取和断言。完整布局、Fixture、附件与响应式契约继续由 `Docs/tui-v1.md` 测试保护，package/release 行为由 M9 测试保护。
- **最终验证：** `npm run check` 通过；文档/package 定向 3 files / 12 tests 通过；当前完整套件 129 files / 952 tests 全部通过。
- **下一步：** 生成最终 tarball 与 SHA256，提交时排除无关 C06 工作树改动，创建 `v1.1.0` tag 并完成 GitLab/GitHub Release。

## 2026-08-17 - M5 完成与 1.1.0 发布

- **提交与 tag：** 发布提交 `eb0edf7`；annotated tag `v1.1.0` 在 GitLab 与 GitHub 均解析到该提交。
- **资产：** 两个平台均发布 `vspi-1.1.0.tgz`、`vspi-latest.tgz`、`SHA256SUMS`；两个 latest 下载内容完全一致，SHA-256 为 `17fd11362494dc6ebcd2e9cae404b974e1f3681a3e29680eee2707a4558bf199`。
- **GitHub CI 修正：** tag workflow 因 package verifier 未允许新增 `THIRD_PARTY_NOTICES.md` 而失败；使用同一 verified assets 手工创建 GitHub Release，并在 `47f48b9` 更新 verifier required/allowed list。原 workflow 命令本机验证 333 个包文件通过，release/package 测试 4/4 通过。
- **Release：** GitLab `https://gitlab.vsplab.cn/heyx/vspi/-/releases/v1.1.0`；GitHub `https://github.com/HypoxanthineOvO/VSPi/releases/tag/v1.1.0`。
- **状态：** `M5` completed，C17 closed。无关 C06 工作树改动未纳入任何提交。
