# VSPi TUI v1 设计规范

## 设计边界

VSPi v1 是工作型终端界面，不使用营销页、装饰卡片或多层模态框。主会话保留终端原生 scrollback；Plan、临时工作区、composer 与状态行始终位于输出末端。应用不改变终端字体，只使用 ANSI 前景色、背景色和文本属性。

最低布局为 `80×24`。低于 80 列仍保持所有行宽安全，但只作为紧急降级，不作为完整验收面。终端能力分为：

1. truecolor + Unicode：完整色值、圆角框、分级符号、终端图片。
2. 256 色 + Unicode：近似色、圆角框、分级符号、图片按终端协议检测。
3. ASCII/无色：`+-|` 框线、`* o >` 层级符号、文本图片说明。

## 色彩

```text
背景            #111315
正文            #E8EAED
弱文本          #92989F
焦点青          #5FC7C7
数据蓝          #8FB7FF
成功绿          #7CCB8A
警告琥珀        #E4B860
错误珊瑚        #F07878
Plan 背景       #182529
选择背景        #2B3E41
代码背景        #202428
用户消息背景    #202428
用户消息正文    #F4F7FA
```

颜色从不单独承担状态：成功、当前、未开始和错误同时使用 `✓ / ● / ○ / ×`。

## 启动封面

封面使用多行圆角框、`◈` 品牌符号和现有六行块字符 Logo。初始化期间只显示一行品牌占位，不含 Logo、运行状态或模型声明；应用初始化完成后清除该行并一次性提交最终状态帧，不播放中间动画，也不使用无法跨越 scrollback 的多行光标回退。占位行与最终帧都预留终端最右一列，避免 right-margin autowrap 造成额外物理行；reduced-motion、CI 与 dumb terminal 使用同一初始化屏障。

