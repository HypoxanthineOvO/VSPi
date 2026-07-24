import type { PlanTaskRouter } from "../app/vspi-app.js";
import type { StoredPlan } from "./types.js";

const DOMAIN_STOP_TERMS = new Set([
  "and",
  "the",
  "with",
  "this",
  "that",
  "its",
  "for",
  "from",
  "into",
  "new",
  "task",
  "work",
  "plan",
  "system",
  "design",
  "implement",
  "build",
  "create",
  "migrate",
  "migration",
  "deploy",
  "test",
  "release",
  "refactor",
  "integrate",
  "然后",
  "并且",
  "设计",
  "实现",
  "创建",
  "迁移",
  "部署",
  "测试",
  "发布",
  "重构",
  "集成",
]);

export function createDefaultPlanTaskRouter(): PlanTaskRouter {
  return {
    async route({ text, plan }) {
      if (!isClearlySeparateMultiStepTask(text, plan)) return { kind: "current-plan" };
      return {
        kind: "question",
        questions: [
          {
            id: "local-plan-task-scope",
            title: "任务归属",
            prompt: "这个多步骤任务与当前 Plan 明显无关，要新建 Plan 还是仅聊天处理？",
            kind: "singleChoice",
            options: [
              { id: "new-plan", label: "新建 Plan", description: "保持当前 Plan 不变" },
              { id: "chat-only", label: "仅聊天", description: "不写入当前 Plan" },
              { id: "current-plan", label: "仍归入当前 Plan", description: "确认它属于当前工作" },
            ],
          },
        ],
      };
    },
  };
}

function isClearlySeparateMultiStepTask(text: string, plan: StoredPlan): boolean {
  const normalized = text.toLocaleLowerCase();
  const actionSignals = normalized.match(
    /\b(?:design|implement|build|create|migrate|deploy|test|release|refactor|integrate|设计|实现|创建|迁移|部署|测试|发布|重构|集成)\b/gu,
  );
  const hasSequence = (actionSignals?.length ?? 0) >= 2 || /(?:,|，|;|；|\band\b|然后|并且|再)/u.test(normalized);
  if (!hasSequence) return false;
  const planText = [
    plan.title,
    plan.goal,
    plan.background ?? "",
    plan.nextAction ?? "",
    ...plan.challenges,
    ...collectItemTitles(plan.items),
  ].join(" ");
  const planTerms = terms(planText);
  return ![...terms(normalized)].some((term) => planTerms.has(term));
}

function collectItemTitles(items: StoredPlan["items"]): string[] {
  return items.flatMap((item) => [item.title, ...(item.children ? collectItemTitles(item.children) : [])]);
}

function terms(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}._-]{2,}/gu) ?? []).filter((term) => !DOMAIN_STOP_TERMS.has(term)),
  );
}
