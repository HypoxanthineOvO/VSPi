# 项目规则：给本项目的 Agent 和用户看

只写这个项目自己的事，通用的干活方式在 `AGENTS.md`。

## 项目一句话

VSPi 是终端编码助手。VSPi 2.x 由本机 daemon 承载会话、模型配置与后台任务，终端界面和非交互命令通过本机 IPC 接入。仓库是 TypeScript monorepo，`apps/vspi` 是主产品；`apps/kimi-code` 是仍在维护的 Kimi Code CLI。

## 构建与测试

环境：Node.js `>=24.15.0`（根 `package.json` 的 `engines`，`.nvmrc` 为 `24.15.0`），pnpm `10.33.0`（`packageManager`）。`.npmrc` 开启了 `engine-strict`，Node 版本不符时 `pnpm install` 会直接失败。

- 安装依赖：`pnpm install`
- 全量校验：`pnpm check:vspi`（lint、sherif、五个包的 typecheck 与测试、agent core 引擎包的 import 边界）
- 构建 VSPi：`pnpm --filter vspi build`
- VSPi 类型检查：`pnpm --filter vspi typecheck`
- VSPi 测试：`pnpm --filter vspi test`
- Core 测试：`pnpm --filter @moonshot-ai/agent-core-v2 test`
- Klient 测试：`pnpm --filter @moonshot-ai/klient test`
- Lint：`pnpm lint`（`scripts/check-no-comments.mjs` 加 oxlint）
- 发布器测试：`node --test scripts/github-release-producer.test.mjs`

VSPi 发行包支持 Node.js `>=22.19.0`，低于 monorepo 的构建基线。运行时版本守卫、包 `engines`、bundle 目标和最低版本包校验必须一起改。

## 文档地图

写记录前先在这里找位置；表里没有的地方不新建记录。

| 放什么 | 在哪 | 怎么写 |
| --- | --- | --- |
| 给用户看的说明 | `README.md` | 是什么、怎么装、怎么用 |
| 中文 README | `README.zh-CN.md` | 与 README 保持同步 |
| 贡献指南 | `CONTRIBUTING.md` | 开发、测试、提交和 PR 流程 |
| 中文贡献指南 | `CONTRIBUTING.zh-CN.md` | 与英文贡献指南保持同步 |
| 安全说明 | `SECURITY.md` | 漏洞报告方式和安全边界 |
| VSPi 用户与开发文档 | `apps/vspi/docs/` | 使用说明、版本记录、开发与发版 |
| VSPi 技能说明 | `apps/vspi/skills/` | 随 VSPi 发布的技能 |
| Kimi Code 版本记录 | `apps/kimi-code/CHANGELOG.md` | 按版本记录用户可感知的变化 |
| VS Code 扩展文档 | `apps/vscode/CHANGELOG.md` | 版本记录 |
| VS Code 扩展迁移说明 | `apps/vscode/docs/` | 旧版迁移步骤 |
| 浏览器文档站入口 | `docs/index.md` | 站点首页 |
| 浏览器文档站（英文） | `docs/en/` | 用户文档，规则见 `docs/AGENTS.md` |
| 浏览器文档站（中文） | `docs/zh/` | 与英文镜像，规则见 `docs/AGENTS.md` |
| 产品现在的样子 | `docs/需求/` | 一个功能一个文件，见 `docs/需求/AGENTS.md` |
| 用户认可的界面 | `docs/截图/` | 验收参照，见 `docs/截图/AGENTS.md` |
| 部署与运维 | `docs/运维/` | 脚本入口在 `ops/`，见 `docs/运维/AGENTS.md` |
| 整体进度 | `STATUS.md` | 只写走到哪、下一步 |
| 此刻在做什么 | `BOARD.md` | 各 Agent 只改自己那一道 |
| 分区代码规则 | `apps/vspi/AGENTS.md` | 其余分区读各自目录里的规则文件 |
| 共享包代码与随包文档 | `packages/` | 代码、README、版本记录、设计说明和提示词；提示词按产品行为处理 |
| 官方插件 | `plugins/` | 插件代码、技能说明和版本记录 |

没有 `archive/` 分区。旧记录不迁入本仓库，也不从旧文档转写结论。

## 分工

