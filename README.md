# VSPi

VSPi v0.1.0 是基于 `@earendil-works/pi-tui` 与 `@earendil-works/pi-coding-agent` 的自定义中文 TUI。当前实现已接入统一动作目录、真实 Session runtime、Provider/Model/Effort 真相源、执行 Policy、Question tool、图片附件，以及可配置的 thinking/代码换行渲染。

## 环境与启动

- Node.js `>=22.19.0`
- 最低终端：`80×24`、256 色
- 推荐终端：UTF-8、truecolor、Kitty keyboard protocol

```bash
npm install
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

后端模式：

```bash
# 默认：真实 Pi，启动新会话；缺少模型或凭据时显示 setup error，不回退 Fixture
npm run dev

# 续接最近的会话
npm run dev -- continue

# 启动后直接进入会话选择器
npm run dev -- resume

# 非交互模式：执行单个 prompt 并输出到 stdout
npm run dev -- run "用一句话解释 bubblewrap"

# 帮助与版本
npm run dev -- --help
npm run dev -- --version

# 显式真实 Pi
VSPi_BACKEND=pi npm run dev

# 显式信任当前项目；仅绑定启动时 workspace 的 realpath
npm run dev -- --trust-project

# 完全离线的交互 fixture（等价入口：VSPi_BACKEND=fixture）
VSPi_FIXTURE=1 npm run dev
```

VSPi 沿用 Pi 的模型、Provider、凭据和 session 目录。VSPi 不保存 API key，也不提供通用 Secret Manager。Fixture 只能通过 `VSPi_FIXTURE=1` 或等价的 `VSPi_BACKEND=fixture` 显式启用。

## 启动与默认界面

启动序列会先立即写出 initial brand-only 初始帧：它只显示 VSPi 品牌、现有六行块字符 Logo 和动画进度，不含运行状态或模型声明；应用初始化在同一轮启动并与封面动画并行。最终帧等待应用初始化完成，使用初始化后解析得到的真实 Model、`package.json` 解析出的包版本、真实 Backend 与执行 Policy。真实 pi 显示 `Backend Pi`，显式离线后端显示 `Backend Fixture`；边界以 `Policy Standard · Sandboxed` 或相应的 `Policy … · Host` 表达，Backend 与 Policy 是两项独立元数据。

完整 Logo 的最终帧连同结尾 newline 会先提交并写入终端 `scrollback`，之后才启动动态 TUI；后续刷新和差分渲染只管理它下方的动态区域，不会擦除、清空或覆盖这个最终帧。启动、`/new` 和它的 alias `/clear` 都遵守同一规则：先把完整 final Splash 写入 scrollback，再建立新的动态区域。启用 reduced motion 时不播放中间帧，但仍遵守相同的初始化屏障与最终帧写入顺序。

默认的新工作区动态界面为空，不加载或预置对话、工具消息、演示计划、usage 或 session；文档中的对话和工具消息一律标为“交互示例”，不是启动内容。Plan 使用紧凑三行框并显示 `当前计划为空`；离线后端明确标识为 `Offline Fixture`。`80` 列状态固定为两行，并且每行可见宽度严格为 80 列：

```text
Model OpenAI / GPT-5.4  Effort 高                       Context 50K / 128K 39%  
/workspace/vspi · Policy Standard · Sandboxed       Token ↑12k ↓3.0k  Cost ¥1.01
```

动态状态区只包含两条语义轨道：第一行严格为 `Model / Effort / Context`；第二行直接从路径值开始，再显示 `Policy / Token / Cost`，不显示冗余的 `Path` 标题。Backend 只保留在永久 Splash 与诊断信息中，不进入动态行。五个标签与对应值、以及无标题路径值分别着色，不把整行统一处理为弱文本。80/120 列的路径 flex 区从右侧保留完整 `Policy <name> · Sandboxed|Host` suffix；只有 Model 和路径变量值可以显示省略号，Effort、Context、Policy/Boundary、Token 与 Cost 不截断。

M1 把 `Context` 明确定义为当前上下文占用、模型窗口和百分比，`Token` 则是独立的累计输入/输出量。三个状态例子分别是活动会话 `Context 50K / 128K 39%  Token ↑12K ↓3K`、空容量 `Context 0K / 0K 0%  Token ↑0 ↓0`，以及压缩后尚无法估算的 `Context ?K / 128K ?%  Token ↑12K ↓3K`。`K` 使用十进制千 token：10K 以下保留一位小数，10K 及以上显示整数；百分比始终由未格式化的原始占用量与窗口计算。

Status 在 40、80、120 列都恰好两行，并按终端可见列而不是原始 ANSI 字节计算。Model 与 Effort 使用固定两个空格的小间距并组成连续左侧轨道；空间不足时只截断 Model，Effort 保持完整。80/120 的固定右轨从内容预算反向排布：Context 为 24 列并可为批准最大值扩到 25 列；Token 为 18 列，Cost 为 10 列并可扩到 13 列。剩余空间交给 Model/Effort 组合区和无标题路径 flex 区，因此长身份只截断自身，不会覆盖或推动右侧字段。代表最大值 `Context 999K / 1000K 100%`、`Token ↑999k ↓999k`、`Cost ¥9999.99` 必须完整显示。40 列仍严格保持两行、五个标签与直接路径值，可省略 busy/mode、Context token 细节、Token 输出；无法容纳的高位 Cost 显示明确的 `Cost …`，不冒充未知值 `?`。顺序不变且每行不超过 40；永久 Splash 已记录完整 Backend 真相。

Status 的短模型样例左右锚是：80 列第一行 `Model 0 / Effort 24 / Context 56`、第二行 `路径值 0 / Token 52 / Cost 70`；120 列第一行 `Model 0 / Effort 24 / Context 96`、第二行 `路径值 0 / Token 92 / Cost 110`；40 列第一行 `Model 0 / Effort 15 / Context 25`、第二行 `路径值 0 / Token 20 / Cost 32`。Effort 的位置随 Model 实际宽度变化，但两者始终只隔两个空格；Context/Token/Cost 的右锚不受 Model 或路径长度影响。长路径只截断自身，不会推动 Token/Cost；批准最大值会让 Context/Cost 固定区向左扩展。

## 交互

单独输入 `/` 会在原 Plan 区域打开完整命令目录，slash 和所有完整命令 cell 都不高亮或强调。v0.1 生产命令为：

```text
/new       /sessions   /compact    /model      /providers
/plan      /prompt     /thinking   /effort     /policy
/usage     /settings   /theme      /quit
```

`/compact` 在未绑定 Local Plan 时默认使用 Pi Native，绑定 Plan 时默认使用 Execution Continuity。
使用 `/compact --list` 检查四种手动 profile；也可显式选择 `native`、`continuity`、`research`，
或使用 `/compact custom <instructions>`。v0.1.0 的自动 threshold/overflow 压缩始终保持 Pi Native；
统一配置自动压缩 profile 计划在 v0.2.0 提供。

退出候选显示为 `quit (exit)`。canonical `/new` 的 alias 是 `/clear`；`/sessions` 的 aliases 是 `/session` 与 `/resume`；`/providers` 的 alias 是 `/provider`；canonical `/quit` 的 aliases（别名）是 `/exit` 和 `/q`，候选行会明确显示 `别名（/exit） → /quit`。`/thinking` 是 canonical 命令，不是 alias。插件/扩展命令保留 package `source` 来源，而内置命令显示 Built-in。

`Tab` 是唯一补全键，只处理无参数的单一 slash token，并且必须只有唯一候选：`/ex → /exit`，其可见结果只强调 `ex`，斜杠与 `it` 保持普通；`/qui → /quit` 只强调 `qui`，斜杠与 `t` 保持普通；`/ses → /sessions`、`/provi → /providers`、`/cl → /clear`。存在参数、普通文本或多个 token 候选时不改写。`Tab` 只修改 composer 文本，不会执行命令，也不写入 history（历史记录）；最终执行始终使用 canonical 命令身份。若两个不同 canonical 命令注册了同一个 exact alias，解析和面板 Enter 都会 fail closed，不会静默执行注册顺序中的第一项。composer 中的 slash token 与 Command 候选中的匹配前缀同时使用颜色和粗体、下划线、反显（bold / underline / inverse），因此无色终端仍可辨认，普通文本不受影响。

Command 工作区在 40 列把每个命令排成身份行与详情/source 行，滚动时两行保持成组；80 列和 120 列使用稳定的“身份 / 描述 / source”三列。三档 Command 与 Status 都按终端可见列宽计算，不使用特殊全角填充。

`/plan`、`/prompt` 与 `/policy` 都已接入真实生产工作区。Plan 使用不可变 revision、Session binding 和 typed tools；Prompt Profile 使用分层规则、Factory/Fork 与每轮 overlay。自更新不属于 v0.1.0 的生产表面。

用户消息使用 full-width light rounded frame：正文背景 `#B8E6E3`、前景 `#102426`，边框使用焦点青 `#5FC7C7`。该契约在 40 列、80 列、120 列都保持整行等宽；硬换行、长单词 wrap 和附件摘要都留在 frame 内，transcript Inspect 选中时保留完整内容与 frame 形状。

