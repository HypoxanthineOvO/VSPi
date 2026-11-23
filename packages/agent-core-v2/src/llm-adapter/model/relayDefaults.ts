import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import type { ModelRecord } from './model';

export function isRelayModel(model: ModelRecord, provider?: ProviderConfig): boolean {
  return (model.providerId ?? model.provider) === 'vsplab' || provider?.type === 'vsplab' || provider?.source?.['kind'] === 'vsp-models';
}

export function defaultRelayProtocol(name: string): Protocol | undefined {
  const id = name.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:gpt-|o\d(?:-|$)|codex-|grok-)/u.test(id)) return 'openai_responses';
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-')) return 'google-genai';
  if (/^(?:kimi-|k[23](?:[.-]|$)|glm-|deepseek-|mimo-|minimax-|qwen|doubao-|swe-|hy4)/u.test(id)) return 'openai';
  return undefined;
}