最终帧等待应用初始化完成，使用初始化后解析得到的真实 Model，并显示从 `package.json` 读取的包版本、Backend 与独立的执行 Policy。真实后端显示 `Backend Pi`，显式离线后端显示 `Backend Fixture`；Policy 统一表达为 `Policy … · Host`，仅表示审批等级和宿主执行。启动、`/new` 和 alias `/clear` 都必须先把完整最终帧提交并写入终端 `scrollback`，之后才启动新的动态 TUI；后续刷新和差分渲染只拥有其下方的动态区域，不会擦除、清空或覆盖这个最终帧。

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ ◈ VSPi                                                                       │
│                                                                              │
│   ██╗   ██╗███████╗██████╗ ██╗                                               │
│   ██║   ██║██╔════╝██╔══██╗██║                                               │
│   ██║   ██║███████╗██████╔╝██║                                               │
│   ╚██╗ ██╔╝╚════██║██╔═══╝ ██║                                               │
│    ╚████╔╝ ███████║██║     ██║                                               │
│     ╚═══╝  ╚══════╝╚═╝     ╚═╝                                               │
│                                                                              │
│ Model  OpenAI / GPT-5.4                                                      │
│ Backend Pi                                                                   │
│ Policy Standard · Host                                                v0.3.10│
╰──────────────────────────────────────────────────────────────────────────────╯
```

## 主界面

```text
╭ Plan ────────────────────────────────────────────────────────────────────────╮
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Shift+Tab 下一个区域
╭──────────────────────────────────────────────────────────────────────────────╮
│ 输入内容                                                                     │
╰──────────────────────────────────────────────────────────────────────────────╯
Model OpenAI / GPT-5.4  Effort High                     Context 50K / 128K 39%  
/workspace/vspi · Policy Standard · Host            Token ↑12k ↓3.0k  Cost ¥1.01
```

80 列普通 Status 区固定为两行：第一行语义固定为 `Model / Effort / Context`；第二行直接从路径值开始，再显示 `Policy / Token / Cost`，不显示 `Path` 标题。Backend 不进入动态行，只存在于永久 Splash 和诊断信息。五个字段标签与字段值、以及无标题路径值分别着色；80/120 列的路径 flex 区从右侧保留完整 Policy/Boundary suffix，只有 Model 与路径变量值可截断。默认的新会话动态界面为空，不加载或预置对话、工具消息；空 Plan 只保留标题与留白，不显示 Workflow 缺失或初始化提示。`Shift+Tab` 在 Composer、Transcript、Plan 间循环，Transcript 为空时直接跳到 Plan。后文出现的消息、工具与 active telemetry 均为“交互示例”，不是启动内容。显式离线入口 `VSPi_FIXTURE=1` 或 `VSPi_BACKEND=fixture` 的真实模型标签是 `Offline Fixture`，但不作为主界面的模型示例；正常启动若 Pi 模型配置缺失或损坏会显示 setup error，不会静默切换到 Fixture。

自更新由 `/update` 与 `vspi update` 共同提供；只接受 VSPi 公共 GitLab 项目的稳定 SemVer Release，并在 npm 全局安装前校验固定资产地址和 SHA-256。

主界面末端的顺序固定为 Plan bottom → contextual hint → 运行时 Working 活动带（仅 active 时）→ composer → 两行 status。hint 位于面板框外；Working 是独立的全宽状态层，不挤入 Effort 或其他 telemetry 字段，也不会抢 composer 焦点。

## M1 Context 与 Usage

`Context` 描述当前上下文占用，不是累计账单：它同时展示 current/used tokens、模型 context window（窗口）与 percent（百分比）。`Token ↑… ↓…` 独立展示当前 session 的 cumulative（累计）输入和输出；压缩会改变 Context，却不会重置累计 Token 与费用。

```text
活动    Context 50K / 128K 39%   Token ↑12K ↓3K
空容量  Context 0K / 0K 0%      Token ↑0 ↓0
未知    Context ?K / 128K ?%     Token ↑12K ↓3K
```

pi adapter 用 `getContextUsage()` 读取当前占用 token 和窗口，并由原始 token/window 计算百分比；SDK 自带 percent 不作为显示真值。`getSessionStats()` 单独提供累计 input、output 与 cost。窗口为 0 时显式输出 `0K / 0K 0%`；窗口已知但当前 token 暂不可估时输出 `?K / 128K ?%`。

`K` 按十进制千 token 格式化：0 固定为 `0K`，10K 以下保留一位小数，10K 及以上四舍五入为整数。百分比直接用未格式化的原始 token/window 计算，不能从已经舍入的 `K` 文本反算。

Status 响应式规则按固定区的内容预算计算，不使用只对单个样例有效的绝对 anchor。Model 与 Effort 组成连续左侧轨道，两者固定只隔两个空格；空间不足时只截断 Model，并在 Effort 与 Context 之间保留至少一个可见分隔单元。80/120 列从右向左预留：Context 最少 24 列并可为批准最大值扩到 25；Cost 最少 10 列并可扩到 13，Token 18。无标题路径获得第二行所有剩余空间，其完整 `Policy <name> · Host` 是不可截断 suffix；长 Model/路径只截断各自变量值。代表最大值 `Context 999K / 1000K 100%`、`Token ↑999k ↓999k` 和 `Cost ¥9999.99` 在 80/120 列必须完整且不重叠。

Status 的短模型样例左右锚是：80 列第一行 `Model 0 / Effort 24 / Context 56`、第二行 `路径值 0 / Token 52 / Cost 70`；120 列第一行 `Model 0 / Effort 24 / Context 96`、第二行 `路径值 0 / Token 92 / Cost 110`；40 列使用原生 `High` 时第一行是 `Model 0 / Effort 13 / Context 25`，第二行是 `路径值 0 / Token 20 / Cost 32`。Effort 的位置随 Model 与原生档位名的实际宽度变化，但固定小间距不变；Context/Token/Cost 的右锚不受 Model 或路径长度影响。长路径只截断自身，不会推动 Token/Cost；代表最大值会按前述预算扩展固定区，因此这些坐标不是 max case 的硬编码常量。

40 列 emergency 仍恰好两行：第一行 `Model / Effort / Context` 在 `High` 档位下从 `0 / 13 / 25` 开始，第二行从路径值开始，`Token / Cost` 从 `20 / 32` 开始。它保留五个有色标签、直接路径值与语义顺序，可以省略 busy/mode、Context token/window 与 Token output；无法容纳的高位费用使用明确的 `Cost …` omission marker，不能显示会被误解为未知数据的 `Cost ?`。Model/路径变量值仍按各自 flex 宽度截断。Backend 与 Policy 可由永久 Splash 提供完整真相。

120 列 literal 状态行：

```text
Model OpenAI / GPT-5.4  Effort High                                                             Context 50K / 128K 39%  
/workspace/vspi · Policy Standard · Host                                                    Token ↑12k ↓3.0k  Cost ¥1.01
```

40 列 emergency 状态行：

```text
Model Open…  Effort High Context 39%    
/workspace/vspi     Token ↑12k  Cost ¥1 
```

## M1 命令身份与补全

Command 以 canonical id 作为唯一执行身份。canonical `/new` 的 alias 是 `/clear`；`/sessions` 的 aliases 是 `/session` 与 `/resume`；`/providers` 的 alias 是 `/provider`；退出候选显示为 `quit (exit)`，canonical `/quit` 的 aliases 是 `/exit` 和 `/q`。`/thinking` 自身是 canonical 命令，不是 alias。alias 候选使用弱化的 canonical 注释显示来源关系：

```text
/exit  (/quit)               退出 VSPi                       Built-in
```

插件/扩展命令同样显示 canonical 与 alias 关系，并在 source 列保留 package 来源，例如 `@acme/deploy`，Enter 返回 canonical command。单独输入 `/` 打开完整命令目录，但 slash 和目录中的所有 cell 都不强调。composer 与 Command 面板的匹配前缀都有颜色，并叠加粗体、下划线、反显（bold / underline / inverse）作为非颜色 SGR 信号；即使 cursor 位于 slash token 中间，匹配字符仍保持强调，普通文本不强调。

`Tab` 是唯一补全键，只补全无参数的单一 slash token，且要求唯一候选：`/ex → /exit` 的强调范围只强调 `ex`，斜杠与 `it` 普通；`/qui → /quit` 只强调 `qui`，斜杠与 `t` 普通；`/ses → /sessions`、`/provi → /providers`、`/cl → /clear`。同一 command 的多个 token 候选、已有参数和普通文本均不改写；`Tab` 不会执行命令，也不写入 history（历史记录），空输入时 transcript Inspect 仍优先。若同一个 exact token 或 alias 指向两个不同 canonical command，domain resolver 与 Command 面板 Enter 都必须 fail closed；同一 canonical 的重复 token 仍按唯一执行身份处理。

以下结构标记逐 cell 记录普通与强调范围，可直接重构可见 token：

[普通: /]
[普通: /][强调: ex][普通: it]
[普通: /][强调: qui][普通: t]

Command 响应式规则：40 列使用“身份行 + 描述/source 行”的两行 item，滚动时不可拆开；80 列和 120 列使用稳定的身份、描述、source 三列。三档命令布局与 Status 一样按终端可见列计算，不使用 U+3000；长描述在 40 列从左侧截断以保留有意义的尾部和 package source。

## M1 Contextual Hints

contextual hint 只宣告当前真实可用的操作。普通面板 hint 位于 frame 外、composer 上方；Sessions 接管主内容区时把 `↑↓ / Enter / Shift+F / Esc` 放入底边并保留 Status，不渲染 Transcript、Plan、Composer 或 Working，同时在终端底部预留一个物理行，避免首次绘制把标题推出视口。Command 的 literal 文案固定为 `↑↓ 选择  Tab 补全  Enter 执行  Esc 关闭`；Plan、Provider、Settings、Usage、Theme、Question 与 Model 使用各自的上下文提示，未接入动作不得出现在 hint 中。

Model 以外层 60 列为 breakpoint：小于 60 列是窄屏列表/详情布局，hint 显示 `←→ 详情`，Right 进入详情、Left 返回；外层 60 列及以上是宽屏双栏，左侧列表、右侧详情，hint 不宣告无效的左右切换。

v0.3 的生产命令清单是：

```text
/new       /sessions   /import     /skills     /compact    /model      /providers
/update    /plan       /prompt     /thinking   /effort     /tools
/policy    /usage      /settings   /theme      /quit
```

手动 `/compact` 提供 Pi Native、Execution Continuity、Research Decisions 与 Custom 四种 profile。
未绑定 Local Plan 默认 Pi Native，绑定 Plan 默认 Execution Continuity；`/compact --list` 可检查当前选择范围。
v0.3.10 的自动 threshold/overflow 压缩仍由 Pi Native 处理，统一自动 profile 留待后续版本。
成功的 threshold 自动压缩若发生在当前 generation 内，每次完成后都必须注入隐藏 continuation 并继续同一用户任务；Pi 已声明 `willRetry` 的 overflow 不重复注入，手动压缩、失败和取消也不续跑。Plan 更新或把最后一项标为 done 只同步状态，不得替代实际修复与验证；最新用户指令揭示遗漏时必须重开或新增工作项。

`/plan`、`/prompt`、`/tools` 与 `/policy` 均由 Action Registry 接入真实生产工作区。无 Workflow 时 Plan 使用 workspace-scoped Local Plan；没有活动计划时常驻 frame 与 hint 都不渲染，Shift+Tab 跳过空 Plan，显式 `/plan` 可临时打开入口。显式启用 Workflow 后才只读投影 Workflow Delivery。Prompt 提供 Factory/Fork、分层规则、导入导出与 Effective Prompt；Tools 只读展示当前能力、路由与失败边界。

以下用户消息与 Tool 内容都是交互示例，不是新会话预置内容。用户消息不显示名字，使用焦点色竖标与至少三行的全宽表面；Dark 使用 `#202428`/`#F4F7FA`，Light 使用浅色表面，默认 Terminal 不写死前景或背景。短消息也保留上下留白，不绘制额外 frame。40 列、80 列和 120 列下硬换行、长单词和附件摘要保持宽度安全；Inspect 只改变选择态，不改变消息尺寸。Unicode 形状为：

