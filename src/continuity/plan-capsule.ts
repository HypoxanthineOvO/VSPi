import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PlanBinding, PlanWorkItem, StoredPlan } from "../plans/types.js";

const MAX_CAPSULE_CHARS = 2_000;

export const LOCAL_PLAN_GUIDANCE = `<vspi_plan_guidance authority="local" hidden="true">
每次收到用户指令时，先判断它是否与当前长期计划一致，是否改变范围、优先级、依赖、阻塞项或下一步。
没有活动计划时：仅在任务明显需要多个步骤、跨多轮执行或长期跟踪时，使用 plan_create 创建结构化计划并立即用 plan_bind 绑定；简单问答和一次性小改动不要创建计划。
存在活动计划时：开始工作前检查冲突；明显无关或会替换目标时先用 question 向用户确认，不要静默覆盖。取得实质进展、出现阻塞、焦点变化或准备结束回复时，使用 plan_update 按当前 revision 更新状态、focusItemId、blockers 与 nextAction。CAS 冲突时重新 plan_read 后再判断，不要覆盖新版本。
如果用户明确调用 Hypo-Workflow skill/command，则该调用自身的生命周期 authority 优先，本轮不要把它的 Delivery 镜像或改写进 Local Plan；除此之外，Local Plan 是当前模式的长期计划权威。
</vspi_plan_guidance>`;

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
    "Review this capsule against the latest user instruction before acting and before claiming completion.",
    "</vspi_plan_capsule>",
  ];
  const value = lines.join("\n");
  return value.length <= MAX_CAPSULE_CHARS ? value : `${value.slice(0, MAX_CAPSULE_CHARS - 32)}\n</vspi_plan_capsule>`;
}

export function createPlanCapsuleExtension(options: {
  readBinding(): Promise<PlanBinding | undefined>;
  readPlan(planId: string): Promise<StoredPlan | undefined>;
  onCapsule?(capsule: string): void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const binding = await options.readBinding();
      if (!binding) {
        options.onCapsule?.(LOCAL_PLAN_GUIDANCE);
        return { systemPrompt: `${event.systemPrompt}\n\n${LOCAL_PLAN_GUIDANCE}` };
      }
      const plan = await options.readPlan(binding.planId);
      if (!plan) {
        options.onCapsule?.(LOCAL_PLAN_GUIDANCE);
        return { systemPrompt: `${event.systemPrompt}\n\n${LOCAL_PLAN_GUIDANCE}` };
      }
      const capsule = buildPlanCapsule(plan);
      const content = `${LOCAL_PLAN_GUIDANCE}\n\n${capsule}`;
      options.onCapsule?.(content);
      return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
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
