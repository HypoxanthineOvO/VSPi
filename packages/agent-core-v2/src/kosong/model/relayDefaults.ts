import type { ProviderConfig } from '#/kosong/provider/provider';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ModelRecord } from './model';

export function isRelayModel(model: ModelRecord, provider?: ProviderConfig): boolean {
  return (model.providerId ?? model.provider) === 'vsplab' || provider?.type === 'vsplab' || provider?.source?.['kind'] === 'vsp-models';
}

export function defaultRelayProtocol(name: string): Protocol | undefined {
  const id = name.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:gpt-|o\d(?:-|$))/.test(id)) return 'openai_responses';
  if (id.startsWith('claude-')) return 'anthropic';
  if (/^(?:kimi-|k[23](?:-|$)|glm-|deepseek-)/.test(id)) return 'openai';
  return undefined;
}