```text

▌  message

```

回答只用弱化的 `•` 标记开始。Transcript 按后端事件只追加：工具前文本、Tool、Tool result 与工具后回答各有唯一节点，相同 `contentIndex` 不得复用节点 ID。完整 Session 历史不删除，主聊天只投影最多 80 个内容块、60K 字符和约 6 屏的最近后缀；旧块用顶部弱提示计数，逐消息/工具组缓存避免 Working 帧重复解析整段 Markdown，Inspect 使用同一窗口。`thinkingDisplay` 提供隐藏、折叠、展开三态：隐藏只收起正文，活跃时显示“思考中”，完成后仍保留最简思考记录；折叠保留 Effort/耗时标题并显示最后一段关键内容；展开显示完整正文。可选 `thinkingTranslationEndpoint` 只在 Thinking 完成后串行调用 HTTP(S) 翻译服务，原文继续保留在 Session，译文替换可见投影；pending/success/error 都在标题中有弱状态。Inspect 始终使用稳定 message id，并可查看当前单条 thinking/tool 详情。同一批 Tool 使用一个 `工具调用` 组头；每项把状态符号、固定宽度名称列和弱化动作摘要放在一行，摘要从同一列开始，运行/失败文字位于摘要末尾；中间项使用 `├─`，末项使用 `└─`。只要组内存在 queued/running 项，就实时展示完整树；全部进入 success/error/cancelled 后，`collapseTools=true` 将其收束为包含总数和失败/取消计数的一行摘要。Settings 的“完成后收起工具”默认开启，关闭后完整树持续显示；Inspect/Enter 临时恢复完整顺序，edit 输出继续使用行号、增删色与窄屏换行。Markdown 标题使用内容蓝色前景和字重，不增加背景块。Sub Agent 只展示模型、effort、任务和状态。

