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
用户消息背景    #B8E6E3
用户消息正文    #102426
```

颜色从不单独承担状态：成功、当前、未开始和错误同时使用 `✓ / ● / ○ / ×`。

## 启动封面

封面使用多行圆角框、`◈` 品牌符号和块字符 VSPi。initial brand-only 初始帧仅显示品牌、现有六行块字符 Logo 与动画进度，不含运行状态或模型声明；写出首帧的同一轮立即启动应用初始化，使初始化与约 280ms 的四帧动画并行。reduced-motion、CI 与 dumb terminal 跳过中间帧，但不绕过初始化屏障。

最终帧等待应用初始化完成，使用初始化后解析得到的真实 Model，并显示从 `package.json` 读取的包版本、Backend 与独立的执行 Policy。真实后端显示 `Backend Pi`，显式离线后端显示 `Backend Fixture`；Policy 以 `Policy Standard · Sandboxed` 或相应的 `Policy … · Host` 表达。启动、`/new` 和 alias `/clear` 都必须先把完整最终帧提交并写入终端 `scrollback`，之后才启动新的动态 TUI；后续刷新和差分渲染只拥有其下方的动态区域，不会擦除、清空或覆盖这个最终帧。

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
│ Policy Standard · Sandboxed                                            v0.1.0│
╰──────────────────────────────────────────────────────────────────────────────╯
```

## 主界面

```text
╭ 当前计划 ────────────────────────────────────────────────────────────────────╮
│当前计划为空                                                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
Shift+Tab 切换焦点
╭──────────────────────────────────────────────────────────────────────────────╮
│ 输入内容                                                                     │
╰──────────────────────────────────────────────────────────────────────────────╯
Model OpenAI / GPT-5.4  Effort 高                       Context 50K / 128K 39%  
/workspace/vspi · Policy Standard · Sandboxed       Token ↑12k ↓3.0k  Cost ¥1.01
```

80 列普通 Status 区固定为两行：第一行语义固定为 `Model / Effort / Context`；第二行直接从路径值开始，再显示 `Policy / Token / Cost`，不显示 `Path` 标题。Backend 不进入动态行，只存在于永久 Splash 和诊断信息。五个字段标签与字段值、以及无标题路径值分别着色；80/120 列的路径 flex 区从右侧保留完整 Policy/Boundary suffix，只有 Model 与路径变量值可截断。默认的新会话动态界面为空，不加载或预置对话、工具消息，Plan 只显示 `当前计划为空`，因此 empty Plan 的 state-aware hint 只显示有效的 `Shift+Tab 切换焦点`；后文出现的消息、工具与 active telemetry 均为“交互示例”，不是启动内容。显式离线入口 `VSPi_FIXTURE=1` 或 `VSPi_BACKEND=fixture` 的真实模型标签是 `Offline Fixture`，但不作为主界面的模型示例；正常启动若 Pi 模型配置缺失或损坏会显示 setup error，不会静默切换到 Fixture。

主界面末端的顺序固定为 Plan bottom → contextual hint → composer → 两行 status。hint 位于面板框外，并直接位于 composer上方，因此不会占用或覆盖可滚动的 panel body。

## M1 Context 与 Usage

`Context` 描述当前上下文占用，不是累计账单：它同时展示 current/used tokens、模型 context window（窗口）与 percent（百分比）。`Token ↑… ↓…` 独立展示当前 session 的 cumulative（累计）输入和输出；压缩会改变 Context，却不会重置累计 Token 与费用。

```text
活动    Context 50K / 128K 39%   Token ↑12K ↓3K
空容量  Context 0K / 0K 0%      Token ↑0 ↓0
未知    Context ?K / 128K ?%     Token ↑12K ↓3K
```

pi adapter 用 `getContextUsage()` 读取当前占用 token 和窗口，并由原始 token/window 计算百分比；SDK 自带 percent 不作为显示真值。`getSessionStats()` 单独提供累计 input、output 与 cost。窗口为 0 时显式输出 `0K / 0K 0%`；窗口已知但当前 token 暂不可估时输出 `?K / 128K ?%`。

