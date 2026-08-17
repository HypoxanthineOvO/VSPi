# VSPi

[![Release](https://img.shields.io/github/v/release/HypoxanthineOvO/VSPi?display_name=tag&sort=semver)](https://github.com/HypoxanthineOvO/VSPi/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

VSPi 是 VSPLab 开发的，基于 Pi 的中文终端编程助手。

> 需要 Node.js `>=22.19.0`。

## Quick Start

Release 的 `latest` 地址始终指向最新稳定版本。

Linux / MacOS：

```bash
curl -fL 'https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz' -o /tmp/vspi-latest.tgz && npm install -g /tmp/vspi-latest.tgz
```

GitLab stable latest：

```bash
curl -fL 'https://gitlab.vsplab.cn/heyx/vspi/-/releases/permalink/latest/downloads/vspi-latest.tgz' -o /tmp/vspi-latest.tgz && npm install -g /tmp/vspi-latest.tgz
```

GitHub stable latest：

```bash
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz"
```

Windows PowerShell：

```powershell
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/latest/download/vspi-latest.tgz"
```

安装后检查：

```bash
vspi --version
```

## 首次配置

运行配置入口：

```bash
vspi config
```

选择 **VSPLab** 可配置内置服务；选择 **自定义中转站** 时，VSPi 会依次询问名称、Base URL、接口类型和 API Key，然后尝试从 `<Base URL>/models` 发现模型。端点不支持发现时，可手动输入模型 ID。

也可以直接进入自定义流程或单独管理登录：

```bash
vspi config custom
vspi login kimi-coding
vspi login
vspi logout kimi-coding
```

Provider 元数据保存到 Pi global `models.json`；API Key 和订阅凭据由 Pi `AuthStorage` 保存到 `~/.pi/agent/auth.json`。Secret 不写入模型配置。`vspi init` 在 v1 中仍是兼容 alias，但会提示迁移到 `vspi config`。

## 开始使用

完成配置后运行：

```bash
vspi
```

常用启动方式：

```bash
vspi                  # 开始新对话
vspi continue         # 继续最近一次对话
vspi resume           # 选择历史对话
vspi run "解释这段代码" # 执行一次任务并直接输出结果
```

使用过程中：

- 在输入框中输入内容，按 `Enter` 发送。
- 按 `Tab` 补全 `/` 命令。
- 按 `Shift+Tab` 在输入框、对话记录和计划面板之间切换。
- 按 `Alt+Enter` 添加一条稍后处理的消息。
- 按 `Ctrl+C` 中断当前任务；空闲时再次按下可退出。
- 按 `Ctrl+V` 或 `Alt+V`，可将剪贴板图片发送给支持图片输入的模型。

输入 `/` 可以查看所有可用命令。

## 安全边界

VSPi 提供 Safe、Standard、YOLO 和 Auto 四档执行策略。Safe 最严格、询问最多；Auto 不再询问，执行前请确认你信任当前项目。

## 更新

```bash
vspi update
```

自更新当前跟随 GitLab Release，读取最新稳定版本、校验 SHA-256，并更新当前 npm 或 Volta 安装位置。更新成功后重新运行 `vspi` 即可。

## 详细文档

- [使用手册](Docs/usage.md)
- [TUI 设计与响应式规范](Docs/tui-v1.md)
- [测试与调试](Docs/testing-and-debugging.md)

## v1.0.0 界面与发布契约

### 启动与默认界面

启动序列会先立即写出一行 VSPi 初始品牌占位；初始品牌占位不含 Logo、运行状态或模型声明，最终帧等待应用初始化完成。应用只清理一次当前 viewport，并把保留现有六行块字符 Logo 的最终状态帧作为统一 TUI 瀑布的第一个内容块。最终帧使用初始化后解析得到的真实 Model、`package.json` 解析出的包版本、真实 Backend 与执行 Policy；真实 pi 显示 `Backend Pi`，显式离线后端显示 `Backend Fixture`，边界统一显示 `Policy ... ⋅ Host`。

默认 `regular` renderer 把 Splash、Transcript、面板、Composer 与 Status 放在同一物理瀑布 surface，通过原生 terminal scrollback 保存稳定前缀。`fullscreen` 使用 Pi alternate screen：Transcript 位于独立 `ScrollView`，Panel、queued/activity、Composer 与 Status 组成固定 dock；滚轮、`PageUp/PageDown`、`Home/End` 只移动 Transcript。Splash、Transcript 与 Composer 共享同一坐标轴和瀑布；切换 renderer 不替换当前 Session、draft 或焦点。`VSPi_TUI_MODE=fullscreen|regular` 可覆盖本次启动设置。

在 regular 中，内容触底后才通过 linefeed 推入原生 scrollback；不得用顶部 padding 固定 Composer。默认的新工作区动态界面为空，不加载或预置对话、工具消息、演示计划、usage 或 session；文档中的对话和工具消息一律标为“交互示例”，不是启动内容。空 Plan 只保留安静标题与留白，离线后端明确标识为 `Offline Fixture`。

`80` 列状态固定为两行，并且每行可见宽度严格为 80 列：

```text
+ Plan ‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒+
❘                                                                              ❘
+‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒‒+
```

状态栏示例：

```text
Model OpenAI / GPT-5.4  Effort High                     Context 50K / 128K 39%
/workspace/vspi ⋅ Policy Standard ⋅ Host            Token ▴12k ▾3.0k  Cost ¥1.01
```

动态状态区只包含两条语义轨道：第一行严格为 `Model / Effort / Context`；第二行直接从路径值开始，再显示 `Policy / Token / Cost`，不显示冗余的 `Path` 标题。Backend 只保留在永久 Splash 与诊断信息中，不进入动态行。五个标签与对应值、以及无标题路径值分别着色；Model 与 Effort 使用固定两个空格的小间距。

`Context` 是当前上下文占用、模型窗口和百分比，`Token` 是独立的累计输入/输出量。示例：`Context 50K / 128K 39%  Token ▴12K ▾3K`、`Context 0K / 0K 0%  Token ▴0 ▾0`、`Context ?K / 128K ?%  Token ▴12K ▾3K`。`K` 使用十进制千 token，百分比由未格式化的原始占用量与窗口计算。

Status 在 40 列、80 列和 120 列都恰好两行，并按终端可见列计算；状态左右锚点保持稳定。80 列状态锚点为 `Model 0 / Effort 24 / Context 56`、`路径值 0 / Token 52 / Cost 70`；120 列状态锚点为 `Model 0 / Effort 24 / Context 96`、`路径值 0 / Token 92 / Cost 110`；40 列状态锚点为 `Model 0 / Effort 13 / Context 25`、`路径值 0 / Token 20 / Cost 32`。40 列、80 列、120 列均有对应状态布局与命令布局；长模型和长路径只显示自身省略号，不会推动 telemetry 或覆盖其他字段。

### 交互与响应式布局

单独输入 `/` 会在原 Plan 区域打开完整命令目录，slash 和所有完整命令 cell 都不高亮或强调。生产命令如下：

```text
/new       /sessions   /import     /skills     /compact    /model       /providers   /login
/logout    /update     /plan       /goal       /prompt      /thinking    /effort      /agents
/tools     /policy     /usage      /settings   /theme       /quit
```

`Tab` 是唯一补全键，只处理无参数且唯一候选的 slash token：`/ex ⟶ /exit`、`/qui ⟶ /quit`、`/ses ⟶ /sessions`、`/provi ⟶ /providers`、`/cl ⟶ /clear`。Tab 只修改 composer 文本，不会执行命令，也不写入 history。`/sessions` 的 aliases 是 `/session` 与 `/resume`；`/exit` 与 `/q` 是 `/quit` 的 canonical aliases，`/clear` 属于 `/new`，`/provider` 属于 `/providers`；退出候选显示为 `quit (exit)`。`/exit` 只强调 `ex`，slash 与 `it` 普通；`/quit` 只强调 `qui`，slash 与 `t` 普通。插件/扩展命令保留 package `source` 来源。

Command 工作区在 40 列把每个命令排成身份行与详情/source 行；80 列和 120 列使用稳定的“身份 / 描述 / source”三列。`Model` 在 60 列及以上使用左列表/右详情双栏，窄屏使用显式列表/详情导航。单模型 CNY/人民币输入、输出单价仅显示在右侧详情，模型组不显示价格，也不显示汇率参考行。

用户消息使用焦点色竖标和至少三行的全宽表面，短消息也保留上下留白，不绘制额外 frame。`VSPi Dark` 使用 `#202428`/`#F4F7FA`，Light 使用对应浅色表面，默认 Terminal 不强加前景或背景。40 列、80 列和 120 列下硬换行、长单词和附件摘要都保持宽度安全；Transcript Inspect 只改变选择态，不改变消息尺寸。

每个工作区都有 contextual hint。hint 位于面板 frame之外并直接位于composer上方；Command 的完整提示是 `▴▾ 选择  Tab 补全  Enter 执行  Esc 关闭`。Model hint 随当前真实可用动作生成；窄屏 Model 使用详情动作，60 列以上使用宽双栏。

### 后端与自更新

默认后端是真实 pi，启动入口为 `npm run dev`：

```bash
VSPi_BACKEND=pi npm run dev
VSPi_FIXTURE=1 npm run dev
```

默认启动显示 `Backend Pi`，使用真实 pi 且不回退 Fixture；显式 fixture 显示 `Backend Fixture`。`/update` 与 CLI 的 `vspi update` 当前跟随 GitLab Release，要求固定项目、tag、tarball 名称与下载地址完全一致，下载后按 Release 中的 SHA-256 校验；更新成功后重启 VSPi 生效。

### 图片附件与 Markdown

图片附件已接入真实模型提交；下面是交互示例，不是启动内容：

```text
〔登录页-修改前 ⋅ 1440x900 ⋅ PNG〕
```

本机使用 `Ctrl+V` 或 `Alt+V` 读取图片剪贴板；附件支持重命名、预览、移除与保存到项目，缓存默认位于 `~/.cache/vspi/attachments/<session-id>/`。Markdown 支持 H1/H2、代码块、LaTeX 与 Mermaid；附件是原子节点，安全边界见 [Docs/usage.md](Docs/usage.md)。
