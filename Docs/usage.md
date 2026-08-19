# VSPi 使用细节手册

本手册承接 README 移出的行为、配置与安全细节。快速上手见 [README.md](../README.md)，界面设计规范见 [tui-v1.md](tui-v1.md)，开发验证方法见 [testing-and-debugging.md](testing-and-debugging.md)。

## 环境与启动

### 首次配置与凭据管理

```bash
vspi config          # 首屏固定显示 VSPLab（https://api.vsplab.cn/v1）与“自定义中转站”
vspi login kimi-coding   # 优先使用 Kimi Code / Coding Plan 订阅登录
vspi config custom   # 添加自定义中转站
vspi login           # 在 Provider 面板中选择账号登录或 API Key
vspi logout kimi-coding
```

`vspi init` 在 v1 中保留为兼容 alias，并提示迁移到 `vspi config`。

自定义流程依次输入名称、Base URL、接口类型和 API Key，文本与 Secret 输入都支持终端 bracketed paste；Secret 粘贴只显示圆点，粘贴内换行不会触发提交。流程优先从 `<Base URL>/models` 读取模型目录；端点不支持模型发现时，再要求手动输入一个或多个模型 ID。Provider 元数据原子保存到 Pi global `models.json`，API Key 单独交给 Pi `AuthStorage`，不会写入模型配置。

`/login` 与 `/logout` 在交互会话内提供同样能力。认证方法来自 Pi 的 Provider 元数据：支持 OAuth/订阅的 Provider 显示账号登录，同时支持 Key 的 Provider 也显示 API Key；只支持环境配置的 Provider 不伪造输入框。Kimi Coding Plan 使用 RFC 8628 设备码授权：终端展示可点击的授权地址并自动轮询结果，不依赖本机 callback server，成功后自动刷新 Token。凭据由 Pi 的 `AuthStorage` 写入 `~/.pi/agent/auth.json`，目录和文件分别使用 `0700`/`0600`、带文件锁；VSPi 不自行解析、复制或记录 Secret。API Key 输入只显示圆点，`Esc` abort 当前认证层。

VSPi 沿用 Pi 的模型、Provider、凭据和 session 目录，不另建 Secret Store，也不提供通用 Secret Manager。Fixture 只能通过 `VSPi_FIXTURE=1` 或等价的 `VSPi_BACKEND=fixture` 显式启用。

### 启动选项细节

- `vspi continue`（等价 `npm run dev -- continue`）续接最近的会话。
- `--trust-project` 显式信任当前项目，仅绑定启动时 workspace 的 realpath；trust 不通过环境变量自动授予，也不会在 Session 切换到其他 cwd 时继承，无 flag 时项目 Provider overlay 与 `.vspi/settings.json` 不读取。
- `--recovery` 无条件覆盖 `--policy`、`--trust-project` 与 `--workflow`，强制 `Standard ⋅ Host`，拒绝需提升审批的工具、global-only settings/models，完全不读取项目 Policy 配置；Pi ResourceLoader 同时禁用 extensions、skills、prompt templates、themes 与 project context files，界面明确显示 `Recovery`。它不加载 Workflow Adapter，也不叫 `--safe`。
- 后端模式：默认真实 Pi 启动新会话，缺少模型或凭据时显示 setup error，不回退 Fixture。

### 模型选择器与主题

模型选择器使用小型展示目录，不把 Pi 的完整模型库倾倒给用户。当前展示 GPT 5.4/5.5/5.6；最新 Haiku、Sonnet 4.6/5、Opus 4.6/4.7/4.8/5、Fable 5；Kimi K2.6/K2.7/Code/K3；MiMo V2.5；DeepSeek V4；GLM 5.1/5.2；Qwen 3.7 Max/Plus 与 3.8 Max Preview；MiniMax M2.7/M3，以及这些系列在目录中的变种。不存在的型号不会伪造，用户自定义 Provider 的模型不受内置目录筛选影响。

主题设置真实支持 `VSPi Dark`、`VSPi Light` 与 `Terminal`。默认 `Terminal` 不写死前景或背景色，使用终端自身颜色并避免代码块黑字/深色底；Dark 和 Light 是明确选择的固定调色板。

## 启动与默认界面

启动序列会先立即写出一行 VSPi 初始品牌占位，它不含 Logo、运行状态或模型声明；最终帧等待应用初始化完成。应用只清理一次当前 viewport，并把保留现有六行块字符 Logo 的最终状态帧作为统一 TUI 瀑布的第一个内容块，不播放多段进度动画，也不制造一整屏换行。最终帧使用初始化后解析得到的真实 Model、`package.json` 解析出的包版本、真实 Backend 与执行 Policy。真实 pi 显示 `Backend Pi`，显式离线后端显示 `Backend Fixture`；执行边界统一显示 `Policy … · Host`，Policy 只控制审批强度，Backend 与 Policy 是两项独立元数据。

默认 `regular` 把 Splash、Transcript、面板、Composer 与 Status 放在同一物理瀑布中，通过原生 terminal scrollback 保存稳定前缀，并过滤 redraw 中的 `CSI 3J`。Settings 可切换到 `fullscreen`；fullscreen 使用 Pi 0.84 的 alternate screen，Transcript 位于独立 `ScrollView`，Panel、queued/activity、Composer 与 Status 组成固定 dock，`PageUp/PageDown`、`Home/End` 和鼠标滚轮只移动 Transcript。切换 renderer 不替换当前 Session、draft 或焦点，退出时恢复原屏。`VSPi_TUI_MODE=fullscreen|regular` 可仅为本次启动覆盖持久设置。Splash 每个进程只出现一次；`/new` 和 alias `/clear` 不重播 Splash。

在 regular 中，内容触底后才通过 linefeed 推入原生 scrollback；不得用顶部 padding 固定 Composer。regular 的 resume 会把恢复的完整历史写入原生 scrollback；stable-commit 前缀校验失败时在固定重试后重建渲染面再提交，不再静默丢弃未提交内容。

