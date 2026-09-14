# 使用与配置

[返回项目首页](../../../README.md) · [版本记录](releases.md) · [开发指南](development.md)

## 会话与后台任务

`vspi` 打开新的交互会话，首次提交时创建会话记录；`vspi continue` 继续当前工作区最近的会话，`vspi resume` 打开会话选择界面。

| 入口 | 用途 |
| --- | --- |
| `/sessions` | 浏览、切换会话与分支 |
| `/agents` | 浏览 Subagent 状态和按时间排列的子对话，不展示 thinking |
| `/tasks` | 查看 Agent jobs、进程与问题，不展开子对话 |

运行中的 Subagent 状态显示在停靠区和 `/agents` 中，不向主对话重复插入活动卡片。子任务可配置独立模型；模型和思考档位的可用性取决于当前 Provider 目录与账号权限。

`Ctrl+B` 可将当前支持的前台任务转到后台。`/quit` 默认只断开前端，不取消工作；`/cancel-and-exit` 取消当前运行并退出。

2.4.1 起，没有前台 IPC 连接、正在执行的 turn/工具/Subagent、活动目标或定时任务时，daemon 在约 5 秒宽限后自动退出，历史和配置保留。可以通过 `VSPI_DAEMON_IDLE_TIMEOUT_MS` 调整宽限，`0` 表示显式保持驻留。后台工作尚未完成时不会因为关闭前端而被自动终止。

## 交互命令

| 命令 | 用途 |
| --- | --- |
| `/plan`、`/goal` | 查看计划，创建、查看或续跑持久目标；Goal 支持暂停、恢复和接受结果 |
| `/cron` | 查看、创建或取消定时提示 |
| `/skills` | 管理、安装或导入技能；安装包附带 `vspi-self` 配置与诊断技能 |
| `/import` | 导入 Codex 或 Claude Code 历史，不恢复外部工具的运行状态 |
| `/model`、`/effort` | 选择模型与思考档位 |
| `/subagent-model` | 独立配置 core `secondary_model` 的候选模型、默认模型及能力描述 |
| `/copy`、`/compact`、`/usage` | 复制最近一条已完成的正式回复、压缩上下文、查看用量 |
| `/policy` | 查看或切换权限策略 |
| `/settings`、`/theme`、`/thinking` | 调整界面、主题与思考内容展示 |
| `/tui` | 切换常规模式的终端原生滚动与全屏模式的应用内滚动 |
| `/reload` | 查看安全重启指引；退出当前客户端后运行 `vspi continue` |
| `/history` | 分页加载更早的持久化记录；`/history latest` 返回最近记录 |

输入区支持多行文本；生成时可以插话改向（steer）或排队追问（follow-up）。

后端权限模式为 `auto`、`manual`、`yolo`。当前界面的 Safe 与 Standard 都映射到 `manual`，不是两套不同的服务端权限；恢复已有会话时，`manual` 统一显示为 Standard。计划模式和显式拒绝规则仍能限制工具，不代表权限模式发生了降级。

执行前应确认工作目录、权限策略与模型配置，尤其是涉及文件修改、进程和外部服务的任务。

## Feedback：先预览，再提交

2.4.0 默认提供 `/feedback 问题描述`，无需设置实验环境变量。选择最近一轮、最近三轮或仅诊断，先保存到 `VSPI_HOME/feedback/outbox/`，再打开可滚动的完整预览。`U` 进入确认，`Enter` 才上传；`E` 或 `Esc` 只保留本地包。切会话或退出会取消上传，失败不会删除本地包。

不依赖 TUI 的入口：

```sh
vspi feedback export --description "连接失败" --turns 0
vspi feedback export --description "工具调用之后失败" --session SESSION_ID --turns 1
vspi feedback preview /private/path/FEEDBACK_ID.json
vspi feedback submit /private/path/FEEDBACK_ID.json --confirm-sha256 PREVIEW_HASH
```

