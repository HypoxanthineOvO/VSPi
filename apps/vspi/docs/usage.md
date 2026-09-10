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

## 交互命令

| 命令 | 用途 |
| --- | --- |
| `/plan`、`/goal` | 查看计划，创建、查看或续跑持久目标；Goal 支持暂停、恢复和接受结果 |
| `/cron` | 查看、创建或取消定时提示 |
| `/skills` | 管理、安装或导入技能；安装包附带 `vspi-self` 配置与诊断技能 |
| `/import` | 导入 Codex 或 Claude Code 历史，不恢复外部工具的运行状态 |
| `/model`、`/effort` | 选择模型与思考档位 |
| `/copy`、`/compact`、`/usage` | 复制最近一条已完成的正式回复、压缩上下文、查看用量 |
| `/policy` | 查看或切换权限策略 |
| `/settings`、`/theme`、`/thinking` | 调整界面、主题与思考内容展示 |
| `/tui` | 切换常规模式的终端原生滚动与全屏模式的应用内滚动 |
| `/reload` | 重新启动前端并续接当前会话 |

输入区支持多行文本；生成时可以插话改向（steer）或排队追问（follow-up）。

后端权限模式为 `auto`、`manual`、`yolo`。当前界面的 Safe 与 Standard 都映射到 `manual`，不是两套不同的服务端权限；恢复已有会话时，`manual` 统一显示为 Standard。计划模式和显式拒绝规则仍能限制工具，不代表权限模式发生了降级。

执行前应确认工作目录、权限策略与模型配置，尤其是涉及文件修改、进程和外部服务的任务。

## 非交互执行

```sh
vspi exec "说明当前仓库的测试入口"
vspi exec --output json "总结当前改动"
vspi exec resume latest "继续检查遗漏的测试"
vspi exec --help
```

`exec` 支持选择模型、思考档位、工作目录和会话，以及 `text`、`json`、`jsonl` 输出。它不提供交互式审批界面：需要人工批准、回答问题或调用交互式用户工具时，不应期待它像 TUI 一样等待输入。

## 模型与凭据

VSPi 支持内置 Provider 和自定义兼容端点。首次使用运行 `vspi init`；之后用 `vspi config` 调整 Provider，用 `vspi login <provider>` 登录账号或配置 API Key。界面内也提供 `/providers`、`/login` 和 `/logout`。

VSPLab 中转站是内置 Provider：`vspi init` 时选择 VSPLab 并配置 API Key 即可，默认接入 `https://api.vsplab.tech/v1`（可用 `VSPLAB_BASE_URL` 环境变量或 `base_url` 覆盖；旧配置里的 `api.vsplab.cn` 地址会在 daemon 启动时自动迁移）。中转站目录可补充模型能力、上下文大小、价格和思考档位，明确声明的 `effortLevels` 会作为该模型的档位依据，不再被本地内置目录错误缩减。可用模型仍取决于端点和账号权限，不能仅凭目录条目保证调用成功。

[模型目录快照](../../../ops/vsplab/model-catalog.json)是可审阅的数据，而不是永不变化的能力保证。使用与模型匹配的协议和目录参数，不要随意填写上下文容量或价格。

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

使用 `vspi update` 升级，然后重新启动客户端。不同版本、构建或 Node 版本的客户端不会静默接管不兼容的 daemon。遇到身份不匹配时，先确认原任务结束，再显式停止旧 daemon；也可以用独立 `VSPI_HOME` 并存测试新版本。

```sh
vspi inspect paths
vspi inspect models
vspi daemon status
vspi daemon logs
```

`inspect` 不会启动、重启 daemon 或恢复会话。`daemon logs` 输出日志文件路径；诊断文件位于对应 `VSPI_HOME` 的 `server/diagnostics/`。日志、堆快照和诊断报告可能包含敏感信息，分享前需要检查与脱敏。

`vspi daemon stop` 会影响运行时承载的工作，不是无副作用的排查命令。断线恢复也不会自动重放崩溃时中断的提示或工具调用，需要判断任务停在哪里再继续。

`vspi web` 当前只输出本机 runtime 地址。安装包不附带独立浏览器前端，也不自动开放远程访问；不能把它等同于部署完整 Web UI 或公网服务。
