# apps/kimi-code：给改这个目录的 Agent 看

`apps/kimi-code` 是 Kimi Code 的终端 / CLI 应用。跨仓库规则见根 `RULES.md`。写或改 TUI 前先读 `.agents/skills/write-tui/SKILL.md`，本文件只保留目录、边界和硬约束。

## 目录

入口链：`src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → SDK `KimiHarness` → `src/tui/kimi-tui.ts`。

- `src/constant/`：CLI 和 TUI 共用的常量，包括产品、协议、路径、终端控制和更新。
- `src/cli/`：参数、子命令和 CLI 启动。
- `src/tui/kimi-tui.ts`：`KimiTUI` 协调器，连接状态、布局、输入框、会话、SDK 事件和对话框，并分发斜杠命令。重逻辑放 `controllers/`。
- `src/tui/tui-state.ts`：全局 UI 状态定义。
- `src/tui/controllers/`：可独立测试的职责，包括 SDK 事件路由、流式渲染、会话恢复与重放、任务浏览、输入框键盘和认证流程。
- `src/tui/commands/`：斜杠命令定义、解析、排序和技能命令生成。
- `src/tui/components/`：按界面类型组织的 pi-tui 组件，包括 chrome、dialogs、editor、media、messages、panes。
- `src/tui/reverse-rpc/`：把 SDK 的审批和提问回调桥接到界面。
- `src/tui/theme/`：主题、颜色 token、样式辅助和终端背景检测。
- `src/tui/utils/`、`src/utils/`：TUI 专用工具和应用级工具（剪贴板、git、历史、图片、进程、用量）。

## 边界

- `cli` 只解释参数、组装启动参数并调用 TUI，不写交互逻辑。
- `KimiTUI` 只做协调，不堆积业务规则；能独立测试的新逻辑先放进 `controllers`、`commands`、`components`、`reverse-rpc` 或 `utils`。
- `components` 只负责展示和局部交互，不直接调用 SDK，也不直接读写会话状态。
- `reverse-rpc` 把审批和提问请求转成面板需要的数据，再把用户选择转回 SDK 响应。
- 主题是颜色和样式的唯一来源。组件不能绕过主题直接用 chalk 具名颜色；需要新语义时先在 `ColorPalette` 增加字段，并同时补亮色和暗色。亮色主题正文对比度至少 4.5:1，边框和大块界面至少 3:1。样式要在渲染路径上按当前 palette 生成，不能在模块顶层缓存。
- `utils` 放不依赖 UI 状态的函数；需要 `TUIState` 或组件实例的逻辑不要放在应用级 `src/utils`。
- 只能通过 `@moonshot-ai/kimi-code-sdk` 使用核心能力，不能直接 import 引擎包。
- 工作区信任确认之前的启动路径不能用裸命令名启动子进程。必须用 `src/utils/process/resolve-command.ts` 的 `resolveCommandPath`，它只接受 PATH 里的绝对路径，并拒绝当前目录里的同名程序。
- `handleInput(data)` 里比较可打印字符时，禁止写 `data === 'q'` 这类字面量。Kitty 键盘协议下这些键会变成 CSI-u 序列，必须先用 `src/tui/utils/printable-key.ts` 的 `printableChar(data)` 解码；功能键继续用 `matchesKey(data, Key.*)`；控制字符（码点小于 32）可以直接比较原始 `data`。`test/tui/printable-key-guard.test.ts` 会检查。
- 不要用 `chalk.red`、`chalk.white`、`chalk.gray` 等具名颜色；`test/tui/chalk-named-color-guard.test.ts` 会检查。
- 不要过度封装，一两行的函数直接内联。常量放在对应的 `constant` 目录，不散落在组件或逻辑里。
- 可选对象属性直接传 `undefined`，不要用条件展开；类型里不要额外写 `| undefined`。单参数内部方法不要为了统一风格改成 options 对象。除包的入口 `index.ts` 外，其他 `index.ts` 使用 `export * from './module';`。
