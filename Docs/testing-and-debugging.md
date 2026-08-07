# 测试与调试手册

这份文档记录 VSPi 新功能、Bug 修复和 TUI 问题的固定验证方法。目标是先用最小证据复现和定位，再按风险扩大验证范围；不要在每次源码修改后机械地重新构建整个项目。

## 1. 验证层级

每项修改先写清一条可观察的失败契约：输入、终端尺寸、初始 Session/配置、期望状态和实际状态。先让最小回归测试失败，再修实现。

| 修改范围 | 首选验证 | 何时扩大 |
| --- | --- | --- |
| 纯函数、数据转换、单个组件 | `npx vitest run test/<file>.test.ts` | 修改共享类型或公共渲染器后运行 `npm run check` |
| 输入路由、Session、Plan、压缩生命周期 | 对应的应用级或 backend contract 测试 | 跨模块行为稳定后运行相关测试组 |
| 光标、滚动、resize、清屏、真实按键 | 定向 PTY 测试；必要时 `npm run test:pty` | 视觉链路或终端控制序列变化后运行全部 PTY 测试 |
| TypeScript/Biome | `npm run check` | 一个完整修改批次结束时执行 |
| `dist/index.js`、本地 `vspi`、npm 包 | `npm run build` 后测试实际入口 | 交付或发布前执行完整安装 smoke |
| 最终交付或高风险公共改动 | `npm test`、`npm run smoke` | 发布前再按 `Docs/ci.md` 检查 Pipeline 和包安装 |

注意：`npm test` 有 `pretest`，会自动执行 `npm run build`。不要紧接着先手动 build 再运行 `npm test`，否则会重复编译。日常源码循环使用 `npm run dev`、`tsx src/index.ts` 或定向 Vitest；只有要验证 `dist`、本地命令、打包内容时才显式 build。

一个 Bug 至少要留下：

1. 能稳定复现旧行为的测试或 fixture。
2. 最低层的确定性回归断言。
3. 若涉及终端语义，再补真实 PTY 回归。
4. 修复批次结束时运行与影响面相称的检查，并记录未运行的检查。

不要只断言“某段文字出现过”。对布局和连续性问题，应断言顺序、坐标、当前 viewport、光标位置、终端尺寸变化后的不变量，以及旧内容是否仍可达。

## 2. PTY 测试

`test/pty-harness.ts` 使用 `@homebridge/node-pty-prebuilt-multiarch` 启动真实 PTY，并用 `@xterm/headless` 解释终端控制序列。现有入口：

```bash
npm run test:pty
npx vitest run test/pty-continuity.test.ts
npx vitest run test/pty-scrollback.test.ts
```

新增场景优先复用 `PtyHarness`：

- 用隔离的临时 `HOME`、`XDG_CONFIG_HOME` 和 `PI_CODING_AGENT_DIR`，避免真实用户配置污染确定性测试。
- 用唯一 sentinel 标记每个阶段，例如 `AFTER_COMPACTION_2`，避免匹配旧输出。
- `waitFor()` 搜索的是整个 scrollback，只能证明内容曾经写入。等待流式输出稳定后，再用 `screenText()` 断言当前屏幕。
- `scrollbackText()` 用于证明历史仍存在、无不可交互的“已折叠 N 条”等占位。
- 模拟会改变 xterm viewport 的真实用户按键时使用 `userInput()`；仅向子进程发送原始输入时使用 `write()`。
- resize 同时作用于 PTY 和 headless xterm。启动瀑布至少覆盖 20、40、60 行，另覆盖窄屏；关键 takeover 面板还要覆盖高终端。
- 异步刷新后留出短暂 settle 时间，再读取坐标，避免在输出队列中途采样。
- 每个 harness 都在 `finally` 中关闭。

关键几何量来自 `harness.terminal.buffer.active`：

- `baseY`：原生 scrollback 的底部基线。
- `viewportY`：当前可见窗口起点；跟随最新输出时应等于 `baseY`。
- `cursorX` / `cursorY`：物理光标位置；主界面中应位于 Composer 内且不能落到 status 下方。
- `length`：buffer 总行数，可辅助判断历史是否真的进入原生 scrollback。

TUI 连续性回归至少覆盖以下场景：

