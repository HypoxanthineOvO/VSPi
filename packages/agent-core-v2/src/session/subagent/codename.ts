const AI_CODENAMES = [
  '梁文锋',
  '李飞飞',
  '辛顿',
  '杨立昆',
  '杨植麟',
  '唐杰',
  '闫俊杰',
  '姚顺雨',
  '罗福莉',
  '奥特曼',
  '达里奥',
  '陈天奇',
] as const;

const SYSTEMS_CODENAMES = [
  '黄仁勋',
  '苏姿丰',
  '张忠谋',
  '图灵',
  '香农',
  '诺伊斯',
  '摩尔',
  '布兰克',
  '格里尼奇',
  '霍尔尼',
  '克莱纳',
  '拉斯特',
  '罗伯茨',
] as const;

const PRODUCT_CODENAMES = [
  '乔布斯',
  '库克',
  '马化腾',
  '张小龙',
  '张一鸣',
  '雷军',
  '王兴',
  '丁磊',
  '李彦宏',
  '周鸿祎',
  '盖茨',
  '扎克伯格',
  '贝索斯',
  '马斯克',
] as const;

const CODER_CODENAMES = [...AI_CODENAMES, ...AI_CODENAMES, ...SYSTEMS_CODENAMES] as const;
const ALL_CODENAMES = [...AI_CODENAMES, ...SYSTEMS_CODENAMES, ...PRODUCT_CODENAMES] as const;
const SPECIAL_CODENAME = '特朗普';
const TASK_TITLE_LENGTH = 36;

export interface SubagentIdentity {
  readonly codename: string;
  readonly taskTitle: string;
}

export function selectSubagentIdentity(input: {
  readonly sessionId: string;
  readonly agentId: string;
  readonly profileName: string;
  readonly taskText: string;
  readonly usedCodenames?: ReadonlySet<string>;
}): SubagentIdentity {
  const seed = `${input.sessionId}\0${input.agentId}`;
  const used = input.usedCodenames ?? new Set<string>();
  const special = stableHash(`${seed}\0special`) % 100 < 2;
  if (special && !used.has(SPECIAL_CODENAME)) {
    return { codename: SPECIAL_CODENAME, taskTitle: taskTitle(input.taskText) };
  }
  const preferred = poolFor(input.profileName, input.taskText);
  const codename = pickAvailable(preferred, used, seed) ?? pickAvailable(ALL_CODENAMES, used, seed) ??
    ALL_CODENAMES[stableHash(seed) % ALL_CODENAMES.length]!;
  return { codename, taskTitle: taskTitle(input.taskText) };
}

export function taskTitle(value: string): string {
  const normalized = value
    .replace(/[`*_#>[\]()]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length === 0) return '执行任务';
  const characters = Array.from(normalized);
  return characters.length <= TASK_TITLE_LENGTH
    ? normalized
    : `${characters.slice(0, TASK_TITLE_LENGTH - 1).join('')}…`;
}

function poolFor(profileName: string, taskText: string): readonly string[] {
  const text = `${profileName} ${taskText}`.toLocaleLowerCase();
  if (/(ui|ux|tui|frontend|product|design|render|界面|交互|产品|渲染|设计)/u.test(text)) {
    return PRODUCT_CODENAMES;
  }
  if (/(gpu|cpu|cuda|chip|kernel|system|performance|parallel|芯片|硬件|内核|性能|并行|系统)/u.test(text)) {
    return SYSTEMS_CODENAMES;
  }
  if (/(ai|llm|model|agent|prompt|reason|context|research|explore|模型|智能体|推理|上下文|研究|探索)/u.test(text)) {
    return AI_CODENAMES;
  }
  if (/(coder|engineer|review|test|debug|开发|编码|审查|测试|调试)/u.test(text)) {
    return CODER_CODENAMES;
  }
  return ALL_CODENAMES;
}

function pickAvailable(
  pool: readonly string[],
  used: ReadonlySet<string>,
  seed: string,
): string | undefined {
  const start = stableHash(seed) % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(start + offset) % pool.length]!;
    if (!used.has(candidate)) return candidate;
  }
  return undefined;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