默认的新工作区动态界面为空，不加载或预置对话、工具消息、演示计划、usage 或 session；文档中的对话和工具消息一律标为“交互示例”，不是启动内容。空 Plan 只保留安静的标题与留白，不展示 Workflow 缺失、未初始化或“当前计划为空”之类的提示；离线后端明确标识为 `Offline Fixture`。

### 状态栏布局

`80` 列状态固定为两行，并且每行可见宽度严格为 80 列：

```text
+ Plan ‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒+
❘                                                                              ❘
+‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒+
```

```text
Model OpenAI / GPT-5.4  Effort High                     Context 50K / 128K 39%
/workspace/vspi ⋅ Policy Standard ⋅ Host            Token ▴12k ▾3.0k  Cost ¥1.01
```

动态状态区只包含两条语义轨道：第一行严格为 `Model / Effort / Context`；第二行直接从路径值开始，再显示 `Policy / Token / Cost`，不显示冗余的 `Path` 标题。Backend 只保留在永久 Splash 与诊断信息中，不进入动态行。五个标签与对应值、以及无标题路径值分别着色，不把整行统一处理为弱文本。80/120 列的路径 flex 区从右侧保留完整 `Policy <name> ⋅ Host` suffix；只有 Model 和路径变量值可以显示省略号，Effort、Context、Policy/Boundary、Token 与 Cost 不截断。

`Context` 明确定义为当前上下文占用、模型窗口和百分比，`Token` 则是独立的累计输入/输出量。三个状态例子分别是活动会话 `Context 50K / 128K 39%  Token ▴12K ▾3K`、空容量 `Context 0K / 0K 0%  Token ▴0 ▾0`，以及压缩后尚无法估算的 `Context ?K / 128K ?%  Token ▴12K ▾3K`。`K` 使用十进制千 token：10K 以下保留一位小数，10K 及以上显示整数；百分比始终由未格式化的原始占用量与窗口计算。

Status 在 40、80、120 列都恰好两行，并按终端可见列而不是原始 ANSI 字节计算。Model 与 Effort 使用固定两个空格的小间距并组成连续左侧轨道；空间不足时只截断 Model，Effort 保持完整。80/120 的固定右轨从内容预算反向排布：Context 为 24 列并可为批准最大值扩到 25 列；Token 为 18 列，Cost 为 10 列并可扩到 13 列。剩余空间交给 Model/Effort 组合区和无标题路径 flex 区，因此长身份只截断自身，不会覆盖或推动右侧字段。代表最大值 `Context 999K / 1000K 100%`、`Token ▴999k ▾999k`、`Cost ¥9999.99` 必须完整显示。40 列仍严格保持两行、五个标签与直接路径值，可省略 busy/mode、Context token 细节、Token 输出；无法容纳的高位 Cost 显示明确的 `Cost ...`，不冒充未知值 `?`。顺序不变且每行不超过 40；永久 Splash 已记录完整 Backend 真相。

Status 的短模型样例左右锚是：80 列第一行 `Model 0 / Effort 24 / Context 56`、第二行 `路径值 0 / Token 52 / Cost 70`；120 列第一行 `Model 0 / Effort 24 / Context 96`、第二行 `路径值 0 / Token 92 / Cost 110`；40 列使用原生 `High` 时第一行是 `Model 0 / Effort 13 / Context 25`，第二行是 `路径值 0 / Token 20 / Cost 32`。Effort 的位置随 Model 与原生档位名的实际宽度变化，但两者始终只隔两个空格；Context/Token/Cost 的右锚不受 Model 或路径长度影响。长路径只截断自身，不会推动 Token/Cost；批准最大值会让 Context/Cost 固定区向左扩展。

### 消息与 Transcript

用户消息使用焦点色竖标和至少三行的全宽表面，短消息也保留上下留白，不绘制额外 frame。`VSPi Dark` 使用 `#202428`/`#F4F7FA`，Light 使用对应浅色表面，默认 Terminal 不强加前景或背景。40 列、80 列和 120 列下硬换行、长单词和附件摘要都保持宽度安全；Transcript Inspect 只改变选择态，不改变消息尺寸。

Fullscreen Transcript 保留最近最多 80 个内容块和 60K 字符，由 upstream viewport 显示其中一屏；tail-follow 只反向读取这个有界后缀，10K 事件 redraw 不扫描完整历史。进入 Inspect/锚点浏览时再使用精确历史索引。Regular Transcript 继续使用最多三个终端高度的活动瀑布窗口；稳定前缀越过 viewport 后只做坐标 rebase 并留在原生 scrollback。两种模式的完整 Session JSONL 都不会因 UI 窗口或模型 compaction 删除。逐消息/工具组缓存用于 live 渲染，运行中的 Tool 组实时展示，完成后是否收束由 Settings 控制。

## 交互细节

### 命令目录与补全

单独输入 `/` 会在原 Plan 区域打开完整命令目录，slash 和所有完整命令 cell 都不高亮或强调。`/compact` 在未绑定 Local Plan 时默认使用 Pi Native，绑定 Plan 时默认使用 Execution Continuity。使用 `/compact --list` 检查四种手动 profile；也可显式选择 `native`、`continuity`、`research`，或使用 `/compact custom <instructions>`。自动 threshold/overflow 压缩仍保持 Pi Native；统一配置自动压缩 profile 留待后续版本。

退出候选显示为 `quit (exit)`。canonical `/new` 的 alias 是 `/clear`；`/sessions` 的 aliases 是 `/session` 与 `/resume`；`/providers` 的 alias 是 `/provider`；`/policy` 的 alias 是 `/permission`；canonical `/quit` 的 aliases 是 `/exit` 和 `/q`，输入 alias 时显示 `/exit  (/quit)`，canonical 注释使用弱化灰色。`/thinking`、`/login` 与 `/logout` 是 canonical 命令。插件/扩展命令保留 package `source` 来源，而内置命令显示 Built-in。