## Composer

composer 正文空态为一行，随内容增长，最多显示 10 行；之后内部滚动，框线显示上下隐藏量。`Shift+Enter/Ctrl+J` 换行。空闲时 `Enter` 启动新 prompt；工作中 `Enter` 使用 Pi 原生 Steer 队列，在当前工具批次结束后、下一次模型调用前送达。`Alt+Enter` 使用 Follow-up 队列，在 Agent 完全 idle 后送达。排队成功会立即清空 composer，用户消息暂时使用较弱表面，投递状态放在正文之外；`queue_update` 表示消息已被消费后清除状态，消息恢复普通显示。中文 IME 光标由 pi-tui hardware cursor marker 定位。

附件节点有三态：光标在左侧、整块选中、光标在右侧。选中时状态行替换为：

```text
〔登录页-修改前〕  重命名 · 预览 · 移除 · 保存到项目
```

删除附件同时删除缓存文件和 manifest 条目；保存到项目只由显式用户动作触发。附件缓存按真实 Pi session id 隔离；manifest 恢复和 `readBase64`/Pi image payload 的每次读取都使用非跟随 symlink 的文件句柄，并复验 session containment、普通文件、inode、实际大小、MIME magic 和图片尺寸。Pi 在这些检查完成前不会调用 `session.prompt`。项目保存逐级验证 project、`.vspi` 与 `attachments` 是未变化的真实目录，拒绝 symlink，并使用同目录 `O_EXCL|O_NOFOLLOW` 临时文件和原子 rename。Session reset 会切换并恢复对应 manifest 的 composer 节点，epoch 校验阻止较慢的旧恢复覆盖新会话。AttachmentService 的 store 操作和 switch 使用同一队列；switch 请求同步推进 generation，使旧 paste/Bridge delivery 在 callback 前回滚。retention cleanup 只删除超过期限且不在 retain list 中的 session 目录。