不指定 session 时默认仅诊断，不擅自挑选会话；只读取已运行的 daemon，离线时可导出有限的本地信息。提交必须使用预览打印的 SHA256，文件变化会被拒绝。如果需要手工删去某些内容，编辑副本后运行 `vspi feedback redact /private/edited.json`，生成新编号并重新预览。

包含范围由使用者选择：有限的版本/协议/端点信息、错误元数据，以及选定的对话与中间输出。原始响应正文不会自动写入结构诊断日志。已知凭据、常见认证头、带认证的 URL、私钥块和终端控制符会被清理，但不能保证识别任意未知秘密，预览是必需步骤。

每包最多 1 MiB、200 条；单条原文超过 64 KiB 会明确省略，普通条目脱敏后最多 16384 字符，截断时优先保留最新条目。需要长文本时自行摘录相关片段，不上传整个 home 或项目。本地 outbox 预检预算为 20 MiB／100 个包，达到上限要求手工归档，不自动丢弃用户反馈。POSIX 文件为 0600、目录为 0700；Windows 私有性还依赖用户目录 ACL，本轮未做 Windows 实机验收。

在线上传前，向管理员领取个人专用的 `feedback.json`，通过私有渠道交付；将它放到 `VSPI_HOME/feedback.json`（默认 `~/.vspi/feedback.json`），POSIX 权限设为 0600。文件包含 `token`，可选 `endpoint`，默认 `https://dist.hypohub.cn/api/feedback`，也允许已配置可信 TLS 的内网入口。不要使用模型 API Key，不要共享凭据或把凭据粘贴到反馈中。没有凭据仍可导出、预览，再手工交付已检查的包。接收端在 Eden 持久保存后才确认编号；公网不提供反馈下载或列表。自动处理和通知的上线独立于客户端发版，不保证提交后即时回复。

## 签名分发与双入口更新

2.4.0 普通安装与更新仍走 GitHub；签名镜像默认关闭，等待镜像正式启用。管理员完成部署并通过可信渠道提供独立核对的 Ed25519 公钥文件 `distribution.json` 后，安装到自己的 VSPI_HOME，POSIX 权限 0600，再启用 `KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION=true`：

```sh
vspi update
vspi update --source public
vspi update --source internal
```

自动模式短超时探测 `dist-internal.hypohub.cn`，失败转到 `dist.hypohub.cn`；两者内容源均为 Eden，不是独立冗余存储。查询版本不再依赖 GitHub，只有签名、有效期、版本防回退和包哈希全部通过才安装。源不可用或校验失败不会降级为未经验证的下载；继续沿用忙碌拒绝、安装备份与失败回滚。

新安装和旧版本一次性升级可使用管理员提供的 `distribution-install.mjs`，`--trust` 指定已独立核对的公钥文件；默认仅下载，`--mode install` 明确执行安装。初始 installer 的来源同样需要核验，不能仅凭同一未知网站同时提供脚本、公钥就认为可信。管理员部署、凭据、Hermes 和证书要求见[操作包说明](../../../ops/vspi-services/README.md)。

## 非交互执行

```sh
vspi exec "说明当前仓库的测试入口"
vspi exec --output json "总结当前改动"
vspi exec resume latest "继续检查遗漏的测试"
vspi exec --help
```

`exec` 支持选择模型、思考档位、工作目录和会话，以及 `text`、`json`、`jsonl` 输出。它不提供交互式审批界面：需要人工批准、回答问题或调用交互式用户工具时，不应期待它像 TUI 一样等待输入。

2.4.2 起，新建 `exec` 会话默认 **Auto**；这是保留显式 deny 规则后的自动放行，不是沙箱或自动风险评估。如果不希望默认自动执行工具，请明确使用 `--permission manual` 或 `--permission inherit`。