`Tab` 是唯一补全键，只处理无参数的单一 slash token，并且必须只有唯一候选：`/ex ⟶ /exit`，其可见结果只强调 `ex`，斜杠与 `it` 保持普通；`/qui ⟶ /quit` 只强调 `qui`，斜杠与 `t` 保持普通；`/ses ⟶ /sessions`、`/provi ⟶ /providers`、`/cl ⟶ /clear`。存在参数、普通文本或多个 token 候选时不改写。`Tab` 只修改 composer 文本，不会执行命令，也不写入 history；最终执行始终使用 canonical 命令身份。若两个不同 canonical 命令注册了同一个 exact alias，解析和面板 Enter 都会 fail closed，不会静默执行注册顺序中的第一项。composer 中的 slash token 与 Command 候选中的匹配前缀同时使用颜色和粗体、下划线、反显（bold / underline / inverse），因此无色终端仍可辨认，普通文本不受影响。

Command 工作区在 40 列把每个命令排成身份行与详情/source 行，滚动时两行保持成组；80 列和 120 列使用稳定的“身份 / 描述 / source”三列。三档 Command 与 Status 都按终端可见列宽计算，不使用特殊全角填充。

每个已接入工作区都有 contextual hint。hint 位于面板 frame 外，并直接位于 composer 上方；Command 的完整提示是 `▴▾ 选择  Tab 补全  Enter 执行  Esc 关闭`。Plan、Provider、Sessions、Settings、Usage、Theme、Question 和 Model 按当前真实可用动作生成提示；未来工作区接入前不得宣告无效键位。

### 键位与运行控制

- `Enter` 空闲时提交；工作中作为 Steer 插入，在当前工具批次结束后、下一次模型调用前送达。
- `Shift+Enter` 或 `Ctrl+J` 换行。
- 空输入时 `Tab` 或任意 Composer 状态下 `PageUp` 进入 Transcript Inspect；方向键逐项选择，`PageUp/PageDown` 按页浏览。
- `Shift+Tab` 在 Composer、Transcript 与 Plan 之间循环；Transcript 为空时跳过。
- `Alt+Enter` 将消息作为 Follow-up 提交；工作中会等 Agent 完全空闲后送达。
- `Esc` 在主界面中断当前运行，`Ctrl+C` 保留同样的直接中断；空闲时 `Ctrl+C` 退出。

Agent 从首次提交到真正 idle 期间显示所选 Working 样式：`1` 为独立小方块行，`2` 为 Composer 顶边大圆，`3` 为大圆加三单元 Braille 思考格，默认 `3`；Global/Project 两级持久化，reduced motion 保留样式但停止形状动画。尚未送达的用户消息不进入 Transcript 或 Inspect，而是在 Working 下方显示一行弱化内容和右侧 `↪`；`queue_update` 表明消息已被消费后，它立即进入普通用户消息瀑布流。ESC 只 abort 当前运行，不创建或切换 Session，不删除已经发送的用户消息、partial thinking/text/tool，也不覆盖输入框中的未提交草稿；运行中的 Tool 收束为 cancelled。如果原生 Steer/Follow-up 队列尚有消息，VSPi 会按原顺序取回并立即作为新的 prompt 继续执行，不会停在输入框等待用户再次 Enter。

Question、Approval、Inspect、Preview 与普通面板打开时，Esc 先关闭当前交互层；回到主 composer 后再次按 Esc 才中断运行。保存结果和短时状态临时替换固定 contextual hint 行，约 3.5 秒后恢复；不创建 overlay、不改变布局高度，也不抢占 composer 焦点。

### Question 工作区

Model、Provider、Sessions、Settings、Usage、Theme 和 Question 共用底部工作区，不叠加多层弹窗。VSPi 自有 `question` 通过 Pi ToolDefinition 接口注册，支持单选、多选、排序和填空；模型发起调用后会等待用户在动态 Question 工作区完成最终检查。Question footer/contextual hint 与主 Composer 之间固定保留一行 interaction gutter；等待回答时不伪造 Working 动画，也不靠固定底部布局制造间距。`Left/Right` 切题，`Up/Down` 选择，`Ctrl/Alt+Up/Down` 调整排序，`Tab` 直接回答，`Shift+S` 跳过，`Enter` 确认或提交。取消、Session replacement 与应用退出都会以 `AbortError` 终止 pending Question，不把 prompt、选项说明、路径或 secret 样式文本写回 tool result。

审批 Panel 与模型主动调用的 Question 完全分离。Question 使用进度元数据、粗体标题、正文、分隔线、选项标题与次级说明建立层次；它本身也作为 `Question` Tool 节点出现在瀑布时间线中。Markdown 标题使用内容蓝色前景与字重建立层次，不增加背景块，也不复用运行状态色。Question、审批、Effort、Settings、预览和 Inspect 中的 Esc 先退出当前界面；回到主界面后 Esc 才中断当前生成或工具，Ctrl+C 保留直接中断。取消后的 generation 事件保持隔离到下一次主动发送，迟到的 retry、文本和 Tool 事件不能重新进入 Transcript；运行中的 Pi Bash 同时接收 AbortSignal 并终止子进程组。取消不会重置 Session 或回滚已显示的瀑布记录。

### Goal Runner

`/goal <request>` 创建一个绑定当前 Session 的持久 Goal，并立即开始执行。可在 request 前设置 `--rounds N`、`--no-progress N` 和 `--tokens N`；默认分别为 24、3 和 500000。`/goal` 或 `/goal status` 打开状态面板，`/goal pause|resume|cancel|accept` 执行明确的用户状态转换。Goal Contract 保存完整原始 request 和完成约束，模型只能通过 `goal_checkpoint` 记录进度、通过 `goal_block` 声明真实阻塞、通过 `goal_complete` 携证据进入待验收；模型没有修改 Contract 或自行 accept 的工具。

执行中的 Goal 在普通 assistant final 后使用 Pi 原生 Follow-up 继续，不递归调用 VSPi send。阶段总结、Local Plan 更新和 marker 都不是完成条件。达到轮次、token 或连续无进展边界时分别进入暂停或 stalled，不伪造完成；结构化阻塞、用户暂停/取消、Session 中断、进程退出、owner 丢失和待验收都会停止自动生成。重启、fork 或 handoff 后只恢复落盘状态，不自动重新发起模型请求，必须显式 `/goal resume` 获取当前 Session 的唯一 execution owner。Goal 与 Local Plan 均按 workspace 隔离，Recovery 和只读 Workflow 模式不启用 Goal runtime。