- `Enter` 提交。
- `Shift+Enter` 或 `Ctrl+J` 换行。
- 空输入时 `Tab` 进入 transcript Inspect；方向键选择、折叠和展开。
- `Shift+Tab` 在 composer 与 Plan 之间切换。
- `Alt+Enter` 将消息作为 follow-up 提交。
- `Ctrl+C` 取消生成；空闲时退出。

Model、Provider、Sessions、Settings、Usage、Theme 和 Question 共用底部工作区，不叠加多层弹窗。Pi 的真实 `question` ToolDefinition 支持单选、多选、排序和填空；模型发起调用后会等待用户在动态 Question 工作区完成最终检查。`Left/Right` 切题，`Up/Down` 选择，`Ctrl/Alt+Up/Down` 调整排序，`Tab` 直接回答，`Shift+S` 跳过，`Enter` 确认或提交。取消、Session replacement 与应用退出都会以 `AbortError` 终止 pending Question，不把 prompt、选项说明、路径或 secret 样式文本写回 tool result。

每个已接入工作区都有 contextual hint。hint 位于面板 frame外，并直接位于 composer上方；Command 的完整提示是 `↑↓ 选择  Tab 补全  Enter 执行  Esc 关闭`。Plan、Provider、Sessions、Settings、Usage、Theme、Question 和 Model 按当前真实可用动作生成提示；未来工作区接入前不得宣告无效键位。