## Markdown

以下 Markdown 视觉规则已经接入完整流式渲染；`wrapCode` 决定 fenced code 长行是否换行，partial fence 到完成态的重绘在 40/80/120 列保持有界且不残留 streaming cursor。

- H1/H2：焦点青、粗体、下划线。
- H3 及以下：彩色粗体，保留层级前缀。
- 有序列表：序号后一个空格；续行与正文首列对齐。
- 无序列表：一级 `•`、二级 `◦`、三级 `▪`，继续嵌套时循环。
- 粗体、斜体、删除线和链接使用终端原生属性；不支持的属性自然降级。
- 行内代码使用琥珀前景与代码背景。
- fenced code 使用整行背景、语言标签和语法色；流式未闭合 fence 不闪烁。
- 引用使用焦点色竖线和数据蓝文本。
- 表格、任务列表、分隔线、长单词和东亚宽字符均参与列宽计算。

## 底部工作区

Plan、Commands、Model、Provider、Sessions、历史导入、Skills、Settings、Usage、Theme、Question、Tools 和图片预览占用同一位置，不互相嵌套；后续面板也不得创建 nested modal。

历史导入面板使用 Codex / Claude Code 水平 Tab、标题/路径搜索与固定列表/详情布局；窄终端降级为单列。两类来源均补充发现未索引的用户主会话，同时排除 Codex subagent rollout 与 Claude Code `agent-*` 记录。选中后 Enter 直接流式解析并复制，不调用 Question，也没有“提交答案”二次复核。解析以读取开始时的字节长度为边界，只接受边界内的完整 JSONL 行；写入前可见指纹变化必须放弃本次快照并重试。导入始终创建新 Pi Session，不改写 Codex/Claude 源文件；用户消息、助手 Thinking 与最终回答转换为原生可见历史，工具调用和工具输出完全丢弃。新 Session 另存导入时的当前 VSPi model/effort 作为后续运行身份。模型上下文优先使用 Codex 最近 compaction checkpoint 与其后正文，否则按当前模型窗口约 85% 的预算截取最近正文；显示历史不受该上下文裁剪影响。system/developer prompt、凭据、权限或内部控制记录不进入快照，常见凭据在落盘前脱敏；v0.3.3/v0.3.4 的 legacy reference custom message 在 Provider context 边界 fail closed 过滤。

Skills 工作区使用“已启用 / 可导入 / 问题”Tab、搜索和列表/详情布局；外层 58 列以下用 Enter 进入详情、Esc 返回。Pi Native ResourceLoader/SettingsManager/DefaultPackageManager 是唯一资源与包真相源。Codex/Claude Code Skill 只登记原始 `SKILL.md` 路径；Git/npm 安装固定 `autoload: false`，extension、prompt、theme 为空，只允许包目录内发现的 Skill pattern。所有 mutation 先通过 Question；安装确认包含“安装并启用 / 仅安装 / 取消”。`skill_list` 与 `skill_manage` 进入模型工具表，但管理调用仍不能绕过 Question。失败安装原子回滚，既有包不被清理，URL 凭据在面板、diagnostic 和错误中脱敏。MCP 保持独立后续版本，不在此工作区注册。

M3 已将 Model 接到 Pi ModelRuntime 真相源。Model 有“选择模型 / 模型组”两个横向 Tab。外层 60 列及以上固定为左侧模型/模型组列表、右侧详情/角色，内部使用一个稳定的 `│` 分隔；上下移动只替换右侧内容，行数不变。CNY/人民币价格仅出现在单模型右侧详情，模型组右侧不出现 `¥`，并且`不显示汇率参考行`。Enter 只提出选择；必须等待 `session.setModel()` 成功后才更新勾选、Model、vision、Context 和 Profile model identity。

```text
╭ Model ───────────────────────────────────────────────────────────────────────╮
│ 选择模型   模型组                                                            │
│› ✓ GPT-5.4 ◉                 │GPT-5.4                                        │
│    Kimi K3 ◉                 │Provider  OpenAI  Model ID  gpt-5.4            │
│    Kimi K2.5 ◉               │能力  文本 · 图片  Effort  Off / Low / High   │
│    GLM-5                     │发布  2026-06-30                               │
│    Qwen3 Coder               │输入 ¥14.36 / 百万  输出 ¥57.44 / 百万         │
╰──────────────────────────────────────────────────────────────────────────────╯
```

