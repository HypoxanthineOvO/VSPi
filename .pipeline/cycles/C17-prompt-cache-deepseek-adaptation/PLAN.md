---
kind: plan
cycle: C17-prompt-cache-deepseek-adaptation
mode: plan
status: completed
updated: 2026-08-17T23:51:00+08:00
progress: PROGRESS.md
execution: EXECUTION.md
---

# 前缀缓存与 DeepSeek Harness 适配

## 目的

优化 VSPi 的 prompt prefix cache（提示词前缀缓存）命中率，使正常会话中的上下文尽量只追加；把 Pi 已提供的缓存 token 和费用数据纳入正式产品展示；完整移植 `Averyyy/pi-dsh-minimal` 的 DeepSeek anchored-standard 两阶段 request surface，并用真实请求和 A/B 证据决定默认启用策略。

## 已确认要求

- Cache Hit Rate 是计费相关的正式产品指标，必须展示最近请求与 Session 累计命中率，并解释 cached、uncached、cache write、output 与总费用。
- 状态栏在 `Context` 左侧增加固定宽度 `Speed` 轨道：生成中实时显示最近 2 秒滚动输出吞吐 `now`，并显示 Session 已完成输出的加权平均 `avg`；空闲时 `now` 为 `—`、`avg` 保留，窄终端优先保留 `now`。
- compaction 成功后 Context 数字不得消失：立即用 Pi `compaction_end.result.estimatedTokensAfter` 显示带 `~` 的新 epoch 估算值，下一次可信 usage 到达后替换为精确值；压缩失败或取消时保留压缩前 Context。
- assistant 正式输出与中间输出采用轻量视觉分层：后续仍有 tool call 的过程文本使用 muted gray `·`；以普通 `stop` 结束的完整文本前显示一条无文字横线，首行使用亮色 `✦ `（符号后固定一个空格）。不显示 `Final result` 文案，不使用完整边框、正文背景或任务级 final 推断。
- S1 必须交付详细 Before/After 缓存收益模拟报告，分别覆盖短、中、长上下文，并量化命中率提升、重复计费 token 和人民币费用节省；不能只做 UI 检查。
- DeepSeek 主计费矩阵使用官方人民币 price schedules：V4 Flash/Pro 旧版单一价，以及 2026-08-17 起新版空闲/高峰价；OpenCode Go 的美元 catalog 价格只作为中转 catalog 漂移附录，不混入官方价。
- 横向模型矩阵另含 GLM 5.2、Kimi K3、GPT-5.6 Sol 与 GPT-5.6 Luna。报告统一以人民币为展示币种：优先使用实际计费 Provider 的人民币价；仅有外币来源时保留原始价格、汇率来源/时点和换算值。
- S1 与 `/usage` 的 USD→CNY 估算按用户确认的 `1 USD = ¥6.80`；VSPi 当前固定 `7.18` 已过期，M1 需同步修正，并把人民币值标为估算、显示使用汇率。
- GPT-5.6 Sol/Luna 使用 `vsplab`，其模型成本/tier/context 元数据从 Pi `openai-codex` 继承，当前 context 上限为 272K；M1 必须核对该元数据与 VSPLab 实际人民币账单口径，不能把 Pi 的 USD catalog 当作人民币价。
- Kimi K3 使用官方人民币价 `2.00/20.00/100.00`（缓存命中/未命中/输出，元/百万 tokens）；GLM 5.2 官方文档确认自动缓存但未公开可核验人民币单价，费用主表标 `providerBilledCny: unknown`，可另列 OpenCode Go catalog × 6.80 的估算。
- Pi `0.84.2` 的口径保持不变：`promptTokens = input + cacheRead + cacheWrite`，`cacheHitRate = cacheRead / promptTokens`，`uncachedTokens = input + cacheWrite`。
- 动态 Plan、Workflow、Goal、Review 状态不再每轮注入 system prompt；稳定提示词只要求模型在相关工作开始、继续和完成前自行查询，查询结果作为 tool result 追加到历史。
- DeepSeek 采用完整 anchored-standard：首个普通 provider request 使用官方 one-line persona 与精确 `bash` + `str_replace_editor` schema，promotion 后恢复 VSPi/Pi 完整工具和上下文，compaction 后进入新 bootstrap epoch。
- 默认匹配 DeepSeek V4 Pro 与 V4 Flash，包括 VSPi 可见的直接 DeepSeek 与中转 Provider 模型；其他模型不得受影响。

