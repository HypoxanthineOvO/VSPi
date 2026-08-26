import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { LocalPlanBackend, PlanInput, StoredPlan } from "./types.js";

export interface PlanBindingPort {
  read(): Promise<string | null>;
  bind(planId: string | null): Promise<void>;
}

const Id = Type.String({ minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9._-]+$" });
const Text = Type.String({ minLength: 1, maxLength: 4_000 });
const Status = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("blocked"),
  Type.Literal("done"),
]);
const Item3 = Type.Object(
  { id: Id, title: Type.String({ minLength: 1, maxLength: 500 }), status: Status, blocker: Type.Optional(Text) },
  { additionalProperties: false },
);
const Item2 = Type.Object(
  {
    id: Id,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    status: Status,
    blocker: Type.Optional(Text),
    children: Type.Optional(Type.Array(Item3, { maxItems: 500 })),
  },
  { additionalProperties: false },
);
const Item1 = Type.Object(
  {
    id: Id,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    status: Status,
    blocker: Type.Optional(Text),
    children: Type.Optional(Type.Array(Item2, { maxItems: 500 })),
  },
  { additionalProperties: false },
);
const Plan = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    goal: Text,
    background: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
    challenges: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 }),
    items: Type.Array(Item1, { maxItems: 500 }),
    focusItemId: Type.Optional(Id),
    blockers: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 }),
    nextAction: Type.Optional(Text),
  },
  { additionalProperties: false },
);
const ListParameters = Type.Object(
  { include_archived: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
const ReadParameters = Type.Object({ plan_id: Id }, { additionalProperties: false });
const CreateParameters = Type.Object({ plan: Plan }, { additionalProperties: false });
const UpdateParameters = Type.Object(
  {
    plan_id: Id,
    expected_revision: Type.Integer({ minimum: 1 }),
    plan: Plan,
  },
  { additionalProperties: false },
);
const ArchiveParameters = Type.Object(
  { plan_id: Id, expected_revision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
const BindParameters = Type.Object(
  { plan_id: Type.Union([Id, Type.Null()]), expected_revision: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);

export function createPlanToolDefinitions(options: {
  backend: LocalPlanBackend;
  binding: PlanBindingPort;
  onMutation?: (operation: "create" | "update" | "archive" | "bind", plan?: StoredPlan) => void | Promise<void>;
}): ToolDefinition[] {
  const execute = <T>(operation: string, handler: () => Promise<T>) => safeExecute(operation, handler);
  return [
    tool("plan_list", "Plan List", "List local plans without exposing storage metadata.", ListParameters, (raw) =>
      execute("plan list", async () =>
        projectPlans(await options.backend.list({ includeArchived: raw.include_archived ?? false })),
      ),
    ),
    tool("plan_read", "Plan Read", "Read one local plan snapshot.", ReadParameters, (raw) =>
      execute("plan read", async () => projectPlan(await options.backend.read(raw.plan_id))),
    ),
    tool(
      "plan_create",
      "Plan Create",
      "Create a local plan with at most three work-item levels. Creating a plan binds it to the active Pi Session automatically, so /plan tracks it right away.",
      CreateParameters,
      (raw) =>
        execute("plan create", async () => {
          const plan = await options.backend.create(raw.plan as PlanInput);
          // 创建即绑定：/plan 面板只显示当前会话绑定的 plan，不绑定的 plan 创建后永远不可见
          // （曾表现为“模型调了 plan_create 但面板什么都不出”）。绑定失败不阻断创建，
          // plan 本身已落盘，plan_list / plan_read 仍可用；把失败原因返回给模型。
          let bindingWarning: string | undefined;
          try {
            await options.binding.bind(plan.id);
          } catch (error) {
            bindingWarning = `Plan created but binding the active session failed: ${error instanceof Error ? error.message : "unknown error"}. Run plan_bind to bind it manually.`;
          }
          await options.onMutation?.("create", plan);
          return bindingWarning === undefined
            ? projectPlan(plan)
            : { ...projectPlan(plan), bindingWarning };
        }),
    ),
    tool(
      "plan_update",
      "Plan Update",
      "CAS-update one local plan. This records progress only; it never completes or stops the current user task.",
      UpdateParameters,
      (raw) =>
        execute("plan update", async () => {
          const plan = await options.backend.update(raw.plan_id, {
            expectedRevision: raw.expected_revision,
            plan: raw.plan as PlanInput,
          });
          await options.onMutation?.("update", plan);
          return projectPlan(plan);
        }),
    ),
    tool("plan_archive", "Plan Archive", "Archive one local plan with CAS protection.", ArchiveParameters, (raw) =>
      execute("plan archive", async () => {
        const plan = await options.backend.archive(raw.plan_id, { expectedRevision: raw.expected_revision });
        await options.onMutation?.("archive", plan);
        return projectPlan(plan);
      }),
    ),
    tool(
      "plan_bind",
      "Plan Bind",
      "Bind or unbind the active Pi Session using a custom entry.",
      BindParameters,
      (raw) =>
        execute("plan bind", async () => {
          if (raw.plan_id === null) {
            await options.binding.bind(null);
            await options.onMutation?.("bind");
            return { planId: null };
          }
          const plan = await options.backend.read(raw.plan_id);
          if (!plan) throw new Error("Local Plan was not found");
          if (raw.expected_revision !== undefined && plan.revision !== raw.expected_revision) {
            throw new Error(
              `Local Plan revision conflict: expected ${raw.expected_revision}, current ${plan.revision}`,
            );
          }
          await options.binding.bind(plan.id);
          await options.onMutation?.("bind", plan);
          return { planId: plan.id, revision: plan.revision };
        }),
    ),
  ] as ToolDefinition[];
}

function tool<T extends ReturnType<typeof Type.Object>>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  handler: (raw: Static<T>) => Promise<unknown>,
): ToolDefinition<T, unknown> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_id, raw) {
      const value = await handler(raw);
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  };
}

async function safeExecute<T>(operation: string, handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    const raw = error instanceof Error ? error.message : "unknown error";
    const cleaned = raw
      .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[path]")
      .replace(/(?:token|secret|api[_-]?key)\s*[=:]\s*[^\s;,]+/gi, "$1=[redacted]")
      .slice(0, 500);
    throw new Error(`${operation} failed: ${cleaned}`);
  }
}

function projectPlans(plans: StoredPlan[]): StoredPlan[] {
  return plans.map((plan) => projectPlan(plan) as StoredPlan);
}

function projectPlan(plan: StoredPlan | undefined): StoredPlan | undefined {
  if (!plan) return undefined;
  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal,
    ...(plan.background === undefined ? {} : { background: plan.background }),
    challenges: structuredClone(plan.challenges),
    items: structuredClone(plan.items),
    ...(plan.focusItemId === undefined ? {} : { focusItemId: plan.focusItemId }),
    blockers: structuredClone(plan.blockers),
    ...(plan.nextAction === undefined ? {} : { nextAction: plan.nextAction }),
    revision: plan.revision,
    semanticHash: plan.semanticHash,
    archived: plan.archived,
  };
}