外层小于 60 列（包括 40 列紧急窄屏）默认只显示列表且不显示价格，`Right` 切为详情视图，`Left` 回到列表；`Tab` 切换模型/模型组并重置为列表。Enter 在两种视图中都选择当前项。Provider 在 80 列同样使用左列表/右详情。Provider action menu 按 Pi 元数据增加订阅登录、API Key 和移除凭据；API Key 在独立认证层中遮蔽输入，Esc abort，Secret 不进入 transcript、notice 或诊断。Provider URL/协议编辑仍不收集 secret，`Ctrl+S` 是唯一保存键。离线 check-config、显式 test-connection、二次费用确认后的 minimal-generation 是三个不同动作。

Provider catalog 的优先级是 built-in < Pi global < trusted project。默认启动显式构造 `SettingsManager(..., { projectTrusted: false })`，不会采用 SDK 的默认 trust；只有 `--trust-project` 才把 trust 绑定到启动时 workspace realpath，其他 cwd 不继承，也不存在环境变量自动信任入口。无 flag 时 project Provider overlay/resources 与 VSPi `.vspi/settings.json` 不读不注册，Provider、project settings 与 project runtime-defaults save 都拒绝；global settings 不受影响。

项目文件禁止 secret、credential、命令值和敏感 header；Provider/model wire protocol 只允许 OpenAI Responses、OpenAI Completions、Anthropic Messages、Google Generative AI 及 UI 的明确别名，模型 input 必须是包含 `text` 的非空 `text/image` 集合。编辑 Provider 后保存会清除该项目 Provider/模型的陈旧 `api`；runtime 以 `protocol > api` 解析，兼容旧 api-only 文件，同时保证新 protocol 对已物化的 ModelRuntime 模型生效。项目写入使用 canonical hash 并发控制与 0600 原子文件；Provider、settings 和 defaults 共用 path guard，对 `.vspi`、目标、lock/temporary 执行 `lstat`，通过 realpath containment 约束在 workspace 内，并在 mkdir 与 rename 前复验。凭据只由当前 Session/Pi stored/environment 内部解析，优先级为 Session > Pi stored > environment，不在 UI、diagnostic 或 project config 中回显。

普通 `/new` 只继承精确 `{provider,id}` 和 Effort：新 services 创建、可信 overlay 注册完成后，必须从新的 ModelRuntime 重新解析模型，因此 Base URL/protocol 覆盖会在下一 Session 生效；找不到 identity 时 fail closed。`/new --default` 不继承旧 Model 对象。Panel 选中态和 `runtime-defaults.json` 同样使用 provider-qualified identity，序列化时 model 只含 `provider` 与 `id`。Fixture 不写 runtime defaults；Pi 启动已经拥有可用模型后，跨后端、失效或未认证的默认模型只产生有界警告并保留当前模型，不能中止启动。默认 Effort 也必须属于当前模型的原生档位集合，否则保留当前档位。

### M1 Host Approval Policy

等级与顺序固定为 `Safe < Standard < YOLO < Auto`；默认 Standard，project policy 只能降低 CLI/global 上限。四档都标记 `Host`，区别只在工具执行前是否需要人工批准。

- Safe：`read/ls/find/grep` 与明确只读 Bash 免询问，其他操作询问。
- Standard：工作区编辑、写入、构建和测试等日常开发免询问；网络、SSH、Git 写入、越界和高风险操作询问。
- YOLO：一般开发、联网和远程操作免询问；删除、容器、系统和其他高风险操作询问。
- Auto：所有工具调用免询问。

审批 Panel 提供允许本次、本会话允许同类、提升到最低充分档位并执行、拒绝、拒绝并说明。最低充分档位是第一个能让当前动作无需再次审批的 Policy：Safe 工作区写入为 Standard，Standard SSH 为 YOLO，Standard 或 YOLO 删除为 Auto；会话放行与提升等级只驻留内存。Panel 正文使用左右 gutter 和分组留白，选项再增加一级缩进；当前 Policy 在类别上方独占一行，以最长档位名 `Standard` 的 8 列宽度绘制背景标签，其他档位在同宽标签内居中，并在窄终端动态收缩。Safe、Standard、YOLO、Auto 分别使用绿、黄、橙、红的低亮度语义背景，同时保留文字作为非颜色信号。首轮分类是有意的粗粒度实现，不承诺识别 Bash 中所有隐藏写操作。`workflow-authority` 无论 Policy 等级都必须调用独立 authority。