`K` 按十进制千 token 格式化：0 固定为 `0K`，10K 以下保留一位小数，10K 及以上四舍五入为整数。百分比直接用未格式化的原始 token/window 计算，不能从已经舍入的 `K` 文本反算。

Status 响应式规则按固定区的内容预算计算，不使用只对单个样例有效的绝对 anchor。Model 与 Effort 组成连续左侧轨道，两者固定只隔两个空格；空间不足时只截断 Model，并在 Effort 与 Context 之间保留至少一个可见分隔单元。80/120 列从右向左预留：Context 最少 24 列并可为批准最大值扩到 25；Cost 最少 10 列并可扩到 13，Token 18。无标题路径获得第二行所有剩余空间，其完整 `Policy <name> · Sandboxed|Host` 是不可截断 suffix；长 Model/路径只截断各自变量值。代表最大值 `Context 999K / 1000K 100%`、`Token ↑999k ↓999k` 和 `Cost ¥9999.99` 在 80/120 列必须完整且不重叠。

Status 的短模型样例左右锚是：80 列第一行 `Model 0 / Effort 24 / Context 56`、第二行 `路径值 0 / Token 52 / Cost 70`；120 列第一行 `Model 0 / Effort 24 / Context 96`、第二行 `路径值 0 / Token 92 / Cost 110`；40 列第一行 `Model 0 / Effort 15 / Context 25`、第二行 `路径值 0 / Token 20 / Cost 32`。Effort 的位置随 Model 实际宽度变化，但固定小间距不变；Context/Token/Cost 的右锚不受 Model 或路径长度影响。长路径只截断自身，不会推动 Token/Cost；代表最大值会按前述预算扩展固定区，因此这些坐标不是 max case 的硬编码常量。

40 列 emergency 仍恰好两行：第一行 `Model / Effort / Context` 的短模型样例从 `0 / 15 / 25` 开始，第二行从路径值开始，`Token / Cost` 从 `20 / 32` 开始。它保留五个有色标签、直接路径值与语义顺序，可以省略 busy/mode、Context token/window 与 Token output；无法容纳的高位费用使用明确的 `Cost …` omission marker，不能显示会被误解为未知数据的 `Cost ?`。Model/路径变量值仍按各自 flex 宽度截断。Backend 与 Policy 可由永久 Splash 提供完整真相。

120 列 literal 状态行：

```text
Model OpenAI / GPT-5.4  Effort 高                                                               Context 50K / 128K 39%  
/workspace/vspi · Policy Standard · Sandboxed                                               Token ↑12k ↓3.0k  Cost ¥1.01
```

40 列 emergency 状态行：

```text
Model OpenAI…  Effort 高 Context 39%    
/workspace/vspi     Token ↑12k  Cost ¥1 
```

## M1 命令身份与补全

Command 以 canonical id 作为唯一执行身份。canonical `/new` 的 alias 是 `/clear`；`/sessions` 的 aliases 是 `/session` 与 `/resume`；`/providers` 的 alias 是 `/provider`；退出候选显示为 `quit (exit)`，canonical `/quit` 的 aliases（别名）是 `/exit` 和 `/q`。`/thinking` 自身是 canonical 命令，不是 alias。alias 候选必须显示来源关系：

```text
别名（/exit） → /quit        退出 VSPi                       Built-in
```

插件/扩展命令同样显示 canonical 与 alias 关系，并在 source 列保留 package 来源，例如 `@acme/deploy`，Enter 返回 canonical command。单独输入 `/` 打开完整命令目录，但 slash 和目录中的所有 cell 都不强调。composer 与 Command 面板的匹配前缀都有颜色，并叠加粗体、下划线、反显（bold / underline / inverse）作为非颜色 SGR 信号；即使 cursor 位于 slash token 中间，匹配字符仍保持强调，普通文本不强调。