## Model 与 Provider

出厂内置 VSPLab 中转站 Provider（`https://api.vsplab.cn/v1`，OpenAI Responses 协议），预置 GPT-5.6 系列与 5.5、5.4 模型目录；VSPi 不保存 API key，只需设置环境变量 `VSPLAB_API_KEY` 即可使用。Provider 面板与模型列表按 VSPLab、DeepSeek、Xiaomi（MiMo）、Kimi、GLM（Zai）、MiniMax、OpenAI、Anthropic 优先排序，其余按字母序。

Model 列表来自当前 Pi `ModelRuntime.getAvailable()`，不再使用生产 hard-coded catalog。选择模型会先 await `session.setModel()`；成功后才更新 Model、vision、Context、Profile model identity 和 UI，失败保留原状态。`/effort` 同样先写入 Pi session。M7 前 `profileModelId` 明确等于当前 `modelId`。外层 60 列及以上使用左列表/右详情；窄屏使用显式列表/详情导航。单模型 CNY 输入、输出单价仅显示在右侧详情，模型组不显示价格，也不显示汇率参考行。

Provider Enter 只打开本地 action menu，不会隐式验证。`check-config` 只校验 schema、URL、协议和模型，不发网络；`test-connection` 是显式网络动作；`minimal-generation` 必须在面板内再次按 Enter 确认费用。编辑器只包含名称、Base URL 和协议，只有 `Ctrl+S` 保存，Enter 不保存。

Provider catalog 按 built-in、Pi global `models.json`、trusted project `.vspi/models.json` 合并，模型按 id 稳定 override。项目默认不受信任；只有命令行显式传入 `--trust-project`，VSPi 才以 `SettingsManager.create(..., { projectTrusted: true })` 为启动时 workspace realpath 启用项目资源。该 trust 不通过环境变量自动授予，也不会在 Session 切换到其他 cwd 时继承。无 flag 时项目 Provider overlay 和 `.vspi/settings.json` 不读取，Provider、project settings 与 project defaults 的保存都会拒绝；global settings 始终可用。