`--permission auto|manual|yolo|inherit` 支持独立参数和 `--permission=auto` 写法。新建会话按指定模式初始化，`inherit` 沿用配置/Agent 的初始模式。恢复会话默认 `inherit`，不改持久权限；恢复时显式给出的 Auto/Manual/YOLO 仅作用于该 prompt 的 turn，不写长期权限、不广播到已有子 Agent，也不把临时提权继承为新子 Agent 的长期权限。其他终端显式调整权限会撤销正在生效的临时覆盖。带临时权限的排队 prompt 必须独立成轮，不能 steer 合并到另一轮。

```sh
vspi exec --permission auto "运行测试"
vspi exec resume SESSION_ID "继续检查"
vspi exec resume SESSION_ID --permission manual "只做无需审批的检查"
```

需要审批的操作仍不会在 headless 下自动获批：`exec` 拒绝其拥有轮次的请求、停止该轮并返回失败，不再用成功结果掩盖审批拒绝。若需要人工审批流程，请使用交互客户端。已有会话若已被旧版错误改成 Manual，升级不会猜测并自动升权；由用户在原会话显式恢复期望权限。HTTP 桥接若只投递内容，应省略 `permission_mode`，该 REST 参数仍是持久修改，不是此处的临时覆盖。

## 模型与凭据

VSPi 支持内置 Provider 和自定义兼容端点。首次使用运行 `vspi init`；之后用 `vspi config` 调整 Provider，用 `vspi login <provider>` 登录账号或配置 API Key。界面内也提供 `/providers`、`/login` 和 `/logout`。

VSPLab 中转站是内置 Provider：`vspi init` 时选择 VSPLab 并配置 API Key 即可，默认接入 `https://api.vsplab.tech/v1`（可用 `VSPLAB_BASE_URL` 环境变量或 `base_url` 覆盖；旧配置里的 `api.vsplab.cn` 地址会在 daemon 启动时自动迁移）。中转站目录可补充模型能力、上下文大小、价格和思考档位；已核对模型的档位更新需要带有效的能力版本，未知新模型则可直接使用远程声明快速接入。可用模型仍取决于端点和账号权限，不能仅凭目录条目保证调用成功。

[模型目录快照](../../../ops/vsplab/model-catalog.json)是可审阅的数据，而不是永不变化的能力保证。使用与模型匹配的协议和目录参数，不要随意填写上下文容量或价格。

`/model` 默认只展示官方星标的常用精选，按 `Ctrl+O` 切换全部模型；搜索只作用于当前视图。星标不是个人收藏或稳定性评级，Preview 也可以入选。主模型列表不展示或编辑 Subagent 候选状态。

选择模型后会进入 Effort 确认页，预选该 Provider 与模型上次使用的档位；首次使用采用目录推荐档位。确认后模型与 Effort 一起生效；`Esc` 返回模型列表，不提前切换。当前生成请求不变，运行中切换用于后续模型调用。`/model` 和 `/effort` 不提供 Off 选项，没有可调档位的模型会提示确认固定配置。旧档位已不支持时提示重新确认；恢复已有会话不会被后来修改的全局默认覆盖。

档位记忆保存在 core 配置的 `[thinking.model_efforts]`，按实际模型 alias 区分，不覆盖其他 Thinking 设置。例如：

```toml
[thinking.model_efforts]
"example/code-model" = "high"
"another/code-model" = "max"
```

VSPLab 的内置协议默认值为：GPT 使用 `openai_responses`，Claude 使用 `anthropic`，Kimi、GLM、DeepSeek 使用 `openai`（Chat Completions）。远程目录的 `protocol` 会作为可更新的 `default_protocol` 保存；用户显式设置的模型 `protocol` 仍优先。首次升级时会备份原配置，再清理已确认从旧 Provider 继承的协议值及与新默认相同的冗余值；不能证明来源的不同协议覆盖会保留在迁移报告中。模型详情显示实际解析协议；自定义地址、凭据及 `overrides` 不会被清理。

### 已核对的 Effort 基线

下面是未选择过该模型时的初始预选；已经保存且仍有效的个人档位优先。Off 不出现在选择界面，兼容参数别名也不作为独立档位。