`Tab` 是唯一补全键，只补全无参数的单一 slash token，且要求唯一候选：`/ex → /exit` 的强调范围只强调 `ex`，斜杠与 `it` 普通；`/qui → /quit` 只强调 `qui`，斜杠与 `t` 普通；`/ses → /sessions`、`/provi → /providers`、`/cl → /clear`。同一 command 的多个 token 候选、已有参数和普通文本均不改写；`Tab` 不会执行命令，也不写入 history（历史记录），空输入时 transcript Inspect 仍优先。若同一个 exact token 或 alias 指向两个不同 canonical command，domain resolver 与 Command 面板 Enter 都必须 fail closed；同一 canonical 的重复 token 仍按唯一执行身份处理。

以下结构标记逐 cell 记录普通与强调范围，可直接重构可见 token：

[普通: /]
[普通: /][强调: ex][普通: it]
[普通: /][强调: qui][普通: t]

Command 响应式规则：40 列使用“身份行 + 描述/source 行”的两行 item，滚动时不可拆开；80 列和 120 列使用稳定的身份、描述、source 三列。三档命令布局与 Status 一样按终端可见列计算，不使用 U+3000；长描述在 40 列从左侧截断以保留有意义的尾部和 package source。

## M1 Contextual Hints

所有 contextual hint 都位于面板 frame 外、composer上方，并且只宣告当前真实可用的操作。Command 的 literal 文案固定为 `↑↓ 选择  Tab 补全  Enter 执行  Esc 关闭`；Plan、Provider、Sessions、Settings、Usage、Theme、Question 与 Model 使用各自的上下文提示，未接入动作不得出现在 hint 中。

Model 以外层 60 列为 breakpoint：小于 60 列是窄屏列表/详情布局，hint 显示 `←→ 详情`，Right 进入详情、Left 返回；外层 60 列及以上是宽屏双栏，左侧列表、右侧详情，hint 不宣告无效的左右切换。

v0.1 的生产命令清单是：

```text
/new       /sessions   /compact    /model      /providers
/plan      /prompt     /thinking   /effort     /policy
/usage     /settings   /theme      /quit
```

手动 `/compact` 提供 Pi Native、Execution Continuity、Research Decisions 与 Custom 四种 profile。
未绑定 Local Plan 默认 Pi Native，绑定 Plan 默认 Execution Continuity；`/compact --list` 可检查当前选择范围。
v0.1.0 的自动 threshold/overflow 压缩仍由 Pi Native 处理，统一自动 profile 属于 v0.2.0。

`/plan`、`/prompt` 与 `/policy` 均由 Action Registry 接入真实生产工作区。Plan 提供 revision、binding 与 contextual edit；Prompt 提供 Factory/Fork、分层规则、导入导出与 Effective Prompt；自更新不属于 v0.1.0 的生产表面。

以下用户消息与 Tool 内容都是交互示例，不是新会话预置内容。用户消息不显示名字，使用 full-width light rounded frame：正文背景为 `#B8E6E3`、前景为 `#102426`，边框使用焦点青 `#5FC7C7`。40 列、80 列和 120 列都保持 frame 的精确可见宽度；硬换行、长单词 wrap 与附件摘要均在 frame 内，transcript Inspect 选中完整 block 时保留原文和 frame 形状。Unicode 形状为：

```text
╭──────────────────╮
│ message          │
╰──────────────────╯
```

ASCII/无色降级形状为：

```text
+------------------+
| message          |
+------------------+
```

回答只用 `◆` 标记开始。thinking 默认折叠且保留原始英文；`showThinking=false` 会即时过滤普通 thinking 行，Inspect 仍使用稳定 message id，并可显示当前选中的单条 thinking/tool 详情。Tool 使用树状轨迹，状态覆盖 queued、running、success、error 和 cancelled；edit 展开后使用行号、增删色与窄屏换行。Sub Agent 只展示模型、effort、任务和状态。

