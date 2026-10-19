# Devin 登录与模型

## 现在

Devin 作为订阅账号接入 VSPi，不提供 API Key 登录入口。

- 在 Provider 管理里选择 Devin 的订阅登录后，VSPi 启动本机回调地址并给出 Devin 授权链接；在浏览器完成授权即可。通过 SSH 或远端运行时使用时，可以把回调 URL 或授权码粘贴回来。
- 登录成功后，凭据写入 VSPi 配置，来源记为浏览器登录。
- 也可以直接复用本机 `~/.local/share/devin/credentials.toml` 里的 Devin CLI 凭据，来源记为本机 CLI。凭据只在本机读取，不复制到其他机器。
- Devin 凭据不支持刷新。凭据缺失或过期时，界面提示重新登录，不会静默换用其他 Provider。
- 模型目录从 Devin 服务读取，并归一成模型组。目录读取失败时，保留 SWE-1.6 和 SWE-1.6 Fast 两个默认模型。
- 模型组保留工具调用、思考档位和图像输入能力。Devin 返回的思考与上下文变体会归并到同一个模型组，不重复占一行。
- Devin 的官方域名在需要代理时按官方 Provider 处理。

## 规则

- 只支持订阅登录，不把 Devin 当成 OpenAI 兼容的 API Key Provider。
- 登录状态以 VSPi 保存的凭据为准；复用本机 CLI 凭据时，删除 VSPi 凭据不能删除或修改外部 CLI 的文件。
- 目录返回的模型只是候选，最终能否使用仍由模型请求结果和健康记录决定。

## 不能坏

- 凭据过期必须明确报登录失败，不能回退到其他 Provider 或匿名请求。
- 远端登录必须保留手动粘贴回调的路径，SSH 场景不能只依赖浏览器回调。
- 读取本机凭据失败不能导致整个 Provider 列表加载失败。

## 牵连

- 模型选择：Devin 模型与其他来源一起按公司归并，来源健康参与默认来源排序。
- Provider 管理：Devin 出现在登录 Provider 列表，支持复用本机凭据和移除 VSPi 凭据。
- 代理配置：Devin 官方域名属于需要代理的官方地址。

## 代码

- `packages/agent-core-v2/src/app/auth/devinCredential.ts`：`devinAuthPath`、`devinCredential`、`readDevinCredential`、`devinAuthorization`、`devinCallback`、`exchangeDevinCode`、`browserLogin`、`devinOAuth`
- `packages/agent-core-v2/src/app/auth/piOAuthAdapter.ts`：`PiOAuthAdapter.startLogin`、`logout`
- `packages/agent-core-v2/src/app/auth/localCredentials.ts`：`LocalCredentialRegistry.detect`、`LocalCredentialRegistry.resolve`
- `packages/agent-core-v2/src/app/auth/authService.ts`：`OAuthService.startLogin`、`logout`、`listLocalCredentials`、`useLocalCredential`、`resolveRequestAuth`
- `packages/agent-core-v2/src/llm-adapter/provider/provider-definition.ts`：`providerDefinitions`
- `packages/agent-core-v2/src/llm-adapter/provider/devin/catalog.ts`：`normalizeDevinModels`、`fetchDevinModels`
- `packages/agent-core-v2/src/llm-adapter/provider/devin/chatProvider.ts`：`DevinChatProvider`、`buildDevinRequest`
- `packages/agent-core-v2/src/llm-adapter/provider/pi/requester.ts`
- `packages/agent-core-v2/src/app/auth/proxy.ts`：`usesAccountProxy`、`accountProxyForUrl`

## 测试

- `pnpm --filter @moonshot-ai/agent-core-v2 test test/llm-adapter/provider/devin.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 test test/app/auth/auth.test.ts`
- `pnpm --filter vspi test test/auth-setup.test.ts`

## 未定

- 同一台机器上多个 Devin 账号的切换方式。
- 目录里新增模型组时，是否需要人工确认后再进入常用列表。