| 模型 | 可选档位 | 初始预选 |
| --- | --- | --- |
| GPT 6 Astra | low / medium / high / xhigh / max | medium（VSPi 产品默认） |
| GPT 5.6 Sol / Luna / Terra | low / medium / high / xhigh / max | medium |
| Claude Fable 5.1 / Fable 5 / Opus 5 | low / medium / high / xhigh / max | high |
| Kimi K3 | low / high / max | max |
| GLM 5.3 / 5.3 Flash | low / high / max | max |
| DeepSeek V4 Pro / V4 Flash | low / high / max | high |
| DeepSeek V4.1 Flash | 暂沿用 V4 的 low / high / max | high（未找到单独档位文档） |
| Qwen 3.8 Max / Flash | low / medium / xhigh | xhigh |
| Gemini 3.8 Flash | low / medium / high | medium |
| Gemini 3.1 Pro | low / medium / high | high |
| MiMo V2.5 / V2.5 Pro | 仅开启思考，不展示虚假的细分强度 | 开启 |
| MiniMax M3 | 自适应思考，不展示虚假的细分强度 | 开启（adaptive） |
| Hy4 Preview | high | high |

Kimi K2.8 Preview 尚未核实到独立的官方档位说明，不套用 K3 的配置。每项基线的来源位于 `packages/agent-core-v2/src/kosong/provider/effortProfiles.ts`，没有公开确认的情况单独标注。GPT 6 的官方页面明确列出了档位，但本轮未确认单独的 API 默认档位，因此 medium 明确标为 VSPi 的产品默认。

旧版未带能力版本的远程列表不能把已知模型覆盖回通用六档。新网关声明使用 `effortRevision`、`effortMode`、`effortLevels`、`defaultEffort` 更新能力；用户明确写在 `overrides` 中的设置仍然优先。初始化迁移保留 `[thinking.model_efforts]` 和 `[secondary_model]`，备份与脱敏报告放在 VSPi home 的 `server/config-migration-backups/` 和 `server/config-migration.report.json`。升级完成后用户再手动写入的协议覆盖不会在每次启动时被重复删除。

`/subagent-model` 单独管理用户的 `[secondary_model]`：`Enter` 加入或移除候选，`Ctrl+D` 设置默认模型，`Ctrl+P` 编辑能力/用途说明。候选使用已有的 `Provider/model` 配置引用，不自动从星标生成，也不自动跨 Provider 选路。清空候选后继承主模型；保存只影响后续创建的 Subagent，不改变主模型或已运行的子任务。已有 `force=true` 时该候选界面只读，需要先通过 core 配置明确关闭强制模式。

## 配置文件与重载

配置默认位于 `~/.vspi/config.toml`，`vspi config path` 输出实际路径。设置 `VSPI_HOME` 可隔离配置、会话与 daemon。

以下为示意配置，地址与模型 ID 需要替换成实际可用的值：

```toml
default_model = "example/YOUR_MODEL_ID"

[providers.example]
type = "openai"
base_url = "https://api.example.com/v1"

[models."example/YOUR_MODEL_ID"]
provider = "example"
model = "YOUR_MODEL_ID"
```

通过 `vspi login example` 配置凭据，不要把真实密钥提交到仓库。

```sh
vspi config path
vspi config inspect defaultModel
vspi config diagnostics
vspi config reload
```

`config inspect` 和 `config diagnostics` 只读连接已有 daemon；`config reload` 才会重新读取磁盘配置。命令行 section 使用 `defaultModel` 等 Core 名称，TOML 使用 `default_model` 等磁盘字段名。

`config get/inspect` 的输出会隐藏凭据，不要把脱敏后的整段值写回。修改少数字段优先使用 `config patch`；`config set` 要求完整 section 值，语法见 `vspi config --help`。

## 升级、诊断与运行边界