## 技术边界

- 稳定前缀包含 Pi base、VSPi language contract、当前模型 profile 和稳定工具目录；模型、profile、resource、工具集合、compaction 变化是显式 cache epoch 边界。
- Local Plan / Goal / Hypo-Workflow 的查询入口必须能在不知道内部 ID 的情况下读取当前绑定状态；具体采用独立 status tools 还是一个聚合只读入口，由 M2 以最小 API 面决定。
- DeepSeek bootstrap 到 promoted 会有一次有意的 system/tools cache reset；该例外必须限定在匹配模型和当前 epoch，promotion 后继续保持稳定。
- 模拟必须把“由 request prefix 推导的可缓存 token”与 Provider 实际回报的 `cacheRead` 分栏；前者是确定性 counterfactual，后者才是实测命中，二者不能混报。
- 每个 price schedule 必须记录 provider、model、币种、每百万 token 单价、来源、来源版本/公告与生效时间；报告主表统一为人民币。历史 Session 使用已记录费用，不因 catalog 更新而追溯改价，模拟报告可以对同一 trace 显式重放多份价目。
- S1 的固定 workload 为每档 6 个普通 turn，并在第 3 turn 制造一次动态 Plan/Workflow 状态变化、第 5 turn 触发 review 边界：短上下文约 4K、中上下文约 32K、长上下文约 256K；1M context 模型另加约 512K 超长档。无法容纳该档的模型标为不适用，不截断伪造结果。
- `Speed now` 基于 text/thinking delta 的增量 token 估算与最近 2 秒单调时钟窗口；`Speed avg` 用完成响应的最终 output usage 校正，分母只含首个到最后一个内容 delta 的模型输出时间，排除 TTFT、工具执行、approval 与排队等待。
- compaction 后估算 Context 必须携带来源/估算标志，不能伪装成 Provider 精确 usage；model switch、resume、新 Session 和下一次可信 usage 必须正确清理或替换该估算。
- 正式输出分类使用模型消息的协议 stop reason/tool-call 结构，而不是正文关键词或整个 Goal 是否完成：tool-use/后续工具路径为 intermediate，普通 `stop` 为正式输出，error/aborted 保持现有 warning/error 语义且不显示星标。
- 横线和标记只存在于 TUI 渲染层，不写入模型消息或 Session 正文；Markdown 先正常渲染再添加左侧标记，Unicode 不可用时降级为 `-` 横线与 `* `，窄终端不得换行或改变内容语义。
- `bash` 与 `str_replace_editor` 的执行必须经过 VSPi 现有 Policy、Approval、workspace containment 和单写者边界，不能只改 wire schema 而绕过宿主执行安全。
- 复制的官方 prompt、tool descriptions、schema 和结果字符串保留 MIT 版权与 NOTICE 来源。
- 不把上游 README 的 DeepSWE 数字当作 VSPi 已验证结论；默认启用只依据本 Cycle 的可复现实验和用户 Stone 决定。

## 计划