项目层禁止 API key、token、secret、credential、命令值和敏感 header；Provider/model 协议必须映射到四个原生协议，模型 input 只能是包含 `text` 的非空 `text/image` 集合。Provider 编辑器保存新 protocol 时会移除同一项目 Provider/模型上的旧 `api`；runtime 的确定性优先级是 `protocol > api`，因此旧 api-only 文件仍可导入，而新选择不会被旧 wire API 覆盖。保存使用 canonical SHA-256 expected-hash 并发检查与 0600 临时文件原子 rename。Provider、VSPi settings 与 runtime defaults 的项目路径都会对 `.vspi`、目标、lock（适用时）和临时文件执行 `lstat`，并在 mkdir/rename 前后复验 realpath 仍位于 workspace；symlink scope 会 fail closed。损坏 JSON 会 fail closed，绝不自动覆盖。

## Execution Policy 与 Recovery

执行等级固定为 `Safe < Standard < Auto < YOLO`，默认 `Standard`。CLI 或全局策略可选择上限，可信项目策略只能降低有效等级，不能提升到 Auto/YOLO。`/policy` 显示每级真实 boundary；切换先检查 capability，失败时原子回滚。YOLO 必须在警告界面明确按 Enter 确认；CLI 使用 YOLO 还必须额外传 `--acknowledge-yolo`。

| Policy | 文件系统 | 网络/共享/高风险 | Boundary |
| --- | --- | --- | --- |
| Safe | workspace 只读；任意写入拒绝 | 网络与共享拒绝 | bwrap · Sandboxed |
| Standard | workspace 内可逆读写直接允许 | 网络、越界、共享、高风险默认询问；无确认即拒绝 | bwrap · Sandboxed |
| Auto | workspace 内读写免询问 | 仅配置 allowlist 的网络动作免询问；越界与未配置共享拒绝 | bwrap · Sandboxed |
| YOLO | 调用者请求的 Host 子进程 | 绕过 VSPi approval/sandbox；Workflow authority gate 仍独立 | Host |

Policy 配置分别位于全局 `~/.config/vspi/policy.json` 与项目 `<workspace>/.vspi/policy.json`，格式只接受 `policy` 和可选的 `networkAllowlist`。CLI 显式 Policy 优先于全局默认；项目文件只有在 `--trust-project` 下读取，并且只能降低 CLI/global 结果。网络范围以全局 allowlist 为上限，项目 allowlist 只能取交集；target 只接受无 userinfo、query、fragment 的 HTTP(S) origin 或 path。配置拒绝 secret、credential、敏感 header 与 `!command`，所有 URL 校验错误和 load diagnostic 都不回显被拒值。项目保存使用 expected hash、writer lock、0600 临时文件和原子 rename，symlink scope 会 fail closed。损坏文件给出有界诊断并回到安全默认，不会被自动覆盖。

```bash
npm run dev -- --policy Safe
npm run dev -- --policy Auto
npm run dev -- --policy YOLO --acknowledge-yolo
npm run dev -- --recovery
```

Safe/Standard/Auto 的 `execute()` 在 spawn 前拒绝不允许的动作，允许的命令只通过 Linux bubblewrap 启动；没有可用 bwrap/user namespace 时不会退化为提示文案，执行与策略切换会明确失败。sandbox 只读挂载运行命令所需的系统目录和明确请求的 executable，并把 workspace 按等级挂为只读或可写。YOLO 只直接执行调用者传入的 command/args/cwd/env，不会扩大为其他后台权限。审计日志不记录环境值，并脱敏 token、secret、password、credential 与 API key 类值。所有等级都必须单独通过 Workflow authority gate，Policy 不能替 Workflow 授权发布、删除或接受。

生产 Pi Session 使用同名 `read/bash/edit/write` ToolDefinition 覆盖：保留 Pi 原生 schema、label、description 与 renderer，只替换 `execute`，并在初始、resume、new、switch/fork replacement runtime 中持续安装。启动层只创建一个 `ExecutionPolicyService` 实例，并把同一对象注入 Pi Backend 与 TUI Policy 面板，因此界面 snapshot、工具决策和 audit 来自同一状态源。嵌入方直接构造 `PiBackend` 而未传 `executionPolicy` 时，Backend 会自行创建 `Standard · Sandboxed`（Recovery 下为强制 Standard）服务并照常安装覆盖，绝不回退到 Pi SDK 的 Host-local reader/writer/shell。未接入 approval surface 时 Standard 风险动作默认拒绝；命令超时或 AbortSignal 会终止整个子进程组。扩展或自定义工具不会因注册本身自动获得 `Sandboxed` 声明，必须显式通过该服务执行。

