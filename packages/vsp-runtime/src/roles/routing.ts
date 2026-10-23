import type { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import { resolveSubagentModelPool } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';
import type { SubagentBindingResolution } from '@moonshot-ai/agent-core-v2/session/subagent/subagentService';
import type { RoleName, RoleRouting } from './config.js';

export async function resolveRoleModel(config: IConfigService, catalog: IModelCatalog, role: string, requested?: string): Promise<string | SubagentBindingResolution | undefined> {
  const routing = config.get<RoleRouting>('roleRouting');
  const preferred = requested ?? routing[role as RoleName]?.default;
  if (preferred === undefined || preferred === 'primary') return undefined;
  const pool = resolveSubagentModelPool(config);
  if (pool === undefined || !Object.hasOwn(pool.models, preferred)) {
    if (requested !== undefined) return undefined;
    throw new Error(`role_routing.${role}.default "${preferred}" is not in secondary_model.models`);
  }
  const fallback = routing.fallback?.[preferred];
  if (fallback === undefined) return preferred;
  const models = await catalog.listModels();
  const providers = await catalog.listProviders();
  const unavailable = (alias: string): string | undefined => {
    const model = models.find(item => item.model === alias);
    if (model === undefined) return '模型未配置';
    const provider = providers.find(item => item.id === model.provider);
    if (provider?.status !== 'connected') return '没有可用凭据';
    const health = model.health;
    if (health !== undefined && health.expiresAt > Date.now() && health.lastFailure !== undefined && health.lastFailure.at > (health.lastSuccess ?? 0)) return `近期请求失败 (${health.lastFailure.category})`;
    return undefined;
  };
  const reason = unavailable(preferred);
  if (reason === undefined) return preferred;
  for (const candidate of fallback) {
    if (!Object.hasOwn(pool.models, candidate) || unavailable(candidate) !== undefined) continue;
    return { model: candidate, notice: `${preferred} 不可用（${reason}），已用 ${candidate}` };
  }
  throw new Error(`${preferred} 不可用（${reason}），配置的池内备用模型全部不可用；未派发任务。`);
}
