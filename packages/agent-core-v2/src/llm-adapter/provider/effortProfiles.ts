import { normalizeIdentity } from '#/llm-adapter/model/canonical';

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
  { ids: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6'], providers: ['openai', 'openai_responses', 'openai-codex'], efforts: five, defaultEffort: 'medium', defaultSource: 'product', canDisable: false, mode: 'effort', source: 'https://developers.openai.com/api/docs/models/gpt-6.2-sol' },
  { ids: ['gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna'], providers: ['openai', 'openai_responses', 'openai-codex'], efforts: five, defaultEffort: 'medium', canDisable: true, mode: 'effort', source: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra' },
  { ids: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6'], providers: ['openai', 'openai_responses', 'openai-codex'], efforts: five, defaultEffort: 'medium', canDisable: true, mode: 'effort', source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol' },
  { ids: ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], providers: ['anthropic'], efforts: five, defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://platform.claude.com/docs/en/build-with-claude/effort' },
  { ids: ['claude-haiku-5-5'], providers: ['anthropic'], efforts: five, defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://platform.claude.com/docs/en/build-with-claude/effort' },
  { ids: ['kimi-k3', 'kimi-k3-256k', 'k3', 'k3-256k'], providers: ['kimi', 'moonshotai', 'moonshotai-cn', 'kimi-coding'], efforts: three, defaultEffort: 'max', canDisable: false, mode: 'effort', source: 'https://github.com/MoonshotAI/Kimi-K3/blob/main/README.md' },
  { ids: ['k3.1-pro', 'kimi-k3.1-pro', 'k3.1-pro-highspeed', 'kimi-k3.1-pro-highspeed'], providers: ['kimi-coding', 'moonshotai', 'moonshotai-cn'], efforts: three, defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://www.kimi.com/code/docs/kimi-code/models.html' },
  { ids: ['kimi-for-coding'], providers: ['kimi-coding'], efforts: three, defaultEffort: 'max', canDisable: true, mode: 'effort', source: 'https://www.kimi.com/code/docs/kimi-code/models.html' },
  { ids: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'], providers: ['zai', 'zhipu', 'zai-coding', 'zai-coding-cn'], efforts: three, defaultEffort: 'max', canDisable: false, mode: 'effort', source: 'https://docs.z.ai/guides/capabilities/thinking' },
  { ids: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'], providers: ['deepseek'], efforts: three, defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://api-docs.deepseek.com/guides/thinking_mode/' },
  { ids: ['deepseek-flash', 'deepseek-v4.1-flash'], providers: ['deepseek'], efforts: three, defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://api-docs.deepseek.com/guides/thinking_mode/' },
  { ids: ['qwen3.8-max', 'qwen3.8-flash'], providers: ['alibaba', 'alibaba-cn', 'dashscope', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan-individual-cn'], efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh', canDisable: true, mode: 'effort', source: 'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions' },
  { ids: ['gemini-4-argon', 'gemini-4-carbon', 'gemini-3.8-flash'], providers: ['google', 'google-genai', 'google-vertex'], efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', canDisable: false, mode: 'effort', source: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking' },
  { ids: ['gemini-4-neon', 'gemini-4-hydrogen'], providers: ['google', 'google-genai', 'google-vertex'], efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', canDisable: false, mode: 'effort', source: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking' },
  { ids: ['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools'], providers: ['google', 'google-genai', 'google-vertex'], efforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://ai.google.dev/gemini-api/docs/generate-content/thinking' },
  { ids: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.5-pro-ultraspeed'], providers: ['xiaomi', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'mimo'], efforts: [], defaultEffort: 'on', canDisable: true, mode: 'toggle', source: 'https://mimo.mi.com/docs/en-US/api/chat/responses' },
  { ids: ['minimax-m3.1-flash'], providers: ['minimax', 'minimax-cn'], efforts: five, defaultEffort: 'medium', canDisable: false, mode: 'effort', source: 'https://www.minimax.io/blog/minimax-m31f' },
  { ids: ['grok-4.7'], providers: ['xai'], efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisable: false, mode: 'effort', source: 'https://docs.x.ai/developers/models/grok-4.7' },
  { ids: ['minimax-m3'], providers: ['minimax', 'minimax-cn'], efforts: [], defaultEffort: 'on', canDisable: true, mode: 'toggle', source: 'https://platform.minimax.io/docs/api-reference/text-openai-api' },
  { ids: ['hy4-preview'], providers: ['tencent', 'hunyuan'], efforts: ['high'], defaultEffort: 'high', canDisable: true, mode: 'effort', source: 'https://cloud.tencent.com/document/product/1823/131208' },
];

const profilesById = new Map(MODEL_EFFORT_PROFILES.flatMap(profile => profile.ids.map(id => [normalizeIdentity(id), profile] as const)));

export function modelEffortProfile(name: string): ModelEffortProfile | undefined {
  return profilesById.get(normalizeIdentity(name.split('/').at(-1) ?? ''));
}