### 自更新

`/update` 与 CLI 的 `vspi update` 使用同一条自更新链路：从 VSPi 公共 GitLab Release 查询最新稳定 SemVer，要求固定项目、tag、tarball 名称与下载地址完全一致，下载后按 Release 中的 SHA-256 校验。自更新会识别当前命令由 Volta 还是 npm 管理，更新同一安装位置并复验当前包版本；不会再把另一份全局安装成功误报为当前命令已更新。已经是最新版时不会重复安装；更新成功后可用 `/reload` 平滑重启生效。`/reload` 在会话空闲时启动新进程续接当前会话（复用同服务器前台迁移机制），用于更新后生效或修改 VSPi 本体配置后加载；运行中会被拒绝。CLI 侧 `vspi -c` / `vspi --continue` 等价 `vspi continue`，`vspi -r` / `vspi --resume` 等价 `vspi resume`。

### 同服务器前台迁移

同一台服务器上的每个 Pi Session 只允许一个执行 owner 和一个可交互前台。Sessions 面板把其他进程持有的会话标为“使用中”，选择后可迁移前台、从最后一个完整回复创建分支或取消。普通接管不会 abort 旧任务：新 TUI 立即成为唯一交互前台，以正常主界面接收旧 runtime 的完整快照和实时输出；旧 TUI 显示“已在另一终端继续”后停止读取输入，但旧进程暂时保留不可序列化的 Pi runtime，直到当前 generation、工具或压缩结束。新前台在此期间发送的普通消息通过 `0600` Unix control socket 存入旧 owner 的等待队列，不会进入当前 generation；安全点到达后按顺序执行。新前台按 Esc 才会通过同一控制通道明确中断旧 runtime，随后继续处理已接受的等待消息。

pending 或随后出现的 Question/Approval 会迁移到新前台，回答仍回到旧进程原有的工具 Promise。所有活动和等待消息结束后，旧 owner 把 lease 原子改写给唯一指定的 successor，再退出；其他终端只能观察新 owner 并串行请求下一次迁移，不能争抢空锁或同时回答交互。新前台在安全点前断开时，旧 TUI 恢复，pending 交互重新弹出，已经被 owner 接受的等待消息仍会执行。`vspi continue` 遇到占用时采用同样机制。普通退出不在后台继续任务；恢复只加载已落盘内容，不重连旧请求、不自动重试。锁只保证同服务器进程，跨服务器共享目录不在 v1.0.0 的支持范围内。

## 历史会话导入

`/import` 或 `vspi import [codex|claude]` 会打开原生终端导入面板。Codex 来源于 `~/.codex/session_index.jsonl`、`~/.codex/sessions/**/*.jsonl` 和 `~/.codex/archived_sessions/**/*.jsonl`；Claude Code 来源于 `~/.claude/history.jsonl` 与 `~/.claude/projects/**/*.jsonl`。两者未进入索引的用户主会话也会被发现，Codex subagent rollout 和 Claude Code `agent-*` 记录不会出现。

导入是一次 Enter 完成的结构化快照复制，不会修改或接管源文件，也不进入 Question 的“提交答案”复核。VSPi 按读取开始时的文件字节边界解析已完整写入的 JSONL 记录，把用户消息、助手 Thinking 与最终回答转换为原生可见 Session 历史；工具调用和工具输出完全丢弃，不展示、不进入模型上下文。新 Session 保留导入时正在使用的 VSPi 模型与 Effort；模型上下文优先使用 Codex 最近的 compaction checkpoint 及其后正文，否则按当前模型窗口截取最近可见正文，完整可见历史仍可在 Transcript 中查看。system/developer prompt、权限状态与内部控制记录不会进入导入结果；API Key、Bearer Token、password 等常见凭据在落盘前脱敏。读取后若源会话的可见内容已经变化，导入会拒绝本次快照并要求重试；旧版 30 MB reference blob 会在 Provider context 边界被兼容过滤。

确认框显示对话数、工具记录数和 token 估算。估算量超过当前模型窗口 80% 时会警告，但不会静默截断；首次继续对话时可能由 Pi 触发压缩。导入成功后会创建并切换到新的原生 VSPi Session，源会话始终保持不变。

## Subagent 与 Teammate

### 原生 subagent

普通 Pi runtime 注册原生 `subagent` 工具。每次调用必须提供一个 `task`；并行委派通过同一轮发出多个 `subagent` 调用完成。Task Agent 使用 in-memory Session，默认只收到 `task` 和显式 `context`，不会保存完整 Session 或复制父对话；只有调用参数明确设置 `inherit_parent_context: true` 且 child 与 parent 属于同一 Provider 时，才传递经过凭据、授权字段、图片数据和大块编码内容过滤的父上下文。跨 Provider 委派必须由受信项目显式开启，并且仍只发送 `task` 与显式 `context`。`instructions` 追加角色约束；`system_prompt` 只可用于临时 Task Agent，不能替换 Teammate 的持久身份。主代理可从当前真实模型目录显式选择 `model`，递归子代理只能选择 `orchestrator/researcher/analyst/worker` 角色，由当前 Provider 的 Agent Pool 映射实际模型。未配置项目 Teammate 时，工具 schema 不暴露 `teammate` 或 `lane`。

递归默认开启，但子代理不接收任意模型字符串：GPT Pool 自动把协调、研究、分析和快速任务映射到 Sol/Luna/Terra；DeepSeek Pro/Flash 与 Kimi K3/K2.6 这类双层目录会让多个强角色复用 Pro/K3，并把 `worker` 映射到 Flash/K2.6。默认最大深度 3、每棵树 12 个 Agent、每个节点 3 个直接子节点、全局 16 个 generation；受信项目硬上限分别为 5、128、16。默认每次 run 最多 120,000 tokens / 900 秒，每棵 tree 最多 500,000 tokens / 20 USD；Provider 无法在生成中精确截断 token 时，完成的当前响应可能产生一次有界超额，但不会再启动 fallback、follow-up 或 descendant。共享 workspace 采用跨进程单写者边界：读取可以并行，所有 Bash 与 `edit/write` 的实际执行串行；root cancellation 会终止 active 和 queued descendants。

