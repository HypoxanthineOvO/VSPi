# Provider 管理

## 现在

`vspi config` 和会话里的 `/providers` 使用同一套 Provider 管理界面。

- 列表分“已连接”和“可添加”，显示 Provider、状态和模型数量；详情显示认证方式、账号、凭据到期、Endpoint、协议、上次检查、默认模型和模型列表。
- 支持的状态来自 Provider 配置、内置 Provider 和登录 Provider。没有配置的 Provider 放在“可添加”。
- 检测到本机 CLI 凭据时，列表顶部提示可一键复用；Devin、Codex、Kimi、GitHub Copilot 等检测到的来源显示为“复用本机 … 凭据”。复用后 VSPi 配置记录 `local-cli` 来源。
- 一 Provider 一行；`L/T/E/D` 分别登录、检查配置、编辑、移除，`/` 搜索，`Tab` 聚焦模型，`Enter` 查看详情，检测到本机凭据时按 `R` 复用。
- 本机凭据先验证再替换；失败保留原凭据，确认前取消不生效。
- 移除操作只删除 VSPi 保存的凭据，不改外部 CLI 的凭据文件。
- 可添加自定义中转站：填写名称、Endpoint、协议和 API Key，协议支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI。
- 保存自定义中转站时先读取模型列表；读取失败或超时，允许手动填写模型 ID。模型写成 `Provider/模型` 别名，并写入模型配置；没有默认模型时，用第一个模型设为默认。
- Provider ID 由名称和 Endpoint 生成稳定值；同名中转站已存在时要求编辑原项，不重复创建。
- 更改 Endpoint 或协议需要重新提供 API Key；账号凭据不能发送到自定义 Endpoint。
- 保存前重新读取配置，如果测试期间配置被其他人改动，就拒绝覆盖并要求重试。
- “测试”是离线配置检查：确认凭据和模型配置完整，并明确提示当前 Core 不提供无计费网络探测。

## 规则

- `vspi config` 和 `/providers` 共用 `ProviderManagerController`，字段、快捷键和状态一致。
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

- `apps/vspi/src/v1/ui/provider-manager.ts`：`ProviderManagerController`、`ProviderManagerController.handleInput`、`renderProviderManager`、`ProviderGatewayForm`
- `apps/vspi/src/v1/providers/provider-management.ts`：`loadProviderOptions`、`saveProviderGateway`、`checkProvider`
- `apps/vspi/src/v1/providers/custom-provider.ts`：`customProviderId`、`fetchProviderModels`、`modelsFromManualInput`、`discoverProviderModels`
- `apps/vspi/src/v1/providers/provider-login.ts`：`loginProvider`
- `apps/vspi/src/v1/providers/oauth-login.ts`：`loginWithOAuth`
- `apps/vspi/src/v1/providers/proxy-setup.ts`：`configuredProxy`、`ensureProviderProxy`、`configureProxy`
- `apps/vspi/src/v1/providers/order.ts`：`PROVIDER_PRIORITY`、`providerPriorityIndex`
- `apps/vspi/src/v1/app/auth-setup.ts`：`runAuthSetup`、`AuthSetupApp.load`、`AuthSetupApp.perform`、`configureDefaultModel`
- `packages/agent-core-v2/src/app/auth/localCredentials.ts`：`LocalCredentialRegistry.detect`、`LocalCredentialRegistry.resolve`
- `packages/agent-core-v2/src/app/auth/authService.ts`：`listLocalCredentials`、`useLocalCredential`、`logout`
- `packages/agent-core-v2/src/app/auth/proxy.ts`：`usesAccountProxy`、`accountProxyPreference`、`accountProxyForUrl`

## 测试

- `pnpm --filter vspi test test/auth-setup.test.ts`
- `pnpm --filter vspi test test/settings-security.test.ts`
- `pnpm --filter vspi test test/tui-render.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 test test/app/auth/auth.test.ts`

## 未定

- “测试”是否要增加显式的真实请求探测，并允许用户承担相应费用。
- 自定义中转站模型列表的缓存时长和手动刷新入口。