PolicyConfigService 读取全局 `~/.config/vspi/policy.json` 和可信项目 `<workspace>/.vspi/policy.json`。schema 只允许 `policy` 与 `networkAllowlist`；CLI Policy 覆盖全局默认，项目 Policy 只能降低最终等级。项目网络列表与全局列表取交集，不能扩张全局能力。每个网络 target 只允许无 username/password、query、fragment 的 HTTP(S) origin/path；load/save 在 global/project 四条路径都先拒绝，错误和 diagnostic 不得包含原 URL。未 trust 或 Recovery 时不打开项目 Policy 文件。配置拒绝 secret/credential、敏感 header 和 `!command`；项目路径使用 realpath/symlink guard，保存使用 canonical expected hash、writer lock、0600 temporary 与 atomic rename。损坏配置只产生有界 diagnostic，不会自动覆盖。

Pi 的最终 active registry 使用原生 `read/ls/find/grep/bash/edit/write` ToolDefinition；VSPi 只在调用原生 `execute()` 前评估审批，批准后完整委托，因此保留原生图片读取、流式更新、timeout、AbortSignal、截断与 diff。VSPi 自有 `question` 继续提供单选、多选、排序、自由文本和最终检查。普通模式注册结构化 `plan_list/read/create/update/archive/bind`；`plan_update` 与 `plan_archive` 分离，避免 Provider 将可选归档参数提升为必填后误归档，并通过 expected revision、Session custom entry 和 mutation refresh 保持长期计划；显式 Workflow 模式不注册 Local Plan 工具，只通过每轮 Workflow capsule 提醒 Agent 使用 Workflow authority。

`/tools` 是宿主侧只读能力目录，不进入模型上下文。Files/Search 复用 Pi 原生工具；Git 和 SSH 复用 Pi Bash，但分别使用 `git-write` 与 `ssh` 审批类别；图片由 Pi 原生 image read 和 VSPi attachment session 共同提供。Browser 与 MCP 显示 `Not connected` 且不注册占位 ToolDefinition；产品内 Persistent PTY 显示 `Deferred`，当前只承诺一次性 Bash。测试层必须用 `node-pty` 与 headless xterm 启动真实 CLI，覆盖按键、resize、可视屏幕和原生 scrollback；内存 Terminal mock 只用于局部状态机测试。每项同时显示状态、执行路由和独立失败边界；Up/Down 移动，Esc 返回，40/80/120 列均不得溢出。

Workflow 采用默认关闭、显式 `--workflow` 启用的可选只读 Provider。默认启动不读取 Workflow 环境变量或项目状态，Plan 保持 VSPi 自己的干净界面；显式开启后才投影 Delivery。Core 未配置或读取失败时 Plan 显示有界不可用状态。Adapter 只调用 Delivery `resume` 形成 workspace 级投影并拒绝 Receipt-bearing mutation。

Question、审批、Effort、Settings、预览和 Inspect 共享底部工作区。Esc 先退出当前界面；回到主界面后再次按 Esc 才中断当前生成或工具，且不会新建 Session、重启 TUI 或退出进程。Agent 从首次提交到 primary prompt 与 Steer/Follow-up 队列全部耗尽期间，在 composer 上方持续显示无背景的动态 `Working`；尚未送达的消息另用一行弱化内容和 `↪` 表示，不进入 Transcript 或 Inspect。取消只 abort 当前运行：Session identity、已发送用户消息、partial thinking/text/tool 和当前 composer 草稿全部保留，running Tool 进入 cancelled；尚未送达的原生队列由 `clearQueue` 按顺序取回，合并为新的普通 prompt 并立即继续执行，当前未提交草稿保持不变。取消栅栏持续到新的 prompt 主动 send：旧 generation 的 retry、文本以及 Tool 的 start、update、end 事件均被丢弃，agent end 只负责恢复 idle；Pi Bash 的 AbortSignal 同时终止运行中的子进程组。