2.3.0 使用终端中的 `vspi update` 升级：先退出连接同一 home 的客户端，并等待主任务、Subagent 和后台工作结束。升级器校验下载内容，保存旧安装包和配置备份，确认运行时空闲后停旧、安装、验证新入口并恢复原先运行的 Daemon；仍在使用时拒绝换包。安装或启动失败时尝试恢复旧包；如果配置已经变化，不会为了回退而覆盖配置或强行启动旧版。备份位于 `server/update-backups/`，其中可能包含凭据，请按敏感数据保管。本轮实机验收范围为 Linux；Windows 建议暂留固定 2.2.4，macOS 未实测。

2.4.1 起，空闲客户端连接不再阻止更新。有活跃工作时，交互终端会显示占用数量并询问是否终止后更新，默认 `N`；只有明确输入 `y` 或 `yes` 才会正常关闭该实例。未完成的输出可能丢失，定时任务需重新打开相应会话恢复。非交互调用不会默认终止工作，取消确认也不会改写安装。确认期间若 daemon 实例发生变化，会拒绝沿用旧确认。

主动 `vspi daemon stop` 或更新会留下关闭标识；旧界面显示停止提示，不再自动启动后端。意外掉线仍保留有限恢复。从 2.3.0/2.4.0 首次升级时旧客户端不认识这个标识，必须先在旧界面 `/quit`，再 `vspi daemon stop` 和 `vspi update`；否则旧界面可能立即把 daemon 拉起。不要对未知进程使用批量 kill，也不要删除历史目录。

从 2.2.x 首次升级仍须先显式停旧，因为运行的是旧升级器：确认任务结束后运行 `vspi daemon stop`，确认已停止，再安装候选包/正式发行包。不要删除 `~/.vspi`，无需重新 `init`。若已经覆盖安装且 Windows 旧 Daemon 不支持关闭协议，新版会拒绝把强制终止伪装成优雅关闭；只有确认没有需要保留的运行中任务后，才使用 `vspi daemon stop --force-legacy`，该选项仍会验证旧实例归属。

新版 Daemon 通过认证 IPC 完成资源收尾并返回可核实的关闭结果；程序从 `server/builds/<build id>/` 的不可变快照运行，避免覆盖全局安装后旧进程的嵌套 CLI 跳到另一构建。不同版本、构建或 Node 版本的客户端仍不会静默接管不兼容的 Daemon。`/update` 提供终端升级指引；`/reload` 暂不进行热进程接管，以避免两个进程同时读取、恢复同一终端。

恢复会话时读取持久化历史、活动回合和待处理交互；同会话的其他终端提交消息、切换模型或完成交互时同步显示。历史默认加载最近 100 条，使用 `/history` 加载更早记录，`/history latest` 返回最新窗口。超长记录有展示上限，原文件不被截断；任务面板只保留有界的近期任务。恢复或统计不再通过 IPC 搬运整个模型上下文。

```sh
vspi inspect paths
vspi inspect models
vspi daemon status
vspi daemon logs
```

`inspect` 不会启动、重启 daemon 或恢复会话。`daemon logs` 输出日志文件路径；诊断文件位于对应 `VSPI_HOME` 的 `server/diagnostics/`。日志、堆快照和诊断报告可能包含敏感信息，分享前需要检查与脱敏。

`vspi daemon stop` 会影响运行时承载的工作，不是无副作用的排查命令。断线恢复也不会自动重放崩溃时中断的提示或工具调用，需要判断任务停在哪里再继续。

旧的空/损坏锁不会被自动猜测为可删除。确认对应 home 没有存活 Daemon 后，可使用 `vspi daemon recover --confirm-stopped`；新近写入的锁仍会被保护，恢复操作会保留原锁文件。新版锁要求 home 所在文件系统支持同目录硬链接，普通本地 NTFS、APFS、ext4 安装应纳入平台验收；不要把 home 放到未经验证的网络/同步文件系统后假定锁语义相同。