## Composer

composer 正文空态为一行，随内容增长，最多显示 10 行；之后内部滚动，框线显示上下隐藏量。`Shift+Enter/Ctrl+J` 换行，`Enter` 提交，`Alt+Enter` follow-up。中文 IME 光标由 pi-tui hardware cursor marker 定位。

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

Plan、Commands、Model、Provider、Sessions、Settings、Usage、Theme、Question 和图片预览占用同一位置，不互相嵌套；后续面板也不得创建 nested modal。

M3 已将 Model 接到 Pi ModelRuntime 真相源。Model 有“选择模型 / 模型组”两个横向 Tab。外层 60 列及以上固定为左侧模型/模型组列表、右侧详情/角色，内部使用一个稳定的 `│` 分隔；上下移动只替换右侧内容，行数不变。CNY/人民币价格仅出现在单模型右侧详情，模型组右侧不出现 `¥`，并且`不显示汇率参考行`。Enter 只提出选择；必须等待 `session.setModel()` 成功后才更新勾选、Model、vision、Context 和 Profile model identity。

```text
╭ Model ───────────────────────────────────────────────────────────────────────╮
│ 选择模型   模型组                                                            │
│› ✓ GPT-5.4 ◉                 │GPT-5.4                                        │
│    Kimi K3 ◉                 │Provider  OpenAI  Model ID  gpt-5.4            │
│    Kimi K2.5 ◉               │能力  文本 · 图片  Effort  低 / 中 / 高        │
│    GLM-5                     │发布  2026-06-30                               │
│    Qwen3 Coder               │输入 ¥14.36 / 百万  输出 ¥57.44 / 百万         │
╰──────────────────────────────────────────────────────────────────────────────╯
```

外层小于 60 列（包括 40 列紧急窄屏）默认只显示列表且不显示价格，`Right` 切为详情视图，`Left` 回到列表；`Tab` 切换模型/模型组并重置为列表。Enter 在两种视图中都选择当前项。Provider 在 80 列同样使用左列表/右详情。所有 Provider 的 Enter 只打开 action menu；编辑只收集名称、Base URL 和协议，不收集 secret，`Ctrl+S` 是唯一保存键。离线 check-config、显式 test-connection、二次费用确认后的 minimal-generation 是三个不同动作。

Provider catalog 的优先级是 built-in < Pi global < trusted project。默认启动显式构造 `SettingsManager(..., { projectTrusted: false })`，不会采用 SDK 的默认 trust；只有 `--trust-project` 才把 trust 绑定到启动时 workspace realpath，其他 cwd 不继承，也不存在环境变量自动信任入口。无 flag 时 project Provider overlay/resources 与 VSPi `.vspi/settings.json` 不读不注册，Provider、project settings 与 project runtime-defaults save 都拒绝；global settings 不受影响。

项目文件禁止 secret、credential、命令值和敏感 header；Provider/model wire protocol 只允许 OpenAI Responses、OpenAI Completions、Anthropic Messages、Google Generative AI 及 UI 的明确别名，模型 input 必须是包含 `text` 的非空 `text/image` 集合。编辑 Provider 后保存会清除该项目 Provider/模型的陈旧 `api`；runtime 以 `protocol > api` 解析，兼容旧 api-only 文件，同时保证新 protocol 对已物化的 ModelRuntime 模型生效。项目写入使用 canonical hash 并发控制与 0600 原子文件；Provider、settings 和 defaults 共用 path guard，对 `.vspi`、目标、lock/temporary 执行 `lstat`，通过 realpath containment 约束在 workspace 内，并在 mkdir 与 rename 前复验。guard 无法从用户态完全消除检查与 syscall 之间的并发 TOCTOU，M4 仍需提供 OS sandbox/进程 containment。凭据只由当前 Session/Pi stored/environment 内部解析，优先级为 Session > Pi stored > environment，不在 UI、diagnostic 或 project config 中回显。

