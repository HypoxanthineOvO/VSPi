export type CompactionProfileId = "pi-native" | "execution-continuity" | "research-decisions" | "custom";

export interface CompactOptions {
  profile: CompactionProfileId;
  customInstructions?: string;
}

export const COMPACTION_PROFILES: ReadonlyArray<{ id: CompactionProfileId; label: string }> = [
  { id: "pi-native", label: "Pi Native" },
  { id: "execution-continuity", label: "Execution Continuity" },
  { id: "research-decisions", label: "Research Decisions" },
  { id: "custom", label: "Custom" },
];

const EXECUTION_CONTINUITY =
  "Preserve the current goal, focus, in-progress work, blockers, next action, important decisions, and Local Plan revision. Keep enough evidence to resume execution without inventing progress.";
const RESEARCH_DECISIONS =
  "Preserve research questions, hypotheses, decisions, supporting and conflicting evidence, citations, unresolved risks, and open questions. Distinguish observations from conclusions.";

export function resolveCompactionProfile(input: {
  hasPlanBinding: boolean;
  profile?: CompactionProfileId;
  customInstructions?: string;
}): CompactOptions {
  const profile = input.profile ?? (input.hasPlanBinding ? "execution-continuity" : "pi-native");
  if (!COMPACTION_PROFILES.some((candidate) => candidate.id === profile)) {
    throw new Error(`Unknown compaction profile: ${profile}`);
  }
  if (profile === "pi-native") return { profile };
  if (profile === "execution-continuity") return { profile, customInstructions: EXECUTION_CONTINUITY };
  if (profile === "research-decisions") return { profile, customInstructions: RESEARCH_DECISIONS };
  const customInstructions = input.customInstructions?.trim();
  if (!customInstructions) throw new Error("Custom compaction instruction is required");
  return { profile, customInstructions };
}
