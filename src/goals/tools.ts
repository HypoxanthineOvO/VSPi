import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { GoalBackend, StoredGoal } from "./types.js";

export interface GoalBindingPort {
  read(): Promise<string | null>;
}

const Text = Type.String({ minLength: 1, maxLength: 4_000 });
const Revision = Type.Integer({ minimum: 1 });
const Evidence = Type.Array(Text, { maxItems: 100 });
const StatusParameters = Type.Object({}, { additionalProperties: false });
const CheckpointParameters = Type.Object(
  {
    expected_revision: Revision,
    current_item: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    completed_work: Type.Array(Text, { maxItems: 100 }),
    evidence: Evidence,
    next_item: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    note: Type.Optional(Text),
  },
  { additionalProperties: false },
);
const BlockParameters = Type.Object(
  {
    expected_revision: Revision,
    reason: Text,
    attempts: Type.Array(Text, { maxItems: 50 }),
    needed_input: Text,
  },
  { additionalProperties: false },
);
const CompleteParameters = Type.Object(
  { expected_revision: Revision, summary: Text, evidence: Evidence },
  { additionalProperties: false },
);

export function createGoalToolDefinitions(options: {
  backend: GoalBackend;
  binding: GoalBindingPort;
  onMutation?: (
    operation: "checkpoint" | "block" | "complete",
    goal: StoredGoal,
    previous: StoredGoal,
  ) => void | Promise<void>;
}): ToolDefinition[] {
  const boundGoal = async (): Promise<StoredGoal> => {
    const goalId = await options.binding.read();
    if (!goalId) throw new Error("No Goal is bound to this Session");
    const goal = await options.backend.read(goalId);
    if (!goal) throw new Error("The bound Goal was not found");
    return goal;
  };
  return [
    tool(
      "goal_status",
      "Goal Status",
      "Read the bound Goal contract, state, limits, counters, and latest marker.",
      StatusParameters,
      async () => projectGoal(await boundGoal()),
    ),
    tool(
      "goal_checkpoint",
      "Goal Checkpoint",
      "Record compact progress and evidence for the bound Goal. This does not complete or stop the Goal.",
      CheckpointParameters,
      async (raw) => {
        const current = await boundGoal();
        const goal = await options.backend.checkpoint(current.id, {
          expectedRevision: raw.expected_revision,
          completedWork: raw.completed_work,
          evidence: raw.evidence,
          ...(raw.current_item ? { currentItem: raw.current_item } : {}),
          ...(raw.next_item ? { nextItem: raw.next_item } : {}),
          ...(raw.note ? { note: raw.note } : {}),
        });
        await options.onMutation?.("checkpoint", goal, current);
        return projectGoal(goal);
      },
    ),
    tool(
      "goal_block",
      "Goal Block",
      "Stop automatic continuation only for a concrete blocker, recording attempts and the input or external change needed.",
      BlockParameters,
      async (raw) => {
        const current = await boundGoal();
        const goal = await options.backend.block(current.id, {
          expectedRevision: raw.expected_revision,
          reason: raw.reason,
          attempts: raw.attempts,
          neededInput: raw.needed_input,
        });
        await options.onMutation?.("block", goal, current);
        return projectGoal(goal);
      },
    ),
    tool(
      "goal_complete",
      "Goal Complete",
      "Claim that the immutable Goal contract is satisfied with evidence. This enters pending acceptance; only the user accepts it.",
      CompleteParameters,
      async (raw) => {
        const current = await boundGoal();
        const goal = await options.backend.claimComplete(current.id, {
          expectedRevision: raw.expected_revision,
          summary: raw.summary,
          evidence: raw.evidence,
        });
        await options.onMutation?.("complete", goal, current);
        return projectGoal(goal);
      },
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
      try {
        const value = await handler(raw);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      } catch (error) {
        const message = (error instanceof Error ? error.message : "unknown error").slice(0, 500);
        throw new Error(`${name} failed: ${message}`);
      }
    },
  };
}

function projectGoal(goal: StoredGoal) {
  return {
    id: goal.id,
    revision: goal.revision,
    contract: structuredClone(goal.contract),
    planId: goal.planId,
    state: goal.state,
    limits: structuredClone(goal.limits),
    autoRounds: goal.autoRounds,
    noProgressRounds: goal.noProgressRounds,
    consumedTokens: goal.consumedTokens,
    latestMarker: goal.markers.at(-1) ? structuredClone(goal.markers.at(-1)) : undefined,
    ...(goal.blocker ? { blocker: structuredClone(goal.blocker) } : {}),
    ...(goal.stateReason ? { stateReason: goal.stateReason } : {}),
  };
}