YOLO acknowledgement 使用公开的一次性 broker。普通 TUI 只有 `/policy` 面板中真实选中 YOLO 后的 Enter 会 `grantOnce("tui")`，紧接着的同一 service switch 消费授权；取消、伪造事件、直接调用、切换失败或下一次调用都没有残留权限。CLI `--acknowledge-yolo` 只在本次启动最终请求 YOLO 时预授 `cli-startup`，启动切换立即消费；flag 不会成为进程生命周期内的 ambient YOLO authority。Recovery 从不授予该确认。

`--recovery` 无条件覆盖 `--policy` 与 `--trust-project`，强制 `Standard · Sandboxed`、空网络 allowlist、global-only settings/models，并且完全不读取项目 Policy 配置；Pi ResourceLoader 同时禁用 extensions、skills、prompt templates、themes 与 project context files，界面会明确显示 `Recovery`。PiRuntimeBackend 也把该规则作为内部不变量：即使嵌入方同时传入 `recovery:true` 与冲突的 `trustedProject:true`，有效 trust 仍为 false，后续 new/resume/switch runtime 同样不能恢复项目权限。它不加载 Workflow Adapter，也不叫 `--safe`。

## Workflow Adapter Bootstrap

VSPi `0.2.0` 的首个 bootstrap 只读投影 Hypo-Workflow Plan；长期 Local Plan authority 的移除、Workstream Session binding 与模型组路由属于后续里程碑。Adapter 是 TypeScript host boundary，加载同一 Node.js 进程中的 ESM JavaScript Core；`.pipeline` 文件只能由 Core API 读写，VSPi 不直接解析或修改 authority YAML/JSON。

普通启动需要一个已经 materialize runtime dependency、通过 manifest 校验且与已接受 Core 结果绑定的安装根目录。安装器还要为 `node_modules` 全树生成 `runtime-manifest.json`。六个配置值必须一起提供，semver 相同不代表 bundle 相同：

```bash
VSPI_WORKFLOW_ROOT=/absolute/installed/root \
VSPI_WORKFLOW_ARCHIVE=/absolute/accepted-portable.zip \
VSPI_WORKFLOW_SOURCE_COMMIT=<40-hex-commit> \
VSPI_WORKFLOW_ARCHIVE_SHA256=<64-hex-sha256> \
VSPI_WORKFLOW_MANIFEST_SHA256=<64-hex-sha256> \
VSPI_WORKFLOW_RUNTIME_MANIFEST_SHA256=<64-hex-sha256> \
vspi
```

Loader 在 import 前验证 archive digest、bundle/runtime manifest digest、release descriptor、source commit、全部 Core 文件与 runtime dependency 字节；manifest 必须绑定 descriptor 与 Core root export，`node_modules` 不允许未声明文件或 symlink。import 后再验证 required root exports 与 Host Contract v1。缺失、旧安装、sibling release、损坏或版本不兼容时 `/plan` 显示有界诊断，所有 Workflow authority 请求默认拒绝，普通聊天仍可用。`--recovery` 在读取上述环境变量之前就禁用 Adapter，因此即使这些值恶意或损坏也不会触发 bundle discovery、import 或项目 Workflow 读取。

`Policy … · Sandboxed` 只描述 VSPi `ExecutionPolicyService` 创建的子进程边界，不声称 Pi provider 请求或 Pi SDK runtime 进程本身已被 bwrap 包裹。bubblewrap `--share-net` 也不提供目标级 egress filter：Standard/Auto 在 spawn 前校验 allowlist，但获准命令进入共享网络 namespace 后仍可能自行访问其他地址；内核级网络 allowlist 和更强 TOCTOU containment 是后续安全加固项。

## 图片附件

图片附件已接入真实模型提交。本机使用 `Ctrl+V` 或 `Alt+V` 读取图片剪贴板；Linux 只以固定参数调用 Wayland `wl-paste` 或 X11 `xclip`，macOS 使用 `pngpaste`。附件显示为原子节点：

```text
〔登录页-修改前 · 1440×900 · PNG〕
```

选中节点后可用 `F2` 重命名、`F3` 预览、`Delete` 移除、`F4` 保存到项目。缓存默认位于：

```text
~/.cache/vspi/attachments/<session-id>/
```

