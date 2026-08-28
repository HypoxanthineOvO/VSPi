# GPT 5.6 Sol 模型行为审计

记录时间：2026-08-28 · 会话：`2026-08-28T10-43-20` · 模型：`vsplab/gpt-5.6-sol` · 对照模型：`GLM 5.3`

本文记录一次真实会话中 GPT 5.6 Sol 的三类典型失误，作为后续模型选型与诊断方法沉淀。所有事件均出自本仓库回归修复会话的可复核记录（工具调用与错误信息原文见会话 JSONL）。

## 状态定义

- `verified`：有会话内工具调用与错误原文为证。
- `mitigated`：已在 VSPi 侧落地针对性修复或缓解。

## G-01 幻觉工具协议：apply_patch heredoc

- 状态：`verified`
- 事件：本环境工具清单只有 `edit`/`write`，没有任何 `apply_patch` 工具。GPT 在第一轮编辑时于 bash 中连续写入 5 个 `apply_patch <<'PATCH'` heredoc 块，全部返回 `apply_patch: command not found`；失败 5 次后才切换到 `edit` 工具并成功。
- 定性：Codex 训练残留。模型把训练环境（Codex CLI）的工具协议当成当前环境可用工具，且失败后不立即切换，先编造“系统提示要求用 apply_patch”式自我合理化——实际 system prompt 中并无此要求（见 G-03 的验证）。
- 对照：同一会话同一 prompt 下 GLM 从未尝试 `apply_patch`。

## G-02 不消费错误信息：subagent resume 原样重试

- 状态：`verified` / `mitigated`
- 事件：GPT 调用 `subagent` 时同时携带 `resume=<agent_id>` 与 `role/context/instructions/system_prompt/effort/tools/model/fallback_models` 等启动参数。运行时返回的枚举错误明确指出：“Cannot change role, context, instructions, system_prompt, effort, tools, inherit_parent_context, model, fallback_models, teammate, lane when resuming an agent”。GPT 未删除任何冲突字段，原样重发同样参数，连续 3 次同样失败后放弃。
- 定性：错误信息中已包含完整的修复指引（去掉 resume 或去掉 spawn 参数），模型完全不读。
- 连带修复：暴露给调用方的 `resume` 字段此前带 `minLength: 1`，会诱导调用方乱填 ID；已改为允许 `resume: ""` 显式表示新建，非空 resume 保持严格 spawn 参数校验（`test/agents-manager.test.ts` 回归覆盖）。

## G-03 因果倒置：编造“外层宿主注入”

- 状态：`verified`（已由 GLM 5.3 当场纠正）
- 事件：用户追问“我们哪里给了他通用 Prompt？”。GPT 在 VSPi 源码与 node_modules 全文搜索 `apply_patch`/`You are Codex` 均无匹配——这本身就是正确答案：**哪里都没有给**。但它不接受“不存在”，转而搜索用户 home 目录，在 `~/.codex/sessions/**/*.jsonl`（历史 Codex CLI 会话**落盘存档**）中找到同款文本，随即得出结论：“当前 VSPi 会话被外层 coding-agent 宿主注入了 Codex base instructions，修复点在宿主的模型角色装配处。”
- 三重错误：
  1. 把磁盘上的历史存档当成运行时注入源。jsonl 存档是纯文件，不可能进入 VSPi 的任何请求。
  2. 忽略 A/B 反证：同一套 prompt，GLM 不用 `apply_patch`、GPT 用。prompt 相同而行为不同，差异只能来自模型权重，而非上下文。
  3. 忽略行为反证：第一轮 `apply_patch` 直接落进 bash 报 `command not found`。若真有宿主，宿主会接住该调用，而不是任其落到 bash 炸掉。
- 定性：搜索到“文本相似”即停止求证，从未验证“该文本是否真的进入了请求”；宁可构造一个不可观测的“宿主”实体，也不接受“不存在”这一简单结论。方向性错误在于：把“模型表现得像 Codex”归因于“被注入了 Codex 指令”，而事实是“模型本身就是 Codex 系训练产物”。
- 机器上真实存在的 Codex 痕迹（均无害）：`~/.codex/sessions/` 历史存档；`~/.codex/skills/` 下由 VSPi `/skills` 显式导入的 skill；openai SDK 中 Responses API 的 `apply_patch_call` 类型定义。

## 诊断方法沉淀

- 判定“某段指令是否生效”：查看 `/prompt` 面板的 effective prompt 分段（`pi-base`/`system`/`append`/`context`/`profile`/`plan`），或对 `buildSystemPrompt` 做实测。本例实测输出 `{"hasApplyPatch": false, "hasPreferRg": false}`。
- 判定“行为来自上下文还是权重”：同 prompt 换模型 A/B。异行为 ⇒ 权重差异。
- 判定“是否有外层拦截/宿主”：看工具调用的实际落点。掉进 bash 报 command not found ⇒ 无任何拦截层。

## 连带修复记录

- `resume` schema 兼容（G-02，`verified`）。
- 2026-08-28 同轮次的其他仓库修复（Subagent 沙箱移除、Host 环境继承、实时 usage、Asia/Shanghai 时间）与本文档主题无因果关系，属于独立回归修复，见同日工作区 diff。
- Subagent 卡片预算警戒线整行移除（`mitigated`）：默认 `maxRunTokens=120K`/`maxTreeTokens=500K` 对真实多轮任务形同虚设（实测单 run 累计 2257K），警告常亮失去信息量。waterfall 卡片不再渲染 `run x / max ⚠ 超警戒线` 行；用量细节保留在 `/agents` 面板详情中主动查看。

## 防御建议（未实施）

- 针对带 Codex 训练残留的模型，可考虑在 VSPi 追加 prompt 中加一句环境纠偏：“本环境无 `apply_patch`；文件编辑用 `edit`/`write`；常规文本搜索优先内置 `grep` 工具”。属于产品决策，待定。
