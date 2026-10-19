# klient：给改这个包的 Agent 看

## 分层

- **Facade**（`src/core/facade/`、`src/core/klient.ts`）是唯一公开 API：`global.*`、`session(id).*`、`session(id).agent(id).*` 以及 `events.*`。不能暴露引擎 Service token，不能用 `onDid*` / `onWill*` 命名，也不能留回原始 service 的逃生口（不要重新引入 `core()` / `service()` / `makeProxy`）。
- **Contract**（`src/contract/`）是每个 wire 方法的 zod 输入输出 schema 和事件 schema。schema 手工镜像 `agent-core-v2` 类型，由 `test/contract-parity.ts` 的编译期断言固定；引擎类型变化时先在这里让 tsc 失败。`src/contract/helpers.ts` 的 `maybe()` / `noResult()` 表达 HTTP wire 的 `null` 与 `undefined` 语义，所有 `X | undefined` 和 `void` 结果都要用。
- **Transports**（`src/transports/{ipc,memory}`）只实现 `KlientChannel` SPI（`src/core/channel.ts`）。ipc 把 dispatcher 流量编码成 unix socket 上的 NDJSON；memory 和它共用进程内 dispatcher，并对每个值做 JSON 往返，保证两种传输返回一致的数据。

Facade 只覆盖两种传输行为一致的服务；进程内 dispatcher 也按服务端的 scope 规则解析，包括 `ensureMainAgent`。`onWill` / hook 拦截不暴露到 wire，因为引擎 hook 是进程内的 `OrderedHookSlot`。终端界面是 v1-only，放在旧版测试套件。文件上传已经在 facade 上（`global.files`），字节以 base64 过 wire，dispatcher 双向适配 `IFileService` 流。

## 测试

- 一套共享 conformance（`test/helpers/conformance.ts`）对每种传输原样运行，每种传输一个测试文件。新增全局 facade 覆盖加在这里，不要给每种传输各写一份。
- `test/e2e/legacy/` 和 `test/e2e/harness/` 是 live `/api/v1` 套件，只有 `KIMI_SERVER_URL` 指向运行中的服务时才跑，必须保持原样。v1 没有内存等价物，不要把它们改成进程内传输。
- 已退役的 `scenarios/` 脚本已经改成套件：图片上传和终端这两类 v1-only 场景在 `test/e2e/legacy/`。
- e2e 的可观测性保留在每个用例内，通过 `test/e2e/legacy/log.ts` 输出请求、信封、WS 握手、终端帧和错误信封，不用临时 `console.log`。通过的 Vitest 用例也要能看到日志，统一写 stdout。改 e2e 用例时同步更新可观测性，不要为了打印已有数据另加场景。

## 命令

- `pnpm --filter @moonshot-ai/klient test`：全部 Vitest；没有环境变量的 live 用例自动跳过。
- `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/klient test`：带上 live legacy 用例。
- `pnpm --filter @moonshot-ai/klient docker:e2e`：docker e2e，运行器名称和命名空间从当前工作区推导，避免跨工作区冲突。
- `pnpm --filter @moonshot-ai/klient typecheck`。
- `pnpm smoke`：memory 传输的进程内冒烟，见 `examples/smoke.ts`。
- `pnpm --filter @moonshot-ai/klient smoke:boundary`：ModelRequester 边界探针，用真实 `~/.kimi-code/config.toml` 里的模型，再用本地桩驱动确定性失败，区分 ChatProvider 包装的错误和 requester 自己处理的错误。
- `pnpm --filter @moonshot-ai/klient smoke:select-tools`：kimi 类型 Provider 的渐进式工具披露探针，先桩验证 kimi-only 的 wire 编码，再对真实模型跑两步 select → use。
