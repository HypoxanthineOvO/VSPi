import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { WorkflowSnapshot } from "../workflow/types.js";

const MAX_WORKFLOW_CAPSULE_CHARS = 2_000;

export function createWorkflowPlanExtension(options: {
  snapshot(): Promise<WorkflowSnapshot>;
  onCapsule?(capsule: string, snapshot: WorkflowSnapshot): void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const snapshot = await options.snapshot();
      const capsule = buildWorkflowPlanGuidance(snapshot);
      options.onCapsule?.(capsule, snapshot);
      return { systemPrompt: `${event.systemPrompt}\n\n${capsule}` };
    });
  };
}

export function buildWorkflowPlanGuidance(snapshot: WorkflowSnapshot): string {
  const delivery = snapshot.status === "ready" ? snapshot.delivery : undefined;
  const lines = [
    `<vspi_plan_guidance authority="hypo-workflow" status="${snapshot.status}" hidden="true">`,
    "每次收到用户指令时，先检查它是否与当前 Hypo-Workflow Delivery 的目标、范围、Milestone、Stone 和 next action 一致。",
    "需要建立或调整长期计划时，只能使用已安装的 Hypo-Workflow skill/command 维护其权威状态；不要创建或更新 VSPi Local Plan。遵守 Discussion、Goal/Plan、人工 Stone 和最终 acceptance 的生命周期边界。",
    "简单问答或一次性小改动不需要强行创建 Delivery。任务明显冲突、替换目标或跨出当前 Delivery 时，先向用户确认；取得实质进展、遇到阻塞或准备声称完成时，及时更新对应 Workflow 状态。",
    ...(delivery
      ? [
          `Delivery: ${delivery.id} (${delivery.kind}, ${delivery.status}, revision ${delivery.revision})`,
          ...delivery.milestones.map(
            (milestone) =>
              `- ${milestone.id}: [${milestone.status}] ${milestone.title}${milestone.stone ? " (Stone)" : ""}`,
          ),
        ]
      : [`Workflow diagnostic: ${snapshot.diagnostic}`]),
    "</vspi_plan_guidance>",
  ];
  const value = lines.join("\n");
  return value.length <= MAX_WORKFLOW_CAPSULE_CHARS
    ? value
    : `${value.slice(0, MAX_WORKFLOW_CAPSULE_CHARS - 32)}\n</vspi_plan_guidance>`;
}
