# 文档站：给写 `docs/` 的 Agent 看

`docs/` 是 VitePress 用户文档站。`docs/en/` 和 `docs/zh/` 是镜像目录，路径、标题和章节结构保持一致；改一边要在同一次改动里改另一边。发布前确认两边都没有断链和术语错误。

## 结构

- 语言目录：`docs/en/`、`docs/zh/`。
- 导航和侧边栏定义在 `docs/.vitepress/config.ts`。新增或改名页面要在两种语言里都登记。
- 栏目：指南（getting-started、migration、use-cases、interaction、sessions）、定制（mcp、skills、plugins、datasource、agents、hooks）、配置（config-files、providers、overrides、env-vars、data-locations）、参考（kimi-command、tools、slash-commands、keyboard）、版本记录。
- 版本记录以英文页 `docs/en/release-notes/changelog.md` 为准，中文页从英文翻译；它由 `sync-changelog` 技能从 CLI 包的 `CHANGELOG.md` 同步。
- 其他页面都是双语镜像。先用一种语言改写，再同步另一种。

## 读者

文档同时服务两类人，写作时两边都照顾：

- 技术读者：熟悉终端、配置文件、API 密钥和环境变量。直接给命令和路径，不解释基础概念。
- 非技术 AI 用户：产品经理、设计师、运营。他们通过 VS Code 或配置文件使用工具，不写脚本。目标是照着复制粘贴就能跑起来，并大致知道在做什么。

术语第一次出现时用括号给一句白话解释，之后正常使用。例如 `stdin`（程序读取输入的通道）、`exit code`（程序结束时返回的状态数字，0 表示成功）。

目标：技术读者 5 分钟内完成任务；非技术读者能复制粘贴完成配置，不需要理解底层机制。

## 命名与用词

- 文件名用 kebab-case，中英镜像使用相同的 slug。
- 章节标题和侧边栏文案保持一致。不要改一级标题和导航名称。
- 英文二级及以下标题用 sentence case，专有名词除外；`Wire`、`Plan mode`、`Thinking mode`、`Always Ask`、`Ask When Needed`、`Never Ask` 按专有名词处理，`agent` 不算专有名词。
- 中文标题里的英文词保持原词形；专有名词按下表保留。
- 英文用 `API key`，中文用 `API 密钥`。`JSON`、`JSONL`、`OAuth`、`macOS`、`Node.js`、`npm`、`pnpm`、`TypeScript` 保持原样。
- 中文引号内容用直角引号加空格：`「工具」`；普通引用用直双引号并和中文之间留空格：`"被引内容"`。
- 中文优先用“终端”，不用“命令行”。用“工具调用” / `tool call`，不用“工具使用”。
- 工具名用行内代码，例如 `Read`、`Grep`、`Bash`。
- 专有名词：Agent（中文保留 Agent）、Shell（中文保留 Shell）、Plan 模式 / Plan mode、始终询问 / Always Ask、必要时询问 / Ask When Needed、完全自动 / Never Ask、Thinking 模式 / Thinking mode、MCP、Kimi Code CLI、Agent Skills、Skill、API 密钥、JSON、JSONL、OAuth、macOS、TypeScript、Node.js、npm、pnpm、kimi。
- 中文正文用全角标点。中英文、数字、行内代码和链接之间加空格，全角标点前不加。
- 快捷键用连字符：`Ctrl-C`、`Ctrl-D`、`Shift-Tab`、`Alt-V`。产品自己输出的提示保持原样。
- 代码块必须写语言（`sh`、`toml`、`json`、`ts` 等）；用户提示这类自然语言示例可以省略。
- 提示块用短分类标题：中文 `提示` / `注意` / `说明` / `警告`，英文不写标题或写 `Note`。详细内容放正文，标题只放分类。
- 版本变更用 `::: info` 加分类标题（新增 / 变更 / 移除，或 Added / Changed / Removed），正文写完整句子。
- 独立提示块用 `:::`；`::::` 只能作为嵌套的外层围栏，并且必须正确闭合。不需要嵌套时，次级说明用 `>` 引用块。

## Kimi 平台

两个平台不能混：

| | Kimi Code 平台 | Kimi 开放平台 |
| --- | --- | --- |
| 用户 | 个人开发者，订阅制 | 企业 / 产品集成，按 token 计费 |
| OpenAI 兼容地址 | `https://api.kimi.com/coding/v1` | `https://api.moonshot.cn/v1` |
| Anthropic 兼容地址 | `https://api.kimi.com/coding/` | 不支持 |
| API 密钥入口 | Kimi Code 控制台 | `platform.kimi.com` |

写 Kimi Code CLI 或 VS Code 时只能用 `api.kimi.com/coding/…`，不能写 `api.moonshot.cn`。写开放平台集成时用 `api.moonshot.cn/v1`。产品全名是 **Kimi Code CLI** 和 **Kimi Code for VS Code**，不要缩写。

## 写作

- 用自然叙述组织内容，带读者从概念走到操作。说明、动机和连续推理写成段落，不要拆成标题列表。
- 每个段落只讲一件事，目标 3–4 句；超过 5 句就拆。
- 每个页面和主要章节先用一句话说明这一节讲什么、和前面什么关系，再展开细节。
- 并行内容才用列表或表格：每项“名称 + 一句话”用无序列表；多个维度（名称、类型、说明）用表格；每项超过两句用三级标题。
- 步骤有先后顺序时用有序列表，不在步骤里嵌子列表。
- 指南 → 定制 → 配置 → 参考，信息逐层加深。入门页只介绍核心概念，细节放到后面的页面。
- 不要加“接下来”提示块；相关页面确实存在时，可以在末尾写 `Next steps` 或中文的“下一步”。
- 跨页概念第一次出现就链接，优先链接到具体章节而不是页面顶部。不要只写“见相关文档”，也不要把链接都堆在页面末尾。
- 页面结构：标题（名词短语，不加句号）→ 开头一两句 → 可选提示块 → 补充背景 → 可选图示 → 警告条（弃用、破坏性变更、安全提示，放在开头内容和第一个二级标题之间）→ 正文章节 → 可选下一步。
- 改页面时默认保留全部原有内容。每个内容块都要有明确去向：保留，或说明为什么删。有效理由只有三类：纯实现细节、已被其他页面完整覆盖、内容可疑或过时（标出来而不是静默删掉）。“看起来不重要”“不确定”“页面太长”都不是删除理由。删了内容要在 PR 描述或提交信息里说明。

## 发布前检查

- `::::` 是否正确闭合，嵌套提示块是否改成引用块，警告条位置是否正确。
- 步骤是否写成有序列表，多维对比是否写成表格。
- 术语第一次出现是否有白话解释，跨页概念是否有链接，前后概念是否有回链。
- 中英两边是否同步，代码块是否都有语言标记。
- Kimi 平台地址、升级命令、模型 ID、登录命令、产品全名是否和全站一致。

## 构建

在 `docs/` 下运行：

```sh
npm install
npm run dev
npm run build
npm run preview
```

构建输出在 `docs/.vitepress/dist`。
