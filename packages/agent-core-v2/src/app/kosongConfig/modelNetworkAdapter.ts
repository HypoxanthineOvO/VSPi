import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { OAUTH_NETWORK_SECTION, PROXY_SECTION, type OAuthNetworkConfig, type ProxyConfig } from '#/app/auth/configSection';
import { accountProxyForUrl, accountProxyPreference, usesAccountProxy } from '#/app/auth/proxy';
import { IModelRequestNetwork } from '#/kosong/model/modelNetwork';

export class ModelNetworkAdapter implements IModelRequestNetwork {
  declare readonly _serviceBrand: undefined;
  constructor(@IConfigService private readonly config: IConfigService) {}

  proxyForUrl(url: string | undefined, providerType?: string, fallback?: string): string | undefined {
    const preference = accountProxyPreference(this.config.get<ProxyConfig>(PROXY_SECTION), this.config.get<OAuthNetworkConfig>(OAUTH_NETWORK_SECTION));
    if (preference === undefined) return fallback;
    if (url === undefined && usesAccountProxy(providerType ?? '')) return preference === '' ? undefined : preference;
    return accountProxyForUrl(url, preference);
  }
}

registerScopedService(LifecycleScope.App, IModelRequestNetwork, ModelNetworkAdapter, ScopeActivation.OnScopeCreated, 'kosongConfig');