- 完成一轮后，最新回答、Composer、status 顺序连续，没有巨大空白，viewport 留在底部。
- 启动后 Splash 与 Composer 必须同时位于当前 viewport；高终端不得预先制造整屏 scrollback，也不得把 Composer padding 到底部。
- 普通 Composer 瀑布可增长到三个终端高度；Inspect 必须回到单屏，选中的历史节点始终可见。
- Question footer/hint 与 Composer 之间必须恰有一行 gutter，等待答案时不能出现虚假 Working。
- Resume 选择器在空列表、普通高度、矮屏和高屏下都有稳定最小/可用高度；选中后显示历史尾部，而不是历史顶部。
- Resume 后 `PageUp` 能逐页到最早历史，内容不会被永久折叠，也不依赖鼠标点击展开。
- 连续触发两次 threshold compaction，每次结束后 Agent 都继续原任务并产生后续 sentinel。
- Plan 的较新刷新先落地、较旧异步响应后到达时，旧响应不得覆盖新 revision，也不得改变 viewport 和光标。
- 会话内改变 Execution Policy 后，保存、resume 和再次打开时仍读取同一策略。

断言布局时使用“历史尾部 < Plan < Composer < status”的相对顺序，并结合精确行号或 buffer 坐标。只检查字符串存在会漏掉“内容在 scrollback 顶部但当前屏幕空白”的故障。

## 3. 定位方法

### 3.1 先确认运行的是哪份代码

源码测试、`dist/index.js`、本地链接命令和包管理器缓存可能不是同一份文件。版本号相同也不能证明入口已刷新。

```bash
command -v vspi
readlink -f "$(command -v vspi)"
volta which vspi
ps -o pid,ppid,lstart,tty,args -p <pid>
pgrep -af 'vspi|dist/index.js|src/index.ts'
```

若测试 `tsx src/index.ts` 已通过而本地 `vspi` 仍旧，先检查命令解析和进程启动时间，再决定是否 build。不要直接把现象归因于缓存。

### 3.2 分离状态、渲染和终端

按以下边界逐层观察：

1. 持久状态是否正确写入，例如 Session JSONL、自定义 entry、runtime defaults。
2. backend 恢复后是否读到同一 Session 目录和同一状态。
3. App 的 transcript、Plan、panel、Composer 状态是否正确。
4. renderer 输出的行数、顺序和终端高度预算是否正确。
5. PTY/xterm 的 `baseY`、`viewportY`、光标与 scrollback 是否正确。

这能区分“数据没保存”“恢复读错目录”“App 状态正确但 stale async refresh 覆盖”“渲染帧超高触发清屏”“终端 viewport 没跟到底部”等不同根因。

Session 相关测试必须让 create/list/open/switch 使用同一个显式 `sessionDir`。需要验证自定义持久状态时，应读取结构化 custom entry，不要依赖私有对话文本；同时验证写入端和恢复读取端。注意空 Session 可能尚未落盘，fixture 应完成一个可持久化 turn 后再断言。

### 3.3 截图和现场证据

截图先记录像素尺寸、终端列行数、触发步骤和当时运行入口。必要时结合：

```bash
stty -F /dev/pts/<n> size
```

大面积空白、status 缺失或光标停在旧面板底部，通常需要同时检查活动瀑布高度和物理 viewport。遇到跳顶或原生历史消失时，搜索清屏序列 `CSI 2J/H/3J` 及 pi-tui 的 `previousLines`、`cursorRow`、`previousViewportTop`、`fullRender` 路径；稳定前缀只有在完全越过 viewport 后才能 rebase。应用内状态正确并不代表终端物理 buffer 正确。

### 3.4 异步与连续性

Plan、resume、compaction 都可能有迟到事件。刷新实现应携带 revision、generation 或 epoch，在提交前拒绝过期结果；测试要主动构造“新响应先到、旧响应后到”。压缩测试不能只检查摘要生成，还要检查压缩后的 continuation 实际启动、下一段输出出现，并连续执行两次以排除一次性状态残留。

## 4. 历史经验索引

`Docs/bug-audit-2026-07.md` 保留了这轮缺陷的现象、根因和回归证据，尤其包括：

- 超高渲染帧触发 `fullRender(true)`，清屏并破坏原生 scrollback。
- 历史浏览和模型上下文压缩是两套机制，不能用“折叠历史”代替可达的 Session 历史。
- `waitFor` 命中旧 scrollback 不等于当前 viewport 正确。
- App 活动状态与 backend streaming 状态不能各自成为真相源。
- 完成 Plan 或触发 compaction 只是状态事件，不能替代继续实现、修复遗漏和最终验证。

`Docs/ci.md` 是发布验证权威。创建版本和 Tag 前必须先确认目标提交的 CI 状态；发布阶段使用已验证的同一产物，不因单次发布失败随意增加版本号。