| ID | 阶段 | 期望结果 | 验证方式 |
| --- | --- | --- | --- |
| `M1` | Cache accounting、输出层级、实时吞吐、Context 恢复、价格来源与优化前基线 | `UsageSnapshot` 保留 `cacheRead`/`cacheWrite` 与 Context 来源；assistant intermediate 使用灰色 `·`，普通 stop 输出使用无文字横线与亮色 `✦ `；状态栏在 Context 左侧显示 `Speed now/avg` 和最近 `CH`；compaction 后立即显示 `~estimatedTokensAfter` 并在可信 usage 到达后校正；`/usage` 展示 Session 命中率、cached/uncached/write/output、总费用、cache miss 重复计费 token 与额外费用；不报告缓存的 Provider 显示未报告而非 0%；建立带来源/生效时间的不可变 price schedules 并检测 stale catalog；USD→CNY 估算改为 `6.80` 并显示汇率/估算标记 | stop/tool-use/error/aborted 分类测试、Markdown/历史恢复/Unicode fallback 测试、delta/单调时钟吞吐与完成 usage 校正测试、40/80/120 列状态栏和 transcript 渲染测试、manual/threshold/overflow compaction Context 恢复、resume/model switch、Usage 深比较、价格 schedule/tiers/汇率测试、优化前真实 Session 基线 |
| `M2` | 稳定 prompt、按需状态查询与收益模拟 | system prompt 只保留稳定规则；移除每轮动态 Plan/Workflow/Goal/Review capsule；模型通过无需预知 ID 的只读状态入口自行查询，结果只追加到历史；无状态变化的连续请求保持 system/tools/既有 history 完全一致；用同一 Before/After trace 生成短/中/长/超长收益矩阵 | 三轮 provider payload fingerprint/深比较；Local Plan、Goal、Workflow、review、resume、model switch 与 compaction 定向测试；模拟器 fixture 与手算交叉验证 |
| `S1` | Cache、prompt、输出层级、吞吐与模拟报告用户审阅 | 用户看到灰色 `·` 中间输出与“无文字横线 + 亮色 `✦ `”正式输出、真实状态栏中的 Speed now/avg、压缩后 `~Context` 到精确 Context 的恢复过程、`/usage`、请求 diff，以及详细 `CACHE-SIMULATION.md` | 用户核对输出层级在工具瀑布/普通 stop/error/aborted/历史恢复中的表现、实时/平均速度语义、Context 连续性、报告方法、价格证据和长短上下文收益后接受，或退回 M1/M2 指定问题 |
| `M3` | DeepSeek anchored-standard 状态机与 wire surface | 独立 DeepSeek Harness 模块完成模型匹配、inactive/bootstrap/promoted、resume/compaction epoch；首请求 persona 与双工具 schema 字节级符合固定上游版本；compaction/summary 请求不被误改 | 固定 fixture 深比较；V4 Pro/Flash、非 DeepSeek、model switch、三种 promotion signal、resume/compaction 测试 |
| `M4` | DeepSeek 工具执行与真实 A/B | persistent `bash` 和 `str_replace_editor` 接入现有 Policy/Approval；promotion 后完整 VSPi 工具、AGENTS、skills 与 profile 恢复且稳定；完成小规模 paired A/B，记录激活探针、任务正确率、首轮 reset 成本、promotion 后 Cache Hit Rate 和费用 | 工具行为/安全测试、provider payload 集成测试、真实 V4 Pro/Flash trajectory 与可复现实验报告 |
| `S2` | DeepSeek Feature 用户审阅 | 用户检查真实 V4 Pro/Flash 行为、缓存/费用变化、A/B 结果和已知局限，决定默认启用、保持 opt-in 或退回修正 | 用户明确接受默认策略或退回 M3/M4 |
| `M5` | 集成门禁与收口 | 根据 S2 决定固化默认配置与说明；相关 check、定向测试、全量测试和 package verify 通过，Cycle 产出完整总结 | `npm run check`、相关 Vitest、`npm test`、`npm pack`/package verify 与最终变更审查 |

## Stone 接受标准

### S1 Cache 与 prompt 架构

用户将看到可运行 VSPi 中的 Cache Hit Rate 与计费面板、脱敏的连续请求结构对比，以及一份可复查的 `CACHE-SIMULATION.md`。报告至少包含：

