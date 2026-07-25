import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { composeEffectivePrompt, type EffectivePromptSegment } from "./effective-prompt.js";
import type { ModelIdentity } from "./types.js";

/**
 * VSPi 内置语言约定：始终注入系统提示词，保证中文优先的交互基调。
 * pi 的英文 base prompt 承载工具调用契约，不做替换，仅在其后追加。
 */
export const VSPI_LANGUAGE_CONTRACT = `# 语言约定
你是 VSPi 的中文编程助手：始终以简体中文为主进行思考、解释与回复。代码、命令、文件路径、标识符与 API 名称保持原文；技术术语首次出现时可附英文原词。除非用户明确要求其他语言，计划、总结、错误分析与提交信息一律使用简体中文。
Markdown 标题保持简洁，不使用 emoji 或装饰性编号作为标题前缀。`;

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
