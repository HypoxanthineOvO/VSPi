import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { composeEffectivePrompt, type EffectivePromptSegment } from "./effective-prompt.js";
import type { ModelIdentity } from "./types.js";

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
        ...(resolved.overlay ? { profile: resolved.overlay } : {}),
      });
      options.onEffectivePrompt?.(effective.segments);
      if (!resolved.overlay) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${resolved.overlay}` };
    });
  };
}