启动和手动恢复使用同一个恢复互斥锁。若 `.recovery` 的归属不可核实，或 `.recovery.reclaim` 表明恢复流程本身有未确认的残留，程序会保留文件并明确拒绝继续；不要通过反复删除锁文件绕过所有权检查，应先核实相关进程与文件。

IPC 对单帧、在途请求与缓冲总量设置预算。遇到超限应缩小请求或使用分页，不应删除上限、无条件重试可能已执行的操作。默认不再在接近堆上限时自动连续生成 heap snapshot；需要堆诊断时单独授权、限定目录与磁盘预算。

### 模型抖动与 Subagent 超时

VSPi 默认每个模型步骤最多尝试 3 次（含首次），只自动重试连接/超时、408、429 及部分暂态服务端错误，不盲目重试鉴权、参数或未知配置错误。首次暂态失败之后的恢复窗口为 120 秒，限制退避与恢复响应之前的等待；收到协议内容后不因这个总时长截断健康长流。若随后再次失败且原窗口已过，不再追加请求。这不是整个 Subagent 的执行时限。服务端 `Retry-After` 超过剩余窗口时直接报告原因，不提前重试或无界等待。旧的无限重试环境开关不能绕过这套有限恢复策略。

Pi 的 Chat Completions、Responses、Anthropic HTTP 路径在发起请求及接收协议字节时监测进展，默认连续 300 秒没有进展则取消本次请求；Thinking、工具流、SSE 控制/心跳字节也计入进展，不会只因没有可见正文就超时。Google/Vertex 原生 SDK 和 legacy compatibility 适配路径目前未接入该字节级监测，不能假定它们也受此空闲期限保护；恢复窗口仍适用于后续重试请求。

对应 `[loop_control]` 的 `max_attempts_per_step`、`retry_budget_ms` 和 `request_idle_timeout_ms` 可配置。界面用临时状态显示重试次数，恢复输出、回合结束或切换会话后清除，不覆盖独立警告；用户可以随时中断。失败的半截输出会被放弃，已经执行的工具或崩溃时的提示不会因此自动重放。

流没有提供完成标记时，错误码为 `provider.incomplete_stream`，可在上述预算内重试。2.4.2 起，Chat/Responses/Anthropic 的 SSE 外层事件 JSON 损坏会归为 `provider.stream_parse_error` 并在同一预算内有限恢复；正常分包、多行 `data:` 和 CR/LF/CRLF 都按完整事件处理，不猜补 JSON、不丢弃坏帧后继续执行。单个事件解析预算为4 MiB，超限明确报错且不重试；HTTP/格式初步采样保持64 KiB。解析异常记录请求ID、协议、事件类型/序号、大小、位置与阶段，不把坏帧原文放入SDK错误日志。事件守卫覆盖首个采样窗口之后的流。

明确收到其他协议事件、HTML 页面或非流式 JSON 时，仍为 `provider.protocol_error`，不盲目换协议或重试。工具参数JSON错误、本地配置错误不因这项修复一律重试。重试成功会清除临时提示，耗尽预算才留下最终错误；已经结束的历史失败不会被后续任意输出删除。Google/Vertex 原生 SDK 等未经过该 HTTP 路径的请求不具备完整的此类诊断。新增容错不代表已经证明具体上游或网关的故障根因。

Subagent 自身默认任务超时仍为 2 小时，`[subagent].timeout_ms` 或 `KIMI_CODE_SUBAGENT_TIMEOUT_MS` 可调整，`0` 表示禁用这层任务时限，不是禁用模型恢复预算。`/agents` 显示实际错误和任务超时值。若任务失败，应先检查错误详情，再决定是否继续同一 Agent；没有证据时不要把“约 30 分钟失败”直接解释成固定的 30 分钟限制。

`vspi web` 当前只输出本机 runtime 地址。安装包不附带独立浏览器前端，也不自动开放远程访问；不能把它等同于部署完整 Web UI 或公网服务。