`/agents` 打开 Agent Map；`Up/Down` 选择节点，`Left/Right` 在父子节点间移动，`Enter` 进入节点 Timeline，`Tab` 切换 `Map / Timeline / Tools / Pools`，`Esc` 先返回 Map、再关闭。Timeline 是最多 32 条固定类型事件和 4K 字符脱敏输出 preview，不冒充完整对话；只有持久 Teammate lane 的真实 Pi Session 历史才称为 Transcript。Map/Timeline 展示 run/tree/parent ID、Provider/model、context 来源与字符数、usage、剩余 run/tree budget、required override scope 和 lane owner。主 Transcript 中每个 Subagent 使用独立状态框，展示角色、实际模型、任务、状态、剩余预算和流式预览。Pool 自动从真实模型目录生成；可信项目可执行 `/agents pool <provider> <role> <provider/model>` 覆盖一个角色，同 Provider 是默认边界，跨 Provider 必须在项目配置中显式开启。

### Teammate

Teammate 是受信项目内的持久角色，定义位于 `<workspace>/.vspi/agents.json`。角色身份、提示词、工具、routing 与 preferred model 持久，普通模型工具不能直接修改这些控制文件；每个 `lane` 使用 `<workspace>/.vspi/agent-sessions/<teammate>/<lane>` 下的独立 Pi Session 历史，并以跨进程 lease 防止 prompt、reset 或 model switch 并发破坏历史。获得 lease 后会重新读取当前配置和最近 Session，避免复用 stale cache。VSPi 只暴露能力、当前状态、用户策略和系统边界，不注入 Research/Plan/Implement/Audit 一类工作流教程。`required` routing 会在匹配项尚未由正确 Teammate 成功完成时阻止主代理写入和结束本轮；`preferred` 是默认路由提示，`consult` 是非阻塞咨询提示，`manual` 只在调用明确指定时使用。required override 只能通过 `/agents override <teammate|all> [turn|session]` 建立，不从自然语言关键词推断。

```json
{
  "version": 1,
  "maxDepth": 3,
  "maxAgentsPerTree": 12,
  "maxConcurrency": 16,
  "maxRunTokens": 120000,
  "maxTreeTokens": 500000,
  "maxTreeCostUsd": 20,
  "maxRunSeconds": 900,
  "allowedModels": ["*"],
  "crossProviderDelegation": false,
  "modelPools": {
    "vsplab": {
      "roles": {
        "orchestrator": "vsplab/gpt-5.6-sol",
        "researcher": "vsplab/gpt-5.6-luna",
        "analyst": "vsplab/gpt-5.6-terra",
        "worker": "vsplab/gpt-5.6-terra"
      }
    }
  },
  "teammates": [
    {
      "id": "frontend",
      "role": "Frontend",
      "description": "Own frontend planning and implementation",
      "routing": "required",
      "match": ["frontend", "前端"],
      "systemPrompt": "You own the frontend role for this project.",
      "tools": ["read", "ls", "find", "grep", "bash", "edit", "write"],
      "preferredModel": "kimi/k2",
      "effort": "high",
      "fallbackModels": ["openai/gpt-5"]
    }
  ]
}
```

项目配置只有在 `--trust-project` 下读取；损坏 JSON、额外字段、symlink scope、非法模型或工具都会 fail closed。子代理文件工具拒绝 workspace 外路径和 symlink escape；Bash 在 Linux `bubblewrap` 中运行，使用空 HOME、清理后的环境和 workspace 单独可写挂载，缺少 `bwrap` 时 fail closed。Recovery 完全不注册 `subagent`。子代理不能创建、删除、重置 Teammate，也不能修改其模型或 lane。

只有确认是额度耗尽的错误才会尝试 `fallbackModels`；普通 429、网络、认证或一般模型错误不会触发 fallback。失败 attempt 的 usage 同样计入 tree budget。Teammate fallback 会把 `currentModel` 与原因原子写回配置并保持 sticky，不探测首选模型、不自动恢复。主模型会收到结构化 tool result 和 warning notice，Transcript 与 `/agents` 同时显示角色、实际模型、选择原因、Effort、lane、任务和 fallback。用户可显式执行 `/agents model <teammate> <provider/model>`、`/agents reset <teammate> [lane]`、`/agents pool <provider> <role> <provider/model>` 或 `/agents override <teammate|all> [turn|session]`；项目配置写入都要求 `--trust-project`。

## Skill 管理

`/skills` 或 `vspi skills` 打开原生终端 Skill 工作区，按“已启用 / 可导入 / 问题”查看、搜索和管理目录。VSPi 以 Pi Native `ResourceLoader`、`SettingsManager` 与 `DefaultPackageManager` 为真相源；`~/.codex/skills` 和 `~/.claude/skills` 中现有 Skill 只登记原始 `SKILL.md` 路径，不复制、不改写源文件。宽屏使用列表/详情双栏，窄屏用 Enter 进入详情、Esc 返回。

`+` 支持 Git URL 与 `npm:package`，也可切换到“让 Agent 帮我找”，后者会作为普通用户消息提交。安装前必须通过 Question 选择“安装并启用 / 仅安装 / 取消”；启用、停用、更新和移除同样逐次确认。受管包固定 `autoload: false`，extension、prompt、theme 全部禁用，只登记实际发现且位于包目录内的 `SKILL.md`。安装或持久化失败会回滚本次新装内容，不删除原有包；来源和错误输出不回显 URL 凭据。

模型可用 `skill_list` 只读检查目录，并用 `skill_manage` 提议安装、启停、更新或移除；所有 mutation 仍进入同一套 Question 确认。资源变更后会刷新 Pi ResourceLoader，并重建当前会话下一轮使用的 Skill system prompt。MCP 不属于 `0.6.0`，仍在 `/tools` 中显示 `Not connected`。