| 谁 | 负责什么 | 不碰什么 |
| --- | --- | --- |
| Claude Opus | 主导：规划、调度、把关、合并与发布 | 不亲自做大段实现 |
| GPT 6.1 Sol | 主力实现 | 不自行发布、不改发布流程 |
| GPT 6 Astra | 代码 Review 与复杂问题分析，结论由主导按风险取舍 | 不直接改代码 |

子 Agent：DeepSeek Flash 做阅读和批量修改。派活要写清做什么、怎样算做完、不许碰什么；结论抽查后再用。

## 汇报格式

先说结论，在对话里讲清楚，不只给文件路径。再写改了什么、为什么、验证命令与结果、还没做或有疑问的地方。能用用户的入口复现的，就说在哪个入口看到了什么结果。

## 禁区

- `packages/agent-core-v2`、`packages/kap-server`、`packages/transcript` 内不写任何注释，包括 JSDoc；只允许 `oxlint-disable` / `eslint-disable` 这类抑制指令。`scripts/check-no-comments.mjs` 会检查，`pnpm lint` 会跑。
- 增删 workspace 包必须同时改 `pnpm-workspace.yaml` 和 `flake.nix` 的 `workspacePaths`、`workspaceNames`，包括没有人依赖的叶子包。`scripts/check-nix-workspace.mjs` 只检查 `@moonshot-ai/kimi-code` 的依赖闭包，绿灯只覆盖这条依赖闭包，增删包仍要手工同步。
- 可选对象属性直接传 `undefined`，不要用条件展开；类型里不要额外写 `| undefined`。单参数内部方法不要为了统一风格改成 options 对象。函数只按抽象层次拆分，单调用点的薄包装直接内联。
- 除包的入口 `index.ts` 外，其他 `index.ts` 使用 `export * from './module';`。
- 优先用 `#/...` 导入。`packages/agent-core-v2` 的 import 边界由 `pnpm --filter @moonshot-ai/agent-core-v2 lint:imports` 检查。
- 不新增大量测试文件；优先把测试加进对应模块已有的测试文件。用户改动导致测试失败时，先修测试；只有实现确实有 bug 才改实现。
- 不为外部兼容牺牲代码质量，除非用户明确要求。破坏性变更走 changeset 和 `major`，`major` 必须由用户确认。
- 改终端界面先读 `.agents/skills/write-tui/SKILL.md`。`handleInput` 里的可打印字符必须用 `printableChar(data)` 解码，不能写 `data === 'q'`；`apps/kimi-code/test/tui/printable-key-guard.test.ts` 会检查。
- `apps/kimi-code` 的组件不能直接用 chalk 具名颜色；主题 token 和亮/暗对比度要求由 `apps/kimi-code/test/tui/chalk-named-color-guard.test.ts` 检查。新语义先在 `ColorPalette` 增加字段，并同时补 `darkColors` 和 `lightColors`。
- 工作区信任确认之前的启动路径不能用裸命令名启动子进程；必须用 `resolveCommandPath`，它会拒绝当前目录里的同名程序。
- `apps/vspi/src/v1` 是 VSPi 界面、命令、面板和 Klient 投影的事实来源。VSPi 的问题不要先去 `apps/kimi-code` 修，除非代码证据表明缺陷在共享包。
- `apps/kimi-code` 只能通过 `@moonshot-ai/kimi-code-sdk` 使用核心能力，不能直接 import 引擎包。
- 浏览器 Web UI 的源码不在本仓库。它作为预构建包 `apps/kimi-code/dist-web` 提交；改 Web UI 要在 code-app 仓库同步后，在同一变更里提交该 bundle。`apps/kimi-code/scripts/check-web-assets.mjs` 会拦截缺失的 bundle。
- VSPi 的模型列表、默认模型与用户差异只存在 VSPi home 的 `config.toml`；不要导入 `.pi` 或旧 runtime 默认值，远程模型目录不能覆盖内置默认值和用户字段。
- `/model` 选中的模型先暂存，确认 Effort 后才生效；Esc 不能改变当前绑定。选择器不显示 Off，Effort 按模型别名保存在 `thinking.modelEfforts`，恢复会话时不能用全局默认值覆盖。
- 主 Agent 的星标是官方常用模型选择，和子 Agent 候选池独立；只有 `/subagent-model` 修改 `secondary_model`，不能用星标生成候选池，也不能在编辑候选池时改主模型。
- daemon 与客户端必须显式校验构建和 Node 版本；不能静默接入不同构建或不支持版本的 daemon。嵌套 `vspi` 调用使用 daemon 自己的可执行文件和默认 home，不用继承 PATH 上碰到的其他安装。
- 后端权限模式是权威来源；UI 只反映权限事件。恢复已有会话时不要重新应用草稿里的权限选择。
- 转写顺序固定：更新工具或任务时改原节点，不移动到末尾。常规模式下滚出视口的行已经冻结进原生滚动区，不能再改写；不得清空原生滚动区或发送 `ESC[2J`。
- 模型上下文、价格、用量和缓存标签各自只表达一个指标和来源，不能把累计计数当成当前上下文。
- 不提交草稿、交接或总结文档（`HANDOVER-*`、`HANDOFF-*`、`handoff.md` 等），也不提交临时界面原型（`*-design(s).html`、`*-mockup.html`、`*-demo(s).html`）。临时文件放 `.tmp/`。提交前看 `git status` 和 `git diff --staged --stat`。
- 公开文本和测试数据里的真实内部标识换成 `example.com`、`example.test`、`YOUR_API_KEY` 这类占位符。
- 涉及 `packages/agent-core-v2/docs/` 下的 manifest、kap-server 的 API surface 快照、`packages/node-sdk/src/index.ts`、external hooks、`packages/acp-server/`、`apps/kimi-code/src/cli/` 时，按对外契约处理：说明谁在消费，以及旧版本的数据和客户端怎样继续工作。
- 删改 `packages/agent-core-v2/src/**/*.md` 属于改 Agent 行为；要说明哪些用户会收到这段提示词、原来约束了什么、现在由什么约束。
- 审查变更要逐项列出被改变的行为，不只找 bug。删掉或收窄的分支、默认值、提示词句子，要交代原来谁会走到、现在去哪里；新增条件要交代哪些旧输入会先命中。
- 翻转默认值或移除行为，要写明用户失去了什么，并提供配置、环境变量或 flag 的退路。重构或移植要带旧路径的功能清单，不能静默丢功能。
- 静默失败比崩溃更严重：静默忽略配置、静默放行或跳过操作、静默丢数据，都按最高严重度处理。
- 只在需要的功能上用实验 flag。flag 由环境变量驱动且默认关闭：`KIMI_CODE_EXPERIMENTAL_<NAME>` 控制单个，`KIMI_CODE_EXPERIMENTAL_FLAG` 打开全部；优先级是单 flag 环境变量 > `[experimental]` 配置 > 总开关 > 默认值。发布时把默认值改成 `true`。agent core 引擎包和 kap-server 没有中心目录，在所属域用 `registerFlagDefinition` 注册，再用 `IFlagService.enabled(id)` 判断。
- VSPi 走自己的 tag 发布流程，不创建 Kimi Code 的 changeset。其余改动按 `.agents/skills/gen-changesets/SKILL.md` 写 changeset，只写用户能感知的一句话；`major` 必须停下来先问用户。
- 创建 PR 时按 `.agents/skills/write-pr/SKILL.md` 写描述，填 `.github/pull_request_template.md`，不写空泛的 AI 总结；PR 标题用 Conventional Commit 风格。

## 不需要描述

以下路径是生成物、第三方物或临时产物，`hw check` 和文档描述可以跳过：

- `dist/`、`dist-single/`、`dist-native/`、`coverage/`、`*.tsbuildinfo`
- `apps/kimi-code/dist-web/`（从 code-app 同步的预构建 bundle）
- `apps/vspi/src/generated/`、`packages/agent-core-v2/src/generated/` 及由脚本生成的契约类型
- `apps/vspi/.tmp/`、仓库根 `.tmp/`、`docs/node_modules/`
- `node_modules/`、`pnpm-lock.yaml`（依赖变更本身要说明，但不用逐行描述锁文件）
- `packages/migration-legacy/`（历史迁移代码，只在不改行为时保持原样）
- 第三方 vendored 代码 `packages/pi-tui/`，改它按该目录 `AGENTS.md` 处理