普通 `/new` 只继承精确 `{provider,id}` 和 Effort：新 services 创建、可信 overlay 注册完成后，必须从新的 ModelRuntime 重新解析模型，因此 Base URL/protocol 覆盖会在下一 Session 生效；找不到 identity 时 fail closed。`/new --default` 不继承旧 Model 对象。Panel 选中态和 `runtime-defaults.json` 同样使用 provider-qualified identity，序列化时 model 只含 `provider` 与 `id`。

### M4 Execution Policy

等级与顺序固定为 `Safe < Standard < Auto < YOLO`；默认 Standard，project policy 只能降低 CLI/global 上限。Panel 稳定列出四级：Safe/Standard/Auto 标记 `Sandboxed`，YOLO 标记 `Host`。选择 YOLO 时额外显示“高风险、绕过 VSPi approval 与 sandbox”的不可跳过警告，hint 改为 `Enter 确认 YOLO`；切换失败恢复原 snapshot。

- Safe：bwrap 内 workspace 只读；写入、网络、共享拒绝，且不调用 approval。
- Standard：bwrap 内 workspace 可写；越界、共享、高风险 process 和网络先请求 approval，默认拒绝。网络还必须匹配配置 allowlist。
- Auto：bwrap 内 workspace 可写且不弹 VSPi approval；只有配置 allowlist 的网络可启动，越界与未配置共享仍拒绝。
- YOLO：确认后只按调用者请求直接 spawn Host 子进程；不调用 VSPi approval，不使用 bwrap。

所有拒绝都发生在 spawn 前并记录脱敏 audit；`workflow-authority` 无论 Policy 等级都必须调用独立 authority，YOLO 也不能绕过。Sandbox capability 由真实 `bwrap --version` 与 user-namespace probe 检查；缺失时不做文案式降级，非 YOLO 切换与执行失败。

PolicyConfigService 读取全局 `~/.config/vspi/policy.json` 和可信项目 `<workspace>/.vspi/policy.json`。schema 只允许 `policy` 与 `networkAllowlist`；CLI Policy 覆盖全局默认，项目 Policy 只能降低最终等级。项目网络列表与全局列表取交集，不能扩张全局能力。每个网络 target 只允许无 username/password、query、fragment 的 HTTP(S) origin/path；load/save 在 global/project 四条路径都先拒绝，错误和 diagnostic 不得包含原 URL。未 trust 或 Recovery 时不打开项目 Policy 文件。配置拒绝 secret/credential、敏感 header 和 `!command`；项目路径使用 realpath/symlink guard，保存使用 canonical expected hash、writer lock、0600 temporary 与 atomic rename。损坏配置只产生有界 diagnostic，不会自动覆盖。

Pi 的最终 active registry 使用同名 `read/bash/edit/write` ToolDefinition 覆盖，保留 Pi 原生 parameters、label、description、`renderCall` 与 `renderResult`，只把 `execute` 改为进入 VSPi ExecutionPolicyService。初始、resume、new、switch/fork replacement runtime 都重新安装覆盖，并复用启动层创建的同一个 service 对象；VspiApp 的 Policy Panel 也消费该对象。若导出的 PiBackend 被直接构造且未注入 service，它必须在构造边界创建内部 Standard Sandboxed service（Recovery 固定 Standard）并无条件安装同一组覆盖，不能重新暴露 SDK local tools。未提供 approval broker 时风险动作默认 deny，Workflow authority 未提供时同样 deny。Bash 的 `timeout` 与调用方 AbortSignal 原样传给 service，超时或取消会杀死 detached child 的整个进程组。