- 真实状态栏在 Context 左侧稳定显示 `Speed now/avg`；流式生成、工具调用、空闲、窄终端下含义和布局正确，不因数字长度发生位移。
- manual、threshold、overflow compaction 后 Context 立即从压缩前数字切换到带 `~` 的 `estimatedTokensAfter`，下一次可信 usage 后去掉 `~`；失败/取消不清空原数字。
- 工具前后的中间 assistant 文本以灰色 `·` 呈现；普通 stop 输出前有一条无文字横线，首行以亮色 `✦ ` 开始且符号后恰好有一个空格；不出现 `Final result` 标签、完整边框或正文背景。
- Markdown 标题、列表、代码块、表格在添加横线/标记后仍正确，40/80/120 列和 ASCII fallback 均不溢出；恢复历史 Session 后保持相同分类。
- 短（约 4K）、中（约 32K）、长（约 256K）各 6 turn；DeepSeek、GLM 与 Kimi 另含约 512K 超长档。
- 当前实现与优化实现逐 turn 的 prompt token、最长稳定前缀、Provider-reported cache read、模拟可缓存 token、uncached/cache-write/output token。
- 最近和累计 Cache Hit Rate、绝对百分点提升、重复计费 token 减少量、实际/反事实人民币成本及节省比例；外币来源只在可追溯附列中出现。
- 外币 schedule 以 `1 USD = ¥6.80` 计算 `catalogEstimateCny`，同时保留原始 USD；未取得 Provider 人民币账单价时，`providerBilledCny` 明确显示 `unknown`。
- DeepSeek Flash/Pro 旧版单一人民币价与新版空闲/高峰人民币价，GLM 5.2、Kimi K3、GPT-5.6 Sol/Luna 的显式 price schedule 与来源；GPT tiers 和模型 context limit 单独标注。
- DeepSeek 官方 schedules 固定为：旧 Flash `0.20/1.00/2.00`、旧 Pro `1.00/12.00/24.00`；新版空闲 Flash `0.05/1.50/4.50`、Pro `0.15/4.50/13.50`；新版高峰 Flash `0.10/3.00/9.00`、Pro `0.30/9.00/27.00`，依次为缓存命中/缓存未命中/输出，单位元/百万 tokens。
- 新版高峰时段为北京时间 `09:00-12:00`、`14:00-18:00`，其余为空闲时段，生效时间为 `2026-08-17 00:00 Asia/Shanghai`；模拟同时给出空闲与高峰结果。
- Kimi K3 官方 schedule 为缓存命中 `¥2.00`、未命中 `¥20.00`、输出 `¥100.00`；GLM 5.2 的 `catalogEstimateCny` 为 `¥1.768/¥9.52/¥29.92`，依次为命中/未命中/输出，但官方人民币账单价保持 unknown。
- GPT-5.6 Luna 的 Pi catalog 估算为命中/未命中/cache-write/输出 `¥0.136/¥1.36/¥1.70/¥8.16`，Sol 为 `¥3.40/¥34.00/¥42.50/¥204.00`；这些不称作 VSPLab 实际账单价。
- 实际 live spot-check 与确定性 prefix simulation 分栏，并解释 Provider 最小缓存阈值、TTL、cache-write 和 compaction epoch 对结果的影响。

接受要求：公式与 Pi 一致；最近/累计指标含义清楚；实时/平均吞吐含义明确且数值稳定；compaction 后 Context 始终有可解释数字；Provider 未报告缓存时不伪造命中率；动态状态不在 system prompt 抖动；模型查询产生的结果位于历史尾部；报告能直接回答每种模型在长短上下文中“命中率提高多少、费用少多少”。

### S2 DeepSeek Feature

用户将看到至少一条 V4 Pro 和一条 V4 Flash 的真实 anchored-standard trajectory、对应普通配置对照、首请求与 promoted 请求 surface、缓存与费用数据。接受要求：激活仅作用于匹配模型；双工具可真实执行且不绕过 Policy；promotion/compaction 行为正确；默认策略由实验结果和用户判断共同决定。