## Model 与 Provider

出厂内置 VSPLab 中转站 Provider（`https://api.vsplab.cn/v1`，OpenAI Responses 协议）；可通过 `vspi login` 交给 Pi 安全保存凭据，也可设置环境变量 `VSPLAB_API_KEY`。Provider 面板与模型列表按 VSPLab、DeepSeek、Xiaomi（MiMo）、Kimi、GLM（Zai）、MiniMax、OpenAI、Anthropic 优先排序，其余按字母序。Model 列表按 Provider 显示标题与模型数量，组内按显式发布日期或模型 identity 中的代际从新到旧排序；同代模型按输入、输出 USD 单价之和从高到低，再按名称与 id 稳定排序。超长标题只截断标题本身，不挤占右侧数量。没有可用角色预设时隐藏“模型组”页及对应 Tab 提示。

Model 列表来自当前 Pi `ModelRuntime.getAvailable()`，不再使用生产 hard-coded catalog。选择模型会先 await `session.setModel()`；成功后才更新 Model、vision、Context、Profile model identity 和 UI，失败保留原状态。`/effort` 直接读取当前模型的 `getAvailableThinkingLevels()`，只显示该模型支持的 `Off / Minimal / Low / Medium / High / Xhigh / Max` 子集；展示名首字母大写，持久值保留 Pi 原生小写名称。VSPLab GPT 5.4 支持到 Xhigh，GPT 5.5 不提供 Minimal，GPT 5.6 系列支持到 Max；这些差异通过 `thinkingLevelMap` 原样注册到 Pi runtime。Enter 应用、Esc 取消，不再循环切换或立即落盘；旧中文低/中/高配置在读取时迁移为 low/medium/high。成功提示只报告当前 Model/Effort，不显示配置文件路径。外层 60 列及以上使用左列表/右详情；窄屏使用显式列表/详情导航。单模型 CNY 输入、输出单价仅显示在右侧详情，模型组不显示价格，也不显示汇率参考行。

Provider Enter 只打开本地 action menu，不会隐式验证。`check-config` 只校验 schema、URL、协议和模型，不发网络；`test-connection` 是显式网络动作；`minimal-generation` 必须在面板内再次按 Enter 确认费用。编辑器只包含名称、Base URL 和协议，只有 `Ctrl+S` 保存，Enter 不保存。

Provider catalog 按 built-in、Pi global `models.json`、trusted project `.vspi/models.json` 合并，模型按 id 稳定 override。项目默认不受信任；只有命令行显式传入 `--trust-project`，VSPi 才以 `SettingsManager.create(..., { projectTrusted: true })` 为启动时 workspace realpath 启用项目资源。该 trust 不通过环境变量自动授予，也不会在 Session 切换到其他 cwd 时继承。无 flag 时项目 Provider overlay 和 `.vspi/settings.json` 不读取，Provider、project settings 与 project defaults 的保存都会拒绝；global settings 始终可用。

OpenAI Completions 模型显式声明 `compat.supportsStrictMode=false` 时，VSPi 在 provider request 边界从工具 schema 的 wire copy 中移除 `min/maxLength` 与 `min/maxItems`。原始 TypeBox schema 仍用于 host-side 工具参数校验；该兼容层避免 llama.cpp 把大型嵌套边界展开成超过阈值的 GBNF grammar，同时不会改变其他 Provider 或工具的结构、required 字段和执行权限。

项目层禁止 API key、token、secret、credential、命令值和敏感 header；Provider/model 协议必须映射到四个原生协议，模型 input 只能是包含 `text` 的非空 `text/image` 集合。Provider 编辑器保存新 protocol 时会移除同一项目 Provider/模型上的旧 `api`；runtime 的确定性优先级是 `protocol > api`，因此旧 api-only 文件仍可导入，而新选择不会被旧 wire API 覆盖。保存使用 canonical SHA-256 expected-hash 并发检查与 0600 临时文件原子 rename。Provider、VSPi settings 与 runtime defaults 的项目路径都会对 `.vspi`、目标、lock（适用时）和临时文件执行 `lstat`，并在 mkdir/rename 前后复验 realpath 仍位于 workspace；symlink scope 会 fail closed。损坏 JSON 会 fail closed，绝不自动覆盖。

## Execution Policy 与 Recovery

Policy 四档表与审批面板概览见 README 的 Execution Policy 小节；本节记录配置与运行细节。

Policy 配置分别位于全局 `~/.config/vspi/policy.json` 与项目 `<workspace>/.vspi/policy.json`，格式只接受 `policy` 和可选的 `networkAllowlist`。CLI 显式 Policy 优先于全局默认；项目文件只有在 `--trust-project` 下读取，并且只能降低 CLI/global 结果。网络范围以全局 allowlist 为上限，项目 allowlist 只能取交集；target 只接受无 userinfo、query、fragment 的 HTTP(S) origin 或 path。配置拒绝 secret、credential、敏感 header 与 `!command`，所有 URL 校验错误和 load diagnostic 都不回显被拒值。项目保存使用 expected hash、writer lock、0600 临时文件和原子 rename，symlink scope 会 fail closed。损坏文件给出有界诊断并回到安全默认，不会被自动覆盖。

审批器提供“允许本次”“本会话允许同类”“提升到最低充分档位并执行”“拒绝”“拒绝并说明”五项决定；例如 Safe 的工作区写入提升到 Standard、Standard 的 SSH 提升到 YOLO、Standard 的删除直接提升到 Auto。本会话规则和提升等级只驻留内存。审批 Panel 在内容四周保留稳定 gutter，选项使用额外缩进；当前 Policy 在类别上方以固定 8 列的背景标签显示，Safe、Standard、YOLO 与 Auto 在其中居中，并分别使用绿、黄、橙、红的低亮度语义色。文字始终保留，因此无色终端和色觉差异不会丢失语义。首轮只做粗粒度分类，不承诺识别 Bash 中所有隐藏写操作；后续可以把同一结构化接口交给独立小模型。审计日志不记录环境值，并脱敏 token、secret、password、credential 与 API key 类值。Workflow authority gate 仍保持独立。

