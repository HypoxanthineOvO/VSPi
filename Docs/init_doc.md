<aside>
🎯

汇总到目前为止讨论出的全部需求，按模块分组、标注实现路线，供后续开工时直接对照。背景和动机见父页面 Pi Agent 前期调研与魔改准备。标注说明——【配置】零代码；【Ext】写 extension；【SDK】用 SDK 自建；【待讨论】方案未定。

</aside>

# A. 模型编排（核心）

- [ ]  接入 Kimi / DeepSeek / GLM 等（OpenAI 兼容端点）【配置】custom provider / custom models
- [ ]  GPT 专门走 OpenAI Responses 官方协议（非 chat completions）：内置 openai provider 复用官方 SDK；pi-ai 的模型定义里用 `api` 字段区分协议类型，自定义/代理端点接 GPT 时需把 api 配成 Responses 类型【配置 + 先验证】装好后确认默认 openai provider 的协议路径
- [ ]  按任务类型路由：默认 K3，复杂代码 GPT sub agent，总结 DeepSeek【Ext + 待讨论】路由规则格式待定
- [ ]  按项目模块路由：前端 / 主线 / 后端各自默认模型【Ext + 待讨论】
- [ ]  按成本/复杂度自动升级：日常 Flash，卡住/做不好时自动切强模型【Ext】判定信号待设计
- [ ]  Agent Teams：多模型各自 review →「老大」汇总后报告【SDK】createAgentSession 多会话编排；可先找社区 package
- [ ]  打开即用：不选模型直接说需求，预置搭配自由组合【以上全部的集成目标】

**Sub agent 现状（2026-07-21 补充调研）**：核心刻意不内置，但官方仓库提供了 subagent 示例 extension（`examples/extensions/subagent/`，同目录还有 plan-mode、permission-gate、sandbox 等示例）；社区已有成熟包：

- `@tintinweb/pi-subagents`：Claude Code 风格自主子 agent——隔离会话、各自独立模型/工具/提示词、并行执行、live widget、中途 steer、可恢复会话、自定义 agent 类型（约 40K/月下载，更新活跃）
- `nicobailon/pi-subagents`：异步子 agent 委托，带截断、artifacts、会话共享
- `pi-sub-agent`：子进程隔离上下文的 subagent tool

策略：先装社区包试用感受交互形态，Agent Teams 编排层确定要自建时再走 SDK。注意：第三方包能执行代码，装前先过一遍源码。

# B. 上下文与 Hypo-Workflow

- [ ]  显式文件机制：进度 / 任务 / 讨论细节 / 计划落盘（上下文的显式备份）【Ext + 待讨论】文件格式待定
- [ ]  自定义压缩：只留主目标 + 难点/未记录的洞察【Ext】`session_before_compact` 返回自定义摘要
- [ ]  记录执行动向 → 无感压缩：压缩后传递上几次操作动向【Ext】turn_end / tool_execution_end 写动向日志，压缩时拼入
- [ ]  Hook 督促：提醒读进度文件、督促存进度【Ext】`before_agent_start` 注入消息
- [ ]  回答前提醒把话说清楚【Ext】同上
- [ ]  长期性宏观 plan：大 plan + sub items，挂在 workflow 上，跨会话持续【Ext + 待讨论】官方有 plan-mode 示例 extension 可参考改造
- [ ]  按模型定制提示词：后训练不足的模型补工程提示词【配置 + Ext】SYSTEM.md / 按当前模型切换

# C. 界面（TUI）

