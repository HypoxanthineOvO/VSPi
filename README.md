# VSPi

VSPi 是一个 daemon 驱动的终端 AI 编码 agent：常驻运行时承载多个并行会话与后台任务，TUI / 非交互执行 / Web 界面共享同一套会话与配置。它衍生自 Kimi Code（`kimi-upstream` 远端保持同步），在此之上按我们自己的需求演进。

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) · [Releases](https://github.com/HypoxanthineOvO/VSPi/releases)

## 安装

需要 Node.js ≥ 24.15.0。

```sh
VERSION=2.2.0
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v${VERSION}/vspi-${VERSION}.tgz"
```

```sh
vspi            # 交互式 TUI
vspi update     # 自更新到最新发布版
```

## 架构：daemon 承载一切

TUI 不是唯一入口，而是 daemon 的一个前端。会话、任务、模型目录都活在 `vspi daemon` 里，终端退出不打断工作：

- **多会话并行** —— `vspi continue` / `vspi resume` 无损续接；一个工作区多个会话互相独立。
- **后台任务** —— 运行中的任务可 `Ctrl+B` 转后台，退出 TUI 后由 daemon 继续执行，随时接管回来。
- **非交互执行** —— `vspi exec "<prompt>"` 单发执行，`resume` 续接既有会话，适合脚本与流水线。
- **只读检查** —— `vspi inspect [paths|models|session <id>]` 不惊动运行中的任务。
- **Web runtime** —— `vspi web` 输出本机 Web 界面地址，浏览器里继续同一个会话。

### 可靠性（2.2.0）

daemon 与前端之间走本机 IPC（token 鉴权 + 归属校验）。针对历史上 daemon 崩溃导致前端卡死的问题，2.2.0 做了三层加固：

- **目录扫描限额**：工作区文件列举改为流式读取（`opendir`），单目录 1 万条、整次遍历 20 万节点封顶，超限目录跳过并标记截断——彻底消除"巨型目录把 daemon 撑爆（OOM）"这一类崩溃源。
- **断线自动恢复**：TUI 遇到 `ipc closed` 时按退避策略自动重连；daemon 已死则原地重新拉起（版本身份校验通过后无缝恢复当前会话），连续 5 次失败才提示手动重启。
- **崩溃取证**：daemon 带 `--report-on-fatalerror` 与近堆顶 heap snapshot 诊断参数启动，报告落在 `~/.vspi/server/diagnostics/`；发现前次异常退出时会在 runtime 日志记录 `runtime.stale-state-removed` 事件。

> 传输层选型说明：klient 的 IPC 通道保持"断开即终态"的简单语义，可恢复连接由前端连接管理层负责（即上面的自动恢复）。跨机器访问走 daemon 的 REST/WS 面（`vspi web`）。

## 长程自治

- **`/goal` 持久目标** —— 目标契约固化（轮数 / token 预算 / 验收约束），模型只能通过 checkpoint / block / complete 工具汇报进度，不可自行宣告完成；支持 pause / resume / accept。
- **Tower 任务** —— 多任务任务面板，任务状态实时投影到 TUI。
- **`/cron` 定时任务** —— 定时触发 prompt，一次性和周期任务统一管理。
- **Subagent 模型池** —— 子 agent 可配置独立模型与超时，`/agents` 面板统一查看。

## VSPLab 中转站生态

VSPi 与 VSPLab 复合中转站深度协同（也可完全脱离它使用任意兼容端点）：

- **远程模型目录** —— 启动时拉取中转站的 `/vsp/models` 静态目录（[Golden 标准数据](ops/vsplab/model-catalog.json)，逐模型对照官方文档核实），新模型上线不需要发新版客户端；每 6 小时自动刷新。
- **effortLevels 契约** —— 中转站声明的思考档位即权威：VSPi 不再用本地内置目录做交集。例如 GLM-5.3 如实呈现 `low/high/max` 三档（默认 `max`），Claude 系呈现 `low…max`（无 `minimal`）。
- **多家族协议路由** —— 同一端点后按模型家族选择 OpenAI / Anthropic / Gemini 协议，内置 DeepSeek、Moonshot/Kimi、智谱、MiniMax、小米 MiMo 等国内外主流 Provider。
- **自定义中转站向导** —— `vspi config` 三分钟接入任意 OpenAI 兼容端点：名称 + Base URL + API Key，自动发现模型列表。

## TUI 体验

- **Question 卡片** —— 模型主动提问时以结构化选项卡片呈现，选择即回填。
- **Steer 与追问队列** —— 生成中途可以直接插话改向（steer）或排队追问（follow-up），不丢上下文。
- **状态栏** —— 模型 / effort / 上下文占用、输出速度、缓存命中率、累计费用一目了然。
- **Todo / Plan 双层面板** —— 任务清单与计划步骤分层投影，`/tasks`、`/goal` 面板随时唤出。
- **`/copy`** —— 一键复制最近一条正式回复（X11 / Wayland / macOS 自适配）。

## 会话资产

- **`/import` 会话导入** —— 把 Codex / Claude Code 的历史会话转换为原生 VSPi 会话（保留可见对话与压缩点，丢弃工具噪音，凭据脱敏）。
- **`vspi-self` 内置 skill** —— 模型可自助读取自身配置与诊断信息，配合用户完成自配置、自调试。
- **独立 HOME** —— `VSPI_HOME` 环境变量隔离整套配置与会话存储，多版本并存互不干扰。

## 配置速览

配置文件 `~/.vspi/config.toml`（TOML，改后重启生效）：

```toml
default_model = "vsplab/glm-5.3"

[providers.vsplab]
base_url = "https://api.vsplab.cn/v1"
type = "openai"

[models."vsplab/glm-5.3"]
provider = "vsplab"
model = "glm-5.3"
max_context_size = 1000000
```

凭据用 `vspi login <provider>` 交互配置；`vspi config` 查看分层配置与诊断。常用命令面：`vspi exec / inspect / web / daemon <start|status|stop|logs> / update`。

## 开发

```sh
pnpm install
pnpm -C apps/vspi test     # 前端测试
pnpm -C packages/agent-core-v2 test
pnpm run lint
```

- `apps/vspi` —— VSPi 前端（TUI、命令注册、目录投影），见 `apps/vspi/AGENTS.md`。
- `packages/vsp-runtime` —— daemon 生命周期、租约、连接与配置迁移。
- `packages/agent-core-v2` / `kap-server` / `klient` —— DI × Scope agent 引擎、服务面与客户端 SDK。
- `ops/vsplab/` —— 中转站 Golden 模型目录与部署说明。

发布走 tag 触发（`v*` → GitHub Release），与上游 Kimi Code 的变更流互不干扰。

## 致谢

VSPi 衍生自 [Moonshot AI 的 Kimi Code](https://github.com/MoonshotAI/kimi-code) 并持续同步上游引擎改进；产品形态、中转站生态与自治能力由 VSPi 独立演进。TUI 基座来自 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)，感谢上游作者。