生产 Pi Session 启用原生 `read/ls/find/grep/bash/edit/write` ToolDefinition。VSPi 包装器只在原生 `execute()` 前请求审批，批准后完整委托回 Pi，因此保留图片读取、流式输出、秒制 timeout、AbortSignal、输出截断和编辑 diff。结构化 `question` 继续使用 VSPi 自有 schema 与 Panel，只借用 Pi ToolDefinition 接口。普通模式额外注册 `plan_list/read/create/update/archive/bind`；绑定 Goal 时还提供 `goal_status/checkpoint/block/complete`。所有写入使用 workspace-scoped revision store 和 expected revision；Session binding 使用 Pi custom entry。显式 Workflow 模式完全不注册这些 Local Plan 与 Goal mutation，避免双权威。

每轮 `before_agent_start` 都会先要求 Agent 对照最新用户指令检查计划范围、优先级、依赖、阻塞和下一步。无活动 Local Plan 时，只有明显的多步骤、跨多轮或长期任务才应创建并绑定计划；简单问答不建计划。有活动计划时，Agent 在实质进展、阻塞、焦点变化和结束回复前使用结构化工具更新状态。最新指令揭示遗漏或未修 bug 时，即使 Plan 已全为 done，也必须重开或增加修复项；`plan_update` 和 done 只记录进度，不能终止尚未完成的实现与验证。连续性 hooks 还会在四次有效对话、六次工作事件、resume、compaction、重复失败和完成声明时提高复核强度；成功的 Plan mutation 会刷新面板并开启新的复核窗口。当前 generation 内每次成功的 threshold 自动压缩都会注入隐藏 continuation，立即继续同一原任务；overflow 已由 Pi retry、手动压缩、失败或取消时不重复续跑。完成声明与开放 Plan 不一致时仍只记录一次性 checkpoint，供下一次真实用户请求核对，不向普通队列发送独立的 Plan 对账任务。显式 Workflow 模式执行相同检查，但更新只能通过 Hypo-Workflow skill/command 完成。

`/tools` 是只读能力目录，不会向模型发送消息。Files/Search 直接复用 Pi 原生工具；Git 与 SSH 经 Pi Bash 执行并分别进入 `git-write`、`ssh` 审批类别；图片使用 Pi 原生 image read 与 VSPi 附件链路。Browser 与 MCP 当前显示 `Not connected`，不注册会失败的占位模型工具；产品内 Persistent PTY 仍显示 `Deferred`，当前 Bash 是一次性执行，不承诺持久进程所有权。开发测试使用 `node-pty` 与 headless xterm 运行真实 CLI、发送按键、resize 并断言原生 scrollback，不再用内存 Terminal mock 代替端到端终端验证；可用 `npm run test:pty` 单独执行。Tools 面板支持 Up/Down 浏览和 Esc 返回，并在 40/80/120 列保持有界。

当前 Policy 不是 OS sandbox，也不把 SSH、容器或远程系统包装成隔离边界。更细的命令解析、小模型审批、远程目标约束和系统级 containment 属于后续安全加固，不阻塞本轮可用性。

## Workflow Adapter

VSPi `0.6.0` 的 Workflow bootstrap 只读投影 Hypo-Workflow Plan，并且默认关闭。只有显式传入 `--workflow` 才会读取 Workflow bundle identity、加载 Core 并访问 workspace Delivery；默认启动不会读取 Workflow 环境变量或项目状态。Plan 标题在展示层把 slug 分隔符转换为空格、把版本段转换为点号并首字母大写，持久 ID 完全不变；标题、Workflow 元数据、分隔线和里程碑列表形成独立层次。Adapter 是 TypeScript host boundary，加载同一 Node.js 进程中的 ESM JavaScript Core；`.pipeline` 文件只能由 Core API 读写，VSPi 不直接解析或修改 authority YAML/JSON。

Workflow 集成选择“可选、只读 Provider”，而不是无 Workflow 或深度写入集成。普通启动不构造或读取 Workflow Adapter，而是启用 workspace-scoped Local Plan store、Session binding、bounded capsule 与结构化模型工具。显式 `--workflow` 后，Local Plan store 和工具不再构造，Plan 切换为只读 Workflow Delivery 投影，每轮 hook 读取最新 Delivery 并提醒 Agent 使用 Hypo-Workflow 能力维护权威状态。两种模式互斥；Workflow 的 Receipt-bearing mutation 继续由 Hypo-Workflow 自身命令承担。未传 `--workflow` 时界面不出现 Workflow 状态；显式开启后若配置缺失、安装过旧、sibling release、损坏或版本不兼容，`/plan` 显示有界诊断，所有 Workflow authority 请求默认拒绝，普通聊天仍可用。

普通启动需要一个已经 materialize runtime dependency、通过 manifest 校验且与已接受 Core 结果绑定的安装根目录。安装器还要为 `node_modules` 全树生成 `runtime-manifest.json`。六个配置值必须一起提供，semver 相同不代表 bundle 相同：

```bash
VSPI_WORKFLOW_ROOT=/absolute/installed/root \
VSPI_WORKFLOW_ARCHIVE=/absolute/accepted-portable.zip \
VSPI_WORKFLOW_SOURCE_COMMIT=<40-hex-commit> \
VSPI_WORKFLOW_ARCHIVE_SHA256=<64-hex-sha256> \
VSPI_WORKFLOW_MANIFEST_SHA256=<64-hex-sha256> \
VSPI_WORKFLOW_RUNTIME_MANIFEST_SHA256=<64-hex-sha256> \
vspi --workflow
```

Loader 在 import 前验证 archive digest、bundle/runtime manifest digest、release descriptor、source commit、全部 Core 文件与 runtime dependency 字节；manifest 必须绑定 descriptor 与 Core root export，`node_modules` 不允许未声明文件或 symlink。import 后再验证 required root exports 与 Host Contract v1。`--recovery` 在读取上述环境变量之前就禁用 Adapter，因此即使这些值恶意或损坏也不会触发 bundle discovery、import 或项目 Workflow 读取。