YOLO 确认由 startup-runtime 的 one-shot broker 管理，公开接口是 `grantOnce(source)`、`consume()` 与 `cancel()`。TUI 只在真实 Policy Panel 的 YOLO Enter 输入链路授予 `tui`，service 的紧邻 `switchPolicy("YOLO")` 消费后立即失效；close/cancel、其他 Policy 输入、失败、dispose 与 marker-only 事件都清空或无法获得授权。CLI flag 只在最终 startup policy 确实为 YOLO 时创建一个 `cli-startup` pending grant，启动切换消费后同一进程内再次切 YOLO仍需新的 Panel 确认。Recovery broker 始终不能通过 service acknowledgement。

`--recovery` 在任何 `--policy`/`--trust-project` 之前生效，固定 `Standard · Sandboxed`、空 network allowlist、`trustedProject:false`、`global-only`。VSPi project Policy/settings/Provider/defaults 不读取；Pi services 同时使用 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`。该 trust 否决也在 PiRuntimeBackend 内部执行，`recovery:true` 会压过任何冲突的 `trustedProject:true`，使初始和后续 replacement runtime 的 `trustedWorkspaceRealpath` 都为空。Splash 和状态区显示 Recovery，不能从 Policy Panel 切走。

Workflow bootstrap 使用 TypeScript adapter 包裹同进程 ESM JavaScript Core。正常启动的 loader 以绝对安装根、原始 portable archive、accepted source commit、archive SHA-256、bundle manifest SHA-256 与 runtime manifest SHA-256 为一组不可拆分的 identity 输入；import 前验证 release descriptor、manifest identity、全部声明 Core 文件和 materialized runtime dependency 字节，要求 bundle manifest 绑定 descriptor/Core root export，并拒绝 `node_modules` 未声明文件或 symlink；import 后检查 `createDeliveryStore`、`createWorkstreamStore`、`compileVspiIntegrationContract`、`parseVspiIntegrationContract`、`verifyPortableBundle` 和 Host Contract v1。`/plan` 在 M1 只读展示真实 foreground Delivery、revision、status、plan hash 与 Milestone；没有 Receipt-bearing mutation surface 时 authority 一律 deny。Recovery 在 loader/env discovery 之前分叉，永不读取或导入 Workflow bundle。

边界必须按字面理解：`Sandboxed` 是 VSPi ExecutionPolicyService 子进程的 bwrap 边界，不是 Pi provider/runtime 的 sandbox 声明。Safe/Standard/Auto 只读挂载运行时系统目录和请求的 executable；Standard/Auto 网络通过 spawn 前 allowlist 决定是否 `--share-net`，bubblewrap 本身没有目标级 egress filter。获准进程的网络偏离、用户态 path check 与 syscall 间的 TOCTOU，以及非 Linux 平台 sandbox backend，都是剩余风险，不得隐藏。

Question 已注册为 Pi 的真实 TypeBox `question` ToolDefinition，并在初始及 replacement runtime 中与 Policy tools 一起安装。弹出后顶部显示 `第 n/m · 已答 x · 跳过 y`；四种题型支持“其他”、直接回答、跳过和最终检查，填空输入位于 Question 工作区内部。`Left/Right` 切题，`Up/Down` 选择，`Ctrl/Alt+Up/Down` 排序，`Tab` 直接回答，`Shift+S` 跳过，`Enter` 确认/提交；hint 只显示当前状态可用动作。Tool result 只返回 question id、answer/skipped，取消、Session replacement 与 dispose 都 fail closed。

Settings 的 global/project 持久化遵守项目 trust 边界。`reducedMotion`、`bridgeEnabled`、Theme、`showThinking` 与 `wrapCode` 已接入运行时；未 trust 或 Recovery 时仍只读取 global settings。

## 升级边界

`pi-tui` 负责终端 I/O、差分更新、宽度算法、Editor/IME 和图片协议；VSPi 负责主题、布局、Markdown 规则、业务状态与面板。`pi-coding-agent` 只经 `ChatBackend` adapter 进入应用。上游升级必须保持 adapter contract，并重新运行完整 check/test/build/smoke、真实 SDK 启动和 80×24 PTY 检查。
