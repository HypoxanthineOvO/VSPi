# Provider 管理

## 现在

`vspi config` 和会话里的 `/providers` 都打开「来源」标签。没有配置过来源时，直接运行 `vspi` 也会打开此页。按 `1` / `2` 切换来源和额度；`/quota`（或 `/balance`）直接打开「额度」标签。

- 来源按「已启用」「已停用」「可添加」分组。已启用的来源在行尾显示剩余比例和倒计时、余额，或额度查询失败提示。详情显示认证方式、Endpoint、协议、最近的连接检查、当前额度和模型。少于 96 列时，按 `Enter` 在单栏查看详情。
- `Space` 启停来源，停用后从 `/model` 隐藏，凭据和模型配置保留。`L` 登录、`E` 编辑、`D` 移除凭据，`/` 搜索；`T` 进行最长 8 秒的连通测试，展示检查结果和耗时，不发起模型生成。
- `F` 刷新模型列表，保留已有覆写。仅通过 `api_key_env` 提供 API Key 的自定义中转站暂不支持在面板内刷新，可按 `E` 手动填写模型 ID。按 `Tab` 聚焦模型区，选择模型后按 `Enter` 修改该模型的协议或上下文窗口。
- 检测到本机 CLI 凭据时，按 `R` 并确认后复用，包括 OMP、Devin、Codex、Kimi 和 GitHub Copilot 的可用凭据；VSPi 写入 `local-cli` 引用。
- 本机凭据先验证再替换；失败保留原凭据，确认前取消不生效。
- 移除操作只删除 VSPi 保存的凭据，不改外部 CLI 的凭据文件。
- 可添加自定义中转站：填写名称、Endpoint、协议和 API Key，协议支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI。
- 保存自定义中转站时先读取模型列表；读取失败或超时，允许手动填写模型 ID。模型写成 `Provider/模型` 别名，并写入模型配置；没有默认模型时，用第一个模型设为默认。
- Provider ID 由名称和 Endpoint 生成稳定值；同名中转站已存在时要求编辑原项，不重复创建。
- 更改 Endpoint 或协议需要重新提供 API Key；账号凭据不能发送到自定义 Endpoint。
- 保存前重新读取配置，如果测试期间配置被其他人改动，就拒绝覆盖并要求重试。
- 额度页按订阅窗口、CPA 逐账号额度、账户余额分组。窗口用 10 格进度条表示剩余比例，`5h` / `7d` 只显示 `2h14m`、`9m`、`<1m` 或「即将刷新」这样的相对时间。少于 88 列时，每个账号用两行显示。
- 两个标签共享额度结果。额度页按 `r` 刷新；临时查询失败可显示最近一次成功值并标注 `(旧)`。鉴权失败时提示重新登录或检查密钥，不显示旧余额。两页都可以按 `C` 设置查询模式、管理地址和密钥、计费倍率；密钥输入不回显。

## 规则

- `vspi config`、`/providers` 和 `/quota` 共用 `ProviderManagerController`；额度由 daemon 查询并缓存 5 分钟，手动刷新间隔至少 10 秒。
- 提交保存时，Provider、模型和默认模型三个配置段一起替换；不能只写其中一段。
- 自定义中转站只接受 HTTP(S) 地址，地址不能包含账号或密码。
- 删除 VSPi 凭据不会动 Provider 的其他配置和模型条目。

## 不能坏

- 不能把订阅账号凭据发送到用户自定义的 Endpoint。
- 保存失败或冲突时不能覆盖别人的修改，也不能留下半套模型配置。
- 读取本机凭据失败不能阻止列表加载，也不能让整个 `vspi config` 无法启动。
- 删除操作不能删除外部 CLI 的凭据。

## 牵连

- 模型选择：Provider 和模型条目变化会影响可选来源、默认来源和健康记录。
- Devin 登录与模型：Devin 的登录、复用本机凭据和移除走同一套管理界面。
- 代理配置：官方 Provider 或指向官方海外地址的 Provider 需要确认代理；兼容协议的自建中转站不自动要求共享代理。
- `config.toml`：Provider、models 和 defaultModel 是用户配置的一部分，远程目录不能覆盖用户字段。

## 代码

- `apps/vspi/src/v1/ui/provider-manager.ts`：`ProviderManagerController`、`ProviderManagerController.handleInput`、`renderProviderManager`
- `apps/vspi/src/v1/ui/quota-view.ts`：`renderQuotaView`、`formatQuotaCountdown`、`summarizeQuota`
- `apps/vspi/src/v1/providers/provider-management.ts`：`loadProviderOptions`、`saveProviderGateway`、`checkProvider`
- `apps/vspi/src/v1/providers/custom-provider.ts`：`customProviderId`、`fetchProviderModels`、`modelsFromManualInput`、`discoverProviderModels`
- `apps/vspi/src/v1/providers/provider-login.ts`：`loginProvider`
- `apps/vspi/src/v1/providers/oauth-login.ts`：`loginWithOAuth`
- `apps/vspi/src/v1/providers/proxy-setup.ts`：`configuredProxy`、`ensureProviderProxy`、`configureProxy`
- `apps/vspi/src/v1/providers/order.ts`：`PROVIDER_PRIORITY`、`providerPriorityIndex`
- `apps/vspi/src/v1/run.ts`：`runVspiTui`
- `apps/vspi/src/v1/app/vspi-app.ts`：`openProviderPanel`、`performProviderAction`
- `apps/vspi/src/v1/ui/panels.ts`：`openProviderManager`、`loadProviderQuota`
- `apps/vspi/src/v1/backend/klient-backend.ts`：`getProviderQuota`、`refreshProviderQuota`
- `apps/vspi/src/v1/domain/commands.ts`：`resolveCommand`
- `apps/vspi/src/v1/app/auth-setup.ts`：`runAuthSetup`、`AuthSetupApp.load`、`AuthSetupApp.perform`、`configureDefaultModel`
- `packages/agent-core-v2/src/app/auth/localCredentials.ts`：`LocalCredentialRegistry.detect`、`LocalCredentialRegistry.resolve`
- `packages/agent-core-v2/src/app/auth/authService.ts`：`listLocalCredentials`、`useLocalCredential`、`logout`
- `packages/agent-core-v2/src/app/auth/proxy.ts`：`usesAccountProxy`、`accountProxyPreference`、`accountProxyForUrl`

## 测试

- `pnpm --filter vspi test test/auth-setup.test.ts`
- `pnpm --filter vspi test test/settings-security.test.ts`
- `pnpm --filter vspi test test/tui-render.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 test test/app/auth/auth.test.ts`
