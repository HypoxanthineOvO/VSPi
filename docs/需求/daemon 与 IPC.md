# daemon 与 IPC

## 现在

- `vspi` 启动时先检查本机 daemon。没有运行就拉起 daemon，再通过本机 IPC 连接；连接携带运行时身份，包括产品、版本、平台和构建标识。
- daemon 承载会话、模型配置、后台任务和事件流；终端前端退出后它继续运行。`vspi continue` / `vspi resume` 重新接入已有会话。
- `vspi daemon stop` 停止 daemon；有运行中的任务时默认不强制停止。`vspi daemon desktop` 供 VSPi Desktop 发现本机或 SSH 远端运行时。
- 客户端和 daemon 的版本或 Node 版本不兼容时，拒绝连接并给出明确原因，不静默接入。
- daemon 有自己的 home 和运行时身份文件；嵌套 `vspi` 调用使用 daemon 自己的可执行文件和默认 home。
- `vspi web` 复用同一个运行时，输出本机地址和工作区，不另起一套服务。
- 本机传输使用 unix socket 上的 NDJSON；Klient 的 memory 传输用于进程内测试，两者返回相同的契约数据。
- VSPi Desktop 通过 SSH 和运行时 token 连接远端 daemon；渲染进程不接触凭据。

## 规则

- daemon 与客户端必须显式校验构建和最低 Node 版本。不同构建不能互相连接。
- 停止 daemon 前先确认空闲；需要强制停止时必须由用户显式触发。
- 运行时身份文件只由 daemon 自己写入和删除，客户端只读取和校验。
- 一个 home 只运行一个 daemon。发现已有实例时复用它，不另起第二个。
- 客户端不直接读写 daemon 的会话文件，只通过 Klient 接口操作。

## 不能坏

- 不能静默接入不兼容的 daemon，也不能在版本不符时继续发请求。
- 不能用 PATH 上碰到的其他 `vspi` 启动嵌套实例。
- daemon 停止或崩溃时，客户端要明确报错，不能假装会话仍在运行。
- 连接重建后不能重复应用已经确认过的状态。

## 牵连

- 会话与对话：所有会话操作和事件都经过 daemon。
- Provider 管理：配置写入通过 daemon 的配置服务完成。
- 发布：运行时构建标识、包内入口和最低 Node 版本必须与发行包一致。
- VSPi Desktop：依赖 daemon 发现接口和运行时身份。

## 代码

- `apps/vspi/src/main.ts`：`main`、`daemonCommand`、`serveDaemon`、`ensureConnection`、`expectedRuntimeIdentity`
- `apps/vspi/src/runtime-identity.ts`：`MINIMUM_NODE_VERSION`、`assertSupportedNodeVersion`、`createExpectedRuntimeIdentity`、`readRuntimeIdentity`、`assertCompatibleConnection`
- `apps/vspi/src/daemon-environment.ts`：`prepareDaemonEnvironment`、`daemonEnvironment`、`parseDaemonHomeDir`
- `apps/vspi/src/runtime-build.ts`：`runtimeBuildId`、`stageRuntimeBuild`
- `apps/vspi/src/runtime-workers.ts`：`resolvePackagedRuntimeAssets`、`configurePackagedRuntimeWorkers`
- `apps/vspi/src/desktop-discovery.ts`：`runDesktopDiscovery`
- `packages/vsp-runtime/src/client.ts`：`ensureRuntime`、`connectRuntime`、`reconnectRuntime`、`stopRuntime`、`recoverRuntime`、`inspectRuntimeActivity`
- `packages/vsp-runtime/src/daemon.ts`：`startRuntimeDaemon`
- `packages/vsp-runtime/src/identity.ts`：`getRuntimeId`
- `packages/vsp-runtime/src/paths.ts`：`resolveVspHome`、`resolveRuntimePaths`
- `packages/klient/src/transports/ipc/index.ts`
- `packages/klient/src/transports/memory/index.ts`
- `apps/vspi/test/runtime-recovery.test.ts`：`fixture`

## 测试

- `pnpm --filter vspi test test/runtime-identity.test.ts`
- `pnpm --filter vspi test test/runtime-recovery.test.ts`：真实运行时多客户端恢复回归；夹具退出后删除临时目录，对并发缓存落盘导致的目录非空最多重试 5 次，行为断言不变。
- `pnpm --filter vspi test test/daemon-environment.test.ts`
- `pnpm --filter vspi test test/desktop-discovery.test.ts`
- `pnpm --filter @vsp/vsp-runtime test test/runtime.test.ts`

## 未定

- 远端 daemon 重连时的退避上限和提示频率。
- Desktop 之外的客户端是否也需要运行时发现接口。
