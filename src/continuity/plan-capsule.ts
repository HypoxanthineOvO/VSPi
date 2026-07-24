import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PlanBinding, PlanWorkItem, StoredPlan } from "../plans/types.js";

const MAX_CAPSULE_CHARS = 2_000;

export function buildPlanCapsule(plan: StoredPlan): string {
  const items = flattenItems(plan.items);
  const focus = plan.focusItemId ? items.find((item) => item.id === plan.focusItemId) : undefined;
  const active = items.filter((item) => item.status === "in_progress" || item.status === "blocked");
  const lines = [
    `<vspi_plan_capsule source="Local Plan/${plan.id}" revision="${plan.revision}" semantic_hash="${plan.semanticHash}">`,
    `Goal: ${plan.goal}`,
    ...(focus ? [`Focus: [${focus.status}] ${focus.title}`] : []),
    ...(active.length > 0
      ? [
          "Active work:",
          ...active.map(
            (item) => `- [${item.status}] ${item.title}${item.blocker ? `; blocker: ${item.blocker}` : ""}`,
          ),
        ]
      : []),
    ...(plan.blockers.length > 0 ? ["Blockers:", ...plan.blockers.map((blocker) => `- ${blocker}`)] : []),
    ...(plan.nextAction ? [`Next action: ${plan.nextAction}`] : []),
    "Review this capsule against the current work before claiming completion.",
    "</vspi_plan_capsule>",
  ];
  const value = lines.join("\n");
  return value.length <= MAX_CAPSULE_CHARS ? value : `${value.slice(0, MAX_CAPSULE_CHARS - 32)}\n</vspi_plan_capsule>`;
}

export function createPlanCapsuleExtension(options: {
  readBinding(): Promise<PlanBinding | undefined>;
  readPlan(planId: string): Promise<StoredPlan | undefined>;
  onCapsule?(capsule: string | undefined): void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const binding = await options.readBinding();
      if (!binding) {
        options.onCapsule?.(undefined);
        return;
      }
      const plan = await options.readPlan(binding.planId);
      if (!plan) {
        options.onCapsule?.(undefined);
        return;
      }
      const capsule = buildPlanCapsule(plan);
      options.onCapsule?.(capsule);
      return { systemPrompt: `${event.systemPrompt}\n\n${capsule}` };
    });
  };
}

function flattenItems(items: PlanWorkItem[]): PlanWorkItem[] {
  const flattened: PlanWorkItem[] = [];
  const visit = (entries: PlanWorkItem[]) => {
    for (const item of entries) {
      flattened.push(item);
      if (item.children) visit(item.children);
    }
  };
  visit(items);
  return flattened;
}