- [ ]  欢迎界面：字符画（ASCII art）+ 自定义欢迎文字【Ext】`quietStartup` 关默认头，启动时自绘；自制前端则完全自由
- [ ]  斜杠命令：筛选/精简默认命令，定自己的命令集【Ext + 待讨论】registerCommand 加；input 事件可拦截
- [ ]  思维链：好看的展开/收起交互【Ext】现状只有 `hideThinkingBlock` 全局开关，逐条 toggle 需自定义渲染
- [ ]  工具调用：结果可展开查看【Ext】自定义 tool call/result 渲染
- [ ]  整体配色：好看的主题【配置】theme JSON（51 个颜色 token，热重载）；可让 pi 自己生成初版再调
- [ ]  终端交互：输入框内换行等【先验证】Editor 已支持 Shift+Enter / Alt+Enter 换行；不顺手再调 keybindings
- [ ]  显示名字等界面细节【Ext】
- [ ]  当前计划好看地展示：即「长期规划」的可视化——计划本身有内容含义（目标/背景/难点），不是纯任务清单【Ext】官方支持 status bar / overlay / 自定义 widget，可渲染 workflow 里的 plan 文件；与 B 区「长期性宏观 plan」配套
- [ ]  Settings 命令配置界面：设计自己的设置交互【Ext + 待讨论】
- [ ]  exit / quit 等命令别名【Ext】registerCommand，成本极低
- [ ]  粘贴文件路径的渲染：粘贴路径时高亮显示【Ext】
- [ ]  插件（extension）命令的显示：来源/分组清晰【Ext】
- [ ]  （远期）自制 TUI 前端：用 pi-tui 组件自己拼界面，RPC/SDK 驱动 pi 内核【SDK】参考 `test/chat-simple.ts`

# D. 交互工具

- [ ]  Question Tools：单选 / 多选 / 排序 / 填空【Ext】registerTool + ctx.ui（select/confirm/input）；自制前端用 SelectList + Editor
- [ ]  密码输入自动打码【Ext】
- [ ]  密码不落上下文：Agent 只传密码 ID，执行侧注入明文【Ext + SDK + 待讨论】需自建 secret 存储
- [ ]  思维链自动翻译成中文【Ext】订阅 thinking 流事件接翻译服务；翻译服务选型待定
- [ ]  Sub Agent 会话可进入查看【SDK】依赖 Agent Teams 的会话管理设计

# E. Web 端

- [ ]  服务端：RPC / SDK 包一层 HTTP/WebSocket 服务【SDK】
- [ ]  前端：pi-web-ui（ChatPanel）拼页面，服务器/手机可连【SDK】
- [ ]  访问方式与鉴权（内网 / frp / 密码）【待讨论】

# F. 配置体系

- [ ]  官方 settings 基线：全局 `~/.pi/agent/settings.json` + 项目 `.pi/settings.json`（项目覆盖全局）【配置】
- [ ]  自有配置格式：路由规则、workflow 路径等，由 extension 加载解析【Ext + 待讨论】格式与字段待设计
- [ ]  打包成 pi package：多台服务器（Nod / Genesis / Eden）一键同步【配置】

---

# 起步顺序（2026-07-21 已定）

<aside>
✅

判断：原生版本偏浅，不长期原生使用，一开始就直接定制。

</aside>

1. **第一步 · 纯配置（简单，直接做）**：provider 接入（Kimi / DeepSeek / GLM + 确认 GPT 走 Responses 协议）、主题配色、AGENTS.md / SYSTEM.md、settings 调参。
2. **第二步 · 二选一（待定）**：
    - 路线 A：先做「前端」——自制 TUI 界面（欢迎界面、计划展示、思维链折叠、工具结果展开、路径高亮）。
    - 路线 B：先接第一批 extension——督促 hook、无感压缩、Question Tools、命令别名。
3. **最晚 · Agent Teams / Sub agent**：先试官方 subagent 示例和社区包（@tintinweb/pi-subagents 等）感受形态，确定要自建时再走 SDK 编排。

<aside>
💡

【待讨论】汇总：路由规则格式、workflow 文件格式、斜杠命令集、Settings 界面设计、自有配置字段、secret 存储方案、翻译服务选型、Web 鉴权方式、第二步选路线 A（前端）还是路线 B（extension）。

</aside>