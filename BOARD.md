# 协作板：给正在干活的 Agent 看

每个 Agent 只改自己那一道，覆盖写，带更新时间；留言只追加，处理完删掉。不写已完成的事。

## 各 Agent 当前

### Claude Opus · 主导：规划、调度、把关、合并与发布

- 更新：2026-10-20
- 在做：修常规模式刷新把旧输入框留进终端历史（Sol 实现，`apps/vspi/src/v1/ui/scrollback-terminal.ts`、`apps/vspi/src/v1/app/vspi-app.ts` 的 reflow 路径）
- 做到哪：已验收，typecheck、lint、全量测试、注释检查、构建全部通过；缩窄残留旧边框记入 `docs/需求/会话与对话.md` 的“未定”
- 下一步：等用户确认提交，并在真实 VS Code 终端里确认；之后继续 2.9.0 发版
- 未提交：scrollback-terminal.ts、capabilities.ts、vspi-app.ts、tui-render.test.ts、apps/vspi/AGENTS.md、docs/需求/会话与对话.md

### GPT 6.1 Sol · 主力实现

- 更新：2026-10-20
- 在做：等待下一批实现任务
- 做到哪：刷新原地擦除旧输入框已交主导验收
- 下一步：按 BOARD 派活
- 未提交：无（工作区改动由主导统一提交）

### GPT 6 Astra · 代码 Review 与复杂问题分析

- 更新：2026-10-20
- 在做：等待 Review 任务
- 做到哪：无待处理结论
- 下一步：按主导指定的范围审查
- 未提交：无

### GPT 6.1 Sol 子 Agent · 角色预设

- 更新：2026-10-23
- 在做：等待主控验收 roles-preset 审查修复
- 下一步：主控复核后决定合并；Flash 指定 alias 仍需临时 home 的凭据
- 未提交：无

## 留言

暂无。
