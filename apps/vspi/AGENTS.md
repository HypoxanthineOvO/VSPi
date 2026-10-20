# VSPi：给改这个目录的 Agent 看

VSPi 和 Kimi Code 是两个产品。VSPi 的 TUI、斜杠命令、转写、面板、状态栏和 Klient 投影都以 `src/v1` 为准；VSPi 的界面问题不要先去 `apps/kimi-code` 修，除非代码证据表明缺陷在共享包。

## 目录

- `src/main.ts`、`src/daemon-environment.ts`、`src/runtime-identity.ts`：进程启动、daemon 发现、版本兼容和生命周期。
- `src/v1/app`：TUI 协调、输入、会话生命周期、命令分发；`auth-setup.ts` 是 `vspi config` / `login` / `logout` / `proxy` 的界面。
- `src/v1/backend`：把 Klient 事件和服务投影成 VSPi 前端契约。
- `src/v1/ui`：转写、面板、输入框、布局、状态栏、主题和选择器。
- `src/v1/providers`：Provider 列表、登录、代理、模型发现和自定义中转站。
- `src/v1/domain`：命令注册表、模型归并、展示规则等纯逻辑。
- `test`：VSPi 前端、投影和终端行为测试。

## 不能坏

- 转写保持时间顺序。更新工具或任务时改原节点，不移到末尾。常规模式下滚出视口的行已经冻结进原生滚动区，不再改写；冻结后才完成的工具在活动区顶部显示完成摘要，Inspect 和历史视图仍在原时间位置显示最终状态。
- 常规模式不清空原生滚动区，不发送 `ESC[2J` / `ESC[3J`。刷新重建先用 CPR（光标位置查询）定位，再原地擦除旧 dock；等待期间不输出帧，resize、暂停或停止会取消查询。已输出正文不擦除、不重放，新 surface 从擦除起点追加。VS Code 等白名单终端缩窄时共用通用重排公式，结合旧帧行宽和光标列保守计算擦除起点，旧输入框上边框可能残留在终端历史中。CPR 在 200ms 内无响应时不擦除，退回保守上滚。`VSPI_TUI_REFLOW=1/0` 强制开启或关闭缩窄时的折行回退模型；默认由终端白名单决定，未知终端只按逻辑行少擦。
- 转写排版每帧最多处理 200 行，超出部分排队，不能丢。冻结行离开排版缓存；流式表格使用固定列宽；尚未输出的消息在前端保留到真正输出。
- 输入框非空和空的时候，忙碌状态的行为必须区分；中断操作不能丢掉用户已经输入的文本。
- `/agents` 是只读的子 Agent 过程流，宽列表预览和详情共用同一套 commentary/tool/final 投影，不显示思考内容。`/tasks` 是后台任务的独立面板，Agent 行不暴露子对话。子 Agent 的实时状态放在 Agents 区域和 `/agents`，不要放进主转写的子卡片。
- 模型上下文、价格、用量和缓存标签各自只说明一个指标及来源，累计计数不能当成当前上下文。
- 主模型的星标是官方常用模型选择，和子 Agent 候选池无关。`/model` 默认显示星标并允许看全部模型；只有 `/subagent-model` 修改核心 `secondary_model` 里的用户候选。不能由星标生成候选池，也不能在编辑候选池时改主模型。
- 从 2.5.1 起，内置模型默认值随产品发布，用户差异只写在 VSPi home 的 `config.toml`；不要导入 `.pi` 或旧 runtime 默认值。远程目录不能覆盖内置默认值和用户字段。保留旧 `overrides` 的优先级，并验证最终解析结果，不只看来源 JSON。
- `/model` 先暂存模型，确认 Effort 后才生效；Esc 不能改变当前绑定。选择器不显示 Off，Effort 按模型别名保存在核心 `thinking.modelEfforts`，恢复会话时不能用全局默认值覆盖。
- daemon 与客户端必须显式兼容。客户端不能静默接入不同构建或不支持 Node 版本的 daemon。
- 后端权限模式是权威来源。UI 只反映权限事件；恢复已有会话时不要重新应用草稿里的权限选择。
- 嵌套 `vspi` 调用使用 daemon 自己的可执行文件和默认 home，不用继承 PATH 上碰到的其他安装。
- 发布包支持 Node.js `>=22.19.0`，monorepo 构建基线见根 `RULES.md`。运行时守卫、包 `engines`、bundle 目标和最低版本包校验要一起改。

## 测试

- `pnpm --filter vspi test`：VSPi 全部测试。
- `pnpm --filter vspi typecheck`：类型检查。
- 终端渲染和交互改动优先补 `test/tui-render.test.ts`；真实的 daemon 启停和兼容性改动补对应测试。