0.6.0 不在 VSPi 内注册 `/hw:init`、`/hw:resume`、`/hw:accept` 等 Receipt-bearing 生命周期命令；这些命令继续由 Hypo-Workflow 自身提供。VSPi 只通过 `/plan` 展示可选的只读投影。

## 图片附件

图片附件已接入真实模型提交。本机使用 `Ctrl+V` 或 `Alt+V` 读取图片剪贴板；Linux 只以固定参数调用 Wayland `wl-paste` 或 X11 `xclip`，macOS 使用 `pngpaste`。附件显示为原子节点：

```text
〔登录页-修改前 ⋅ 1440x900 ⋅ PNG〕
```

选中节点后可用 `F2` 重命名、`F3` 预览、`Delete` 移除、`F4` 保存到项目。缓存默认位于：

```text
~/.cache/vspi/attachments/<session-id>/
```

附件缓存跟随真实 Pi session id 切换并恢复；恢复及每次后续读取都会通过 `O_NOFOLLOW` 重新验证 session 目录内的普通文件、canonical path、inode、实际大小、magic 与尺寸。显式 retention API 只清理过期且未保留的 session 目录。所有服务级 store 操作与切换共用串行队列，session/generation 栅栏会回滚已开始但随后过期的 paste delivery。保存到项目会逐级拒绝 symlinked `.vspi`/`attachments`，验证目录 containment，并通过目录内独占临时文件原子 rename；不会使用可跟随 symlink 的 `copyFile`。无 vision 能力的模型会在清空 composer 前阻止带图提交；Pi 在 `prompt` 前通过同一个 verified reader 构造真实 image content，文本 manifest 只含清洗后的 JSON 元数据，不包含缓存路径，并把 alias 明确视为不可信显示标签。

## 配置与费用

Settings 分别显示 Global 与 Project 草稿，只有 `Ctrl+S` 才 Apply，Esc Cancel；切换范围或修改开关不会立即写文件。只有本次启动显式使用 `--trust-project` 时，项目设置才会读取并覆盖全局设置：

```text
~/.config/vspi/settings.json
<project>/.vspi/settings.json
```

`tuiMode`、`fullscreenScrollbar`、`mermaidRendering`、`reducedMotion`、Theme、`thinkingDisplay`、`thinkingTranslationEndpoint` 和 `wrapCode` 均已接入运行时。`mermaidRendering` 支持关闭、完成后或流式转换；宽度不足、无 Unicode、thinking 内容或解析警告会保留为普通 fenced code。LaTeX 由 upstream Markdown 渲染。`thinkingDisplay` 支持隐藏、折叠、展开；Inspect 仍按稳定 message id 查看单条 thinking/tool。Settings 的“思考翻译服务”接受 IP:端口、域名或完整 HTTP(S) URL，只在 Thinking 完成后串行翻译。旧 `showThinking` 会自动迁移；`wrapCode` 控制 fenced code 长行换行或截断，40/80/120 列均保持宽度安全。

默认 Model/Effort 单独保存在无 secret 的 `runtime-defaults.json`。global 总是可用；project 只有本次启动显式授予项目 trust 时才读取和写入。Model identity 始终只保存精确 `{provider,id}`；同 id 的不同 Provider 不会混用。只有 Pi 后端会持久化 runtime defaults，显式 Fixture 不得把 `fixture/offline-fixture` 写入共享默认值。Pi 遇到跨后端、失效或未认证的已保存模型时保留当前可用模型并显示警告，不阻断启动；已保存 Effort 不在当前模型的原生档位集合中时同样保留当前档位。Model 或 Effort 选择成功后按 Settings 当前 scope 原子保存；普通 `/new` 在重建 ModelRuntime 并注册当前可信 overlay 后按 `{provider,id}` 重解析模型，`/new --default` 则不继承旧模型对象，而是重新读取并应用默认值。

项目路径 guard 会在每次关键配置写入前复验边界，但它不是 OS sandbox；并发恶意替换、更强的进程 containment 与远程目标约束留给后续安全 Cycle。

pi 返回的模型价格和 usage 以 USD 为基础。VSPi 内部换算人民币估算；模型组不显示总价，单模型选择页只在右侧详情显示 CNY/人民币输入、输出单价，界面不显示汇率参考行、来源、日期或汇率换算样例行。

## 开发验证细节

VSPi 自有 UI chrome（状态行、面板边框、Markdown 装饰、splash 与附件标记）按已接受的 Unicode 视觉语言绘制：圆角 Composer 边框、block-art splash 与既有语义字形；不支持 Unicode 的终端通过 capability 分支回退到等价窄字符/ASCII。两类路径分别用宽度断言回归，避免在把 ambiguous 按宽渲染的中文终端上出现行溢出与光标错位。

Pi Editor 的长文本性能由 `postinstall` 的版本守卫补丁处理：`scripts/patch-pi-editor-performance.mjs` 只匹配 `@earendil-works/pi-tui` 0.84.2 的确切源码结构，为 grapheme 分段与折行缓存 editor-local 派生数据，并把水平光标移动从全量 visual-line map 改为缓存分段；源码摘要不匹配时 fail closed，升级 upstream 后可删除。交互式会话在 launcher 进程消失时通过 parent-death watchdog 关闭并恢复终端（可用 `VSPi_NO_PARENT_WATCHDOG=1` 关闭）。
## DeepSeek V4 anchored-standard

VSPi 默认对 direct/relay DeepSeek V4 Pro 与 V4 Flash 启用 anchored-standard：
每个 cache epoch 的首个普通请求使用固定 persona 与 `bash`、
`str_replace_editor` 双工具，首次 assistant/tool signal 后恢复完整 VSPi/Pi
prompt 与工具；compaction 或模型切换开启新 epoch。其他模型不受影响。

需要使用普通 VSPi request surface 时，在启动进程前设置：

```bash
VSPI_DEEPSEEK_HARNESS=0 vspi
```

`false` 和 `off` 与 `0` 等价。
