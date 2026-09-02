export const PROVIDER_PRIORITY: readonly string[] = [
  'vsplab',
  'deepseek',
  'xiaomi',
  'kimi-coding',
  'moonshotai-cn',
  'moonshotai',
  'moonshot',
  'zai',
  'zai-coding-cn',
  'zhipu',
  'minimax',
  'minimax-cn',
  'openai',
  'anthropic',
];

export function providerPriorityIndex(id: string): number {
  const index = PROVIDER_PRIORITY.indexOf(id);
  return index === -1 ? PROVIDER_PRIORITY.length : index;
}

export const BRAND_PRIORITY: readonly string[] = [
  'VSPLab',
  'DeepSeek',
  'Xiaomi',
  'Kimi Coding',
  'Moonshot AI',
  'Moonshot',
  'Zai',
  'Zhipu AI',
  'MiniMax',
  'OpenAI',
  'Anthropic',
];
