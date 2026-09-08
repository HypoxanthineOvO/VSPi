import { z } from 'zod';
import { findPiModel, piThinking } from '#/kosong/provider/pi/catalog';
import type { ModelRecord } from '#/kosong/model/model';
import type { ProviderConfig } from '#/kosong/provider/provider';

const costRate = z.number().finite().nonnegative();
const costSchema = z.object({
  input: costRate.optional(), output: costRate.optional(),
  cacheRead: costRate.optional(), cacheWrite: costRate.optional(),
  tiers: z.array(z.object({
    input: costRate, output: costRate,
    tier: z.object({ type: z.literal('context'), size: z.number().int().positive() }),
  }).passthrough()).optional(),
}).passthrough();
const entrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  input: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
  effortLevels: z.array(z.string().min(1)).min(1).optional(),
  defaultEffort: z.string().trim().min(1).optional(),
  thinkingLevelMap: z.record(z.string(), z.union([z.string().min(1), z.null()])).optional(),
  cost: costSchema.optional(),
  curated: z.boolean().optional(), hidden: z.boolean().optional(),
  releasedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).passthrough();
export const relayCatalogSchema = z.object({ version: z.literal(1).optional(), models: z.array(entrySchema).max(10000), pricingBasis: z.object({ purpose: z.string() }).passthrough().optional() });

export function isRelayCatalogProvider(id: string, provider: ProviderConfig): boolean {
  if (provider.modelSource === 'static' || provider.source?.['enabled'] === false) return false;
  return provider.source?.['kind'] === 'vsp-models' || (!provider.source && (id === 'vsplab' || provider.type === 'vsplab'));
}

export function relayCatalogUrl(provider: ProviderConfig): string {
  const explicit = provider.source?.['url'];
  const url = new URL(typeof explicit === 'string' ? explicit : '/vsp/models', provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid relay catalog URL');
  return url.toString();
}

export function mergeRelayCatalog(
  records: Readonly<Record<string, ModelRecord>>,
  providerId: string,
  provider: ProviderConfig,
  payload: unknown,
): Record<string, ModelRecord> {
  const { models, pricingBasis } = relayCatalogSchema.parse(payload);
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('Duplicate relay model id');
  const result = { ...records };
  for (const remote of models) {
    const aliases = Object.entries(records).filter(([, record]) => (record.providerId ?? record.provider) === providerId && (record.name ?? record.model) === remote.id).map(([alias]) => alias);
    if (!aliases.length && remote.hidden) continue;
    if (!aliases.length) aliases.push(`${providerId}/${remote.id}`);
    const native = findPiModel(provider.type, remote.id);
    const nativeThinking = native ? piThinking(native) : undefined;
    for (const alias of aliases) {
      const old = records[alias];
      const record: ModelRecord = { ...old, provider: providerId, model: remote.id };
      if (remote.name !== undefined) record.displayName = remote.name;
      if (remote.contextWindow !== undefined) record.maxContextSize = remote.contextWindow;
      else if (!record.maxContextSize) record.maxContextSize = native?.contextWindow ?? 131072;
      if (remote.maxTokens !== undefined) record.maxOutputSize = remote.maxTokens;
      if (remote.curated !== undefined || remote.hidden) record.curated = remote.hidden ? false : remote.curated;
      if (remote.releasedAt !== undefined) {
        if (!Number.isFinite(Date.parse(remote.releasedAt)) || new Date(remote.releasedAt).toISOString().slice(0, 10) !== remote.releasedAt) throw new Error('Invalid model release date');
        record.releasedAt = remote.releasedAt;
      }
      const capabilities = new Set(old?.capabilities ?? (native ? [ 'tool_use', ...native.input.includes('image') ? ['image_in'] : [] ] : []));
      if (remote.input !== undefined) {
        for (const [input, capability] of [['image', 'image_in'], ['video', 'video_in'], ['audio', 'audio_in']] as const) {
          if (remote.input.includes(input)) capabilities.add(capability); else capabilities.delete(capability);
        }
      }
      if (remote.input !== undefined) record.capabilities = [...capabilities];
      const thinking = { ...nativeThinking, ...old?.thinking };
      if (remote.reasoning === false) record.thinking = { availability: 'none', canDisable: false, controls: [] };
      else if (remote.effortLevels !== undefined) {
        const enabled = remote.effortLevels.filter((level) => level !== 'off' && remote.thinkingLevelMap?.[level] !== null);
        const canDisable = remote.effortLevels.includes('off') && remote.thinkingLevelMap?.['off'] !== null;
        const declaredDefault = remote.defaultEffort ?? thinking.defaultEffort;
        const defaultEffort = enabled.includes(declaredDefault ?? '') ? declaredDefault : enabled.includes('medium') ? 'medium' : enabled[0];
        record.thinking = {
          ...thinking,
          availability: enabled.length ? canDisable ? 'dynamic' : 'always' : 'none',
          canDisable,
          controls: enabled.length ? canDisable ? ['toggle', 'effort'] : ['effort'] : [],
          efforts: enabled,
          defaultEffort,
        };
        record.supportEfforts = enabled.length > 0 ? [...enabled] : undefined;
        record.defaultEffort = defaultEffort;
      } else if (remote.reasoning === true) record.thinking = { ...thinking, availability: thinking.availability === 'always' ? 'always' : 'dynamic' };
      if (remote.thinkingLevelMap !== undefined) record.effortMapping = { ...old?.effortMapping, ...remote.thinkingLevelMap };
      if (remote.cost !== undefined) {
        record.pricingSource = pricingBasis?.purpose === 'official-equivalent-usage' ? 'official' : 'provider';
        const base = old?.pricing ?? (native ? { inputUsdPerMillion: native.cost.input, outputUsdPerMillion: native.cost.output, cacheReadUsdPerMillion: native.cost.cacheRead, cacheWriteUsdPerMillion: native.cost.cacheWrite } : undefined);
        const input = remote.cost.input ?? base?.inputUsdPerMillion;
        const output = remote.cost.output ?? base?.outputUsdPerMillion;
        if (input !== undefined && output !== undefined) record.pricing = {
          ...base, inputUsdPerMillion: input, outputUsdPerMillion: output,
          cacheReadUsdPerMillion: remote.cost.cacheRead ?? base?.cacheReadUsdPerMillion,
          cacheWriteUsdPerMillion: remote.cost.cacheWrite ?? base?.cacheWriteUsdPerMillion,
          contextTiers: remote.cost.tiers?.map((tier) => ({ contextTokensAbove: tier.tier.size, inputUsdPerMillion: tier.input, outputUsdPerMillion: tier.output })) ?? base?.contextTiers,
        };
      }
      result[alias] = record;
    }
  }
  return result;
}

export async function fetchRelayCatalog(provider: ProviderConfig): Promise<unknown> {
  const response = await fetch(relayCatalogUrl(provider), { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw new Error(`Relay catalog HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty relay catalog response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 4 * 1024 * 1024) throw new Error('Relay catalog exceeds 4 MiB');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}