同服务器的 Session 使用独占 lease、heartbeat 和 `0600` Unix control socket 保证单写者与单一可交互前台。Sessions 面板将其他 owner 标为“使用中”，并提供前台迁移、安全分支和取消。迁移不得序列化或重建 Pi 的 live JavaScript 工具栈：旧进程保留真实 Agent 执行栈，新 TUI 在 lease acquisition 完成前先启动为等待态，只允许处理 socket 转发的 Question/Approval；旧 TUI 从接受请求起锁定全部输入。已经 pending 或迁移后出现的 Question/Approval 都在新 TUI 弹出，回答回传并解析到旧进程原 Promise。旧进程必须等 generation、tool、compaction 与原生队列全部 idle，且不得调用 Agent abort；落盘后显示已移交并退出。新进程随后获得 lease、重新打开最终 Session 并恢复完整 Transcript、工具状态和普通输入。多个等待进程中只有被接受者可以回答；接管方在安全点前断开时旧 TUI 解除移交锁并恢复 pending 交互。占用中分支只能复制最后一个完整 assistant 回复及其之前的稳定历史。普通退出不保留后台任务；resume 只恢复落盘内容，最后一条为 user 或 aborted assistant 时显示中断标记，不自动重试。该机制只承诺同服务器，跨服务器共享存储留待后续版本。

保存结果与短时状态临时替换固定 contextual hint 行，约 3.5 秒后恢复；出现和消失前后总布局高度不变，不创建 overlay，也不改变 composer 焦点。

`--recovery` 在任何 `--policy`/`--trust-project`/`--workflow` 之前生效，固定 `Standard · Host`、拒绝需提升审批的工具、`trustedProject:false`、`global-only`。VSPi project Policy/settings/Provider/defaults 不读取；Pi services 同时使用 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`。Splash 和状态区显示 Recovery，不能从 Policy Panel 切走。

Workflow bootstrap 使用 TypeScript adapter 包裹同进程 ESM JavaScript Core。只有显式 `--workflow` 才进入 loader；loader 以绝对安装根、原始 portable archive、accepted source commit、archive SHA-256、bundle manifest SHA-256 与 runtime manifest SHA-256 为一组不可拆分的 identity 输入。import 前验证 release descriptor、manifest identity、全部声明 Core 文件和 materialized runtime dependency 字节，要求 bundle manifest 绑定 descriptor/Core root export，并拒绝 `node_modules` 未声明文件或 symlink；import 后检查 required exports。显式启用后，`/plan` 只读展示真实 foreground Delivery、revision、status、plan hash 与 Milestone；`/hw:init`、`/hw:resume`、`/hw:accept` 等 Receipt-bearing 生命周期命令不注册到 VSPi，authority 一律 deny。Recovery 在 loader/env discovery 之前分叉，永不读取或导入 Workflow bundle。

边界必须按字面理解：当前 Policy 不是 OS sandbox，SSH、容器和远程系统也不在隔离边界内。深层命令解析、小模型审批、远程目标约束和系统级 containment 是后续安全加固。

Question 已注册为 Pi 的真实 TypeBox `question` ToolDefinition，并在初始及 replacement runtime 中与 Policy tools 一起安装；调用本身以 Tool 节点进入 Transcript。弹出后使用 `Question n / m` 进度元数据、粗体标题、正文、分隔线、选项标题与次级说明形成层次；四种题型支持“其他”、直接回答、跳过和最终检查，填空输入位于 Question 工作区内部。`Left/Right` 切题，`Up/Down` 选择，`Ctrl/Alt+Up/Down` 排序，`Tab` 直接回答，`Shift+S` 跳过，`Enter` 确认/提交；hint 只显示当前状态可用动作。Tool result 只返回 question id、answer/skipped，取消、Session replacement 与 dispose 都 fail closed。

Settings 分别加载 Global 与 Project 层，Tab 切换只更换草稿，Enter 修改，`Ctrl+S` Apply，Esc Cancel；切 Tab 和修改开关不会立即写文件。“思考翻译服务”进入独立文本编辑态，支持粘贴 IP:端口、域名或完整 URL，Enter 确认字段、Esc 取消字段编辑；保存时只接受无 userinfo 的 HTTP(S)，缺省 path 补 `/translate`。`/effort` 从当前 Pi Session 的 `getAvailableThinkingLevels()` 读取模型实际支持的 `off/minimal/low/medium/high/xhigh/max` 子集，展示时首字母大写，保存时保留原生小写值；旧中文配置在读取时迁移。未 trust 或 Recovery 时只允许 Global settings。

## 升级边界

`pi-tui` 负责终端 I/O、差分更新、宽度算法、Editor/IME 和图片协议；VSPi 负责主题、布局、Markdown 规则、业务状态与面板。`pi-coding-agent` 只经 `ChatBackend` adapter 进入应用。上游升级必须保持 adapter contract，并重新运行完整 check/test/build/smoke、真实 SDK 启动和 80×24 PTY 检查。
