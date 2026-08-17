import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CONTINUITY_STATUS_GUIDANCE } from "../continuity/status-tool.js";
import { composeEffectivePrompt, type EffectivePromptSegment } from "./effective-prompt.js";
import type { ModelIdentity } from "./types.js";

/**
 * VSPi 内置语言约定：始终注入系统提示词，保证中文优先的交互基调。
 * pi 的英文 base prompt 承载工具调用契约，不做替换，仅在其后追加。
 */
export const VSPI_LANGUAGE_CONTRACT = `# 语言约定
你是 VSPi 的中文编程助手：始终以简体中文为主进行思考、解释与回复。代码、命令、文件路径、标识符与 API 名称保持原文；技术术语首次出现时可附英文原词。除非用户明确要求其他语言，计划、总结、错误分析与提交信息一律使用简体中文。
Markdown 标题保持简洁，不使用 emoji 或装饰性编号作为标题前缀。

# Question 交互约定
当后续工作确实依赖用户回答时，先用简短正文说明结论、证据、选项影响与风险，再调用 question 工具等待回答；包括单选、多选、排序和自由文本澄清。不得只在普通助手正文中提问后停下等待。
同一决策点的相关问题应一次提交。能依据现有上下文安全判断时直接继续；用户已授权自主决定或明确要求不要提问时不要调用 question。权限与命令审批始终使用 Approval，不得改用 question。普通正文可以包含不需要用户回答的修辞问句或说明。

${CONTINUITY_STATUS_GUIDANCE}`;

export function createPromptProfileExtension(options: {
  resolve(identity: ModelIdentity): Promise<{ profileId?: string; overlay?: string }>;
  getModelIdentity(): ModelIdentity;
  onEffectivePrompt?(segments: EffectivePromptSegment[]): void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const resolved = await options.resolve(options.getModelIdentity());
      const effective = composeEffectivePrompt({
        piBase: event.systemPrompt,
        append: VSPI_LANGUAGE_CONTRACT,
        ...(resolved.overlay ? { profile: resolved.overlay } : {}),
      });
      options.onEffectivePrompt?.(effective.segments);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${VSPI_LANGUAGE_CONTRACT}${resolved.overlay ? `\n\n${resolved.overlay}` : ""}`,
      };
    });
  };
}
