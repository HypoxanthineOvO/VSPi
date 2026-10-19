# pi-tui：给改这个包的 Agent 看

这是 [`earendil-works/pi`](https://github.com/earendil-works/pi) `packages/tui` 的 vendored fork。fork 要尽量小，方便和上游同步。

**同步上游、加本地补丁或审 diff 前先读 [UPSTREAM.md](./UPSTREAM.md)。** 这个 fork 就是相对固定上游提交的差异，UPSTREAM.md 记录每处差异为什么存在。

## 改这里的前提

产品行为放在 `apps/kimi-code/src/tui`（组合、子类化、已有宿主回调）。只有公共 API 表达不了时，才改这个包。

补丁必须满足：

1. 是库缺陷（崩溃、渲染错误），或者是应用够不到的扩展点（输入状态机、渲染热路径、tokenizer）。
2. 是加法：可选参数、回调或默认关闭的开关；默认行为与上游一致。
3. 在 `UPSTREAM.md` 增加说明卡，并补一个在没有该改动时会失败的测试。

第 3 条不做完，改动不算完成。不要重写渲染策略。

## 测试

这个包用 `node --test`：`pnpm --filter @moonshot-ai/pi-tui test`。仓库根的 vitest 不会跑这些测试。