SSH 会自动在远端 `127.0.0.1:43117` 启动 Attachment Bridge，并在 TUI 中显示一次性 URL。先建立端口转发：

```bash
ssh -L 43117:127.0.0.1:43117 user@server
```

然后在本机浏览器打开 TUI 显示的 URL并粘贴截图。也可单独运行：

```bash
npm run bridge
```

Bridge 只监听 loopback，使用随机 fragment token、Origin allowlist、速率限制、20 MiB 上限和 MIME/magic 校验；回调无法把附件交给 composer 时会回滚缓存和 manifest。缓存跟随真实 Pi session id 切换并恢复；恢复及每次后续读取都会通过 `O_NOFOLLOW` 重新验证 session 目录内的普通文件、canonical path、inode、实际大小、magic 与尺寸。显式 retention API 只清理过期且未保留的 session 目录。所有服务级 store 操作与切换共用串行队列，session/generation 栅栏会回滚已开始但随后过期的 paste/Bridge delivery。保存到项目会逐级拒绝 symlinked `.vspi`/`attachments`，验证目录 containment，并通过目录内独占临时文件原子 rename；不会使用可跟随 symlink 的 `copyFile`。无 vision 能力的模型会在清空 composer 前阻止带图提交；Pi 在 `prompt` 前通过同一个 verified reader 构造真实 image content，文本 manifest 只含清洗后的 JSON 元数据，不包含缓存路径，并把 alias 明确视为不可信显示标签。

## 配置与费用

设置即时保存；只有本次启动显式使用 `--trust-project` 时，项目设置才会读取并覆盖全局设置：

```text
~/.config/vspi/settings.json
<project>/.vspi/settings.json
```

`reducedMotion`、`bridgeEnabled`、Theme、`showThinking` 和 `wrapCode` 均已接入运行时。关闭 `showThinking` 会立即隐藏普通 thinking 行，但 Inspect 仍按稳定 message id 选中并展开单条 thinking/tool；`wrapCode` 控制 fenced code 的长行是否换行，40/80/120 列均保持宽度安全。

默认 Model/Effort 单独保存在无 secret 的 `runtime-defaults.json`。global 总是可用；project 只有本次启动显式授予项目 trust 时才读取和写入。Model identity 始终只保存精确 `{provider,id}`；同 id 的不同 Provider 不会混用。Model 或 Effort 选择成功后按 Settings 当前 scope 原子保存；普通 `/new` 在重建 ModelRuntime 并注册当前可信 overlay 后按 `{provider,id}` 重解析模型，`/new --default` 则不继承旧模型对象，而是重新读取并应用默认值。

项目路径 guard 会在每次关键文件操作前复验边界，但用户态 `lstat`/`realpath` 与最终 syscall 之间仍存在无法完全消除的 TOCTOU 窗口；M4 的 OS sandbox/进程 containment 必须继续承担对抗并发恶意替换的最终边界。

pi 返回的模型价格和 usage 以 USD 为基础。VSPi 内部换算人民币估算；模型组不显示总价，单模型选择页只在右侧详情显示 CNY/人民币输入、输出单价，界面`不显示汇率参考行`、来源、日期或汇率换算样例行。

## 开发验证

```bash
npm run check
npm test
npm run build
npm run smoke
npm audit
```

依赖固定在 pi `0.81.1`。VSPi 自有渲染、状态机和 SDK adapter 相互分离；升级 pi 时必须通过终端快照、适配契约和 80×24 回归测试。

当前已知供应链风险：pi `0.81.1` 的嵌套依赖包含 `protobufjs 7.6.4` 中危 DoS 公告。该漏洞涉及解析不可信 `.proto option`，VSPi 不暴露这一入口；由于 pi package shrinkwrap 阻止根 override，需等待上游更新后再升级验证。

## v1 边界

当前实现包括统一 Action Registry、诚实 Splash、真实 Session lifecycle、ModelRuntime 驱动的 Model/Provider、原生模型与 Effort 写入、配置安全边界、显式 probe、Markdown 流式渲染、Question tool、图片提交、Local Plan、Prompt Profile、连续性压缩、Theme、`showThinking` 与 `wrapCode`。Sub Agent 与通用 Approval surface 不属于 v0.1.0。

详细界面规范见 [Docs/tui-v1.md](Docs/tui-v1.md)。
