# VSPi Desktop：给改这个目录的 Agent 看

- `src/main` 负责 SSH 进程、认证、Klient 连接和运行时 token。渲染进程只能通过隔离的 preload 拿到 `src/shared.ts` 声明的操作。
- `src/renderer` 负责 React 界面。终端固定在右侧面板；隐藏标签页不能销毁对应 PTY。关闭 Desktop 要释放连接，但不能取消 Agent 任务。
- 凭据不能进入渲染进程的读取结果、localStorage、日志或错误消息。Provider 编辑使用远端带修订号的设置服务。
- 远端 HTML / SVG 只当数据处理，不能当特权文档。保持上下文隔离、渲染进程沙箱、CSP 和 IPC 发送方校验。
- 开发入口由 `KIMI_CODE_EXPERIMENTAL_DESKTOP=1` 显式打开。Linux 是当前验收平台；声明支持其他平台前先补对应检查。
- 构建、类型检查和测试：`pnpm --filter @vsp/vspi-desktop build`、`typecheck`、`test`。交互测试夹具放 `.tmp/`；生命周期测试使用隔离的运行时 home 和 SSH 服务。
- 界面文案遵循 Hypo-Expression 的 Web UI 规则：正常状态保持安静，说明放上下文帮助里，不重复操作，也不显示实现标签。
- 新增或修改配置文件时，同步检查根 `RULES.md` 里与 VSPi 运行时、凭据和发布有关的约束。
