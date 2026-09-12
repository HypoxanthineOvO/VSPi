export const EFFORT_PROFILE_REVISION = 2;

export interface ModelEffortProfile {
  readonly ids: readonly string[];
  readonly providers: readonly string[];
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  readonly canDisable: boolean;
  readonly mode: 'effort' | 'toggle';
  readonly source: string;
  readonly defaultSource?: 'product';
  readonly provisional?: boolean;
}

const five = ['low', 'medium', 'high', 'xhigh', 'max'];
const three = ['low', 'high', 'max'];

export const MODEL_EFFORT_PROFILES: readonly ModelEffortProfile[] = [
  { ids: ['gpt-6-astra', 'gpt-6'], providers: ['openai', 'openai_responses', 'openai-codex'], efforts: five, defaultEffort: 'medium', defaultSource: 'product', canDisable: false, mode: 'effort', source: 'https://developers.openai.com/api/docs/models/gpt-6-astra' },
  { ids: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6'], providers: ['openai', 'openai_responses', 'openai-codex'], efforts: five, defaultEffort: 'medium', canDisable: true, mode: 'effort', source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol' },
  { ids: ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5'], providers: ['anthropic'], efforts: five, defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://platform.claude.com/docs/en/build-with-claude/effort' },
  { ids: ['kimi-k3', 'kimi-k3-256k', 'k3-256k'], providers: ['kimi', 'moonshotai', 'moonshotai-cn', 'kimi-coding'], efforts: three, defaultEffort: 'max', canDisable: false, mode: 'effort', source: 'https://github.com/MoonshotAI/Kimi-K3/blob/main/README.md' },
  { ids: ['glm-5.3', 'glm-5.3-flash'], providers: ['zai', 'zhipu', 'zai-coding', 'zai-coding-cn'], efforts: three, defaultEffort: 'max', canDisable: false, mode: 'effort', source: 'https://docs.z.ai/guides/capabilities/thinking' },
  { ids: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'], providers: ['deepseek'], efforts: three, defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://api-docs.deepseek.com/guides/thinking_mode/' },
  { ids: ['deepseek-v4.1-flash'], providers: ['deepseek'], efforts: three, defaultEffort: 'high', canDisable: true, mode: 'effort', provisional: true, source: 'https://api-docs.deepseek.com/guides/thinking_mode/' },
  { ids: ['qwen3.8-max', 'qwen3.8-flash'], providers: ['alibaba', 'alibaba-cn', 'dashscope'], efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh', canDisable: true, mode: 'effort', source: 'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions' },
  { ids: ['gemini-3.8-flash'], providers: ['google', 'google-genai', 'google-vertex'], efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', canDisable: false, mode: 'effort', source: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking' },
  { ids: ['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools'], providers: ['google', 'google-genai', 'google-vertex'], efforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking' },
  { ids: ['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.5-pro-ultraspeed'], providers: ['xiaomi', 'mimo'], efforts: [], defaultEffort: 'on', canDisable: true, mode: 'toggle', source: 'https://mimo.mi.com/docs/en-US/api/chat/responses' },
  { ids: ['minimax-m3'], providers: ['minimax', 'minimax-cn'], efforts: [], defaultEffort: 'on', canDisable: true, mode: 'toggle', source: 'https://platform.minimax.io/docs/api-reference/text-openai-api' },
  { ids: ['hy4-preview'], providers: ['tencent', 'hunyuan'], efforts: ['high'], defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://cloud.tencent.com/document/product/1823/131208' },
];

export function modelEffortProfile(name: string): ModelEffortProfile | undefined {
  const id = name.split('/').at(-1)?.toLowerCase() ?? '';
  return MODEL_EFFORT_PROFILES.find((profile) => profile.ids.includes(id));
}
