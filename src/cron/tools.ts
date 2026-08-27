import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { describeCron, parseCronExpression } from "./expression.js";
import { type CronRuntime, nextCronTaskRun } from "./runtime.js";
import { formatCronLocalTime, parseCronDuration, parseCronRunAt } from "./schedule.js";
import { MAX_CRON_PROMPT_BYTES } from "./types.js";

const CreateParameters = Type.Union([
  Type.Object(
    {
      cron: Type.String({ minLength: 1, maxLength: 200 }),
      prompt: Type.String({ minLength: 1, maxLength: MAX_CRON_PROMPT_BYTES }),
      recurring: Type.Optional(Type.Boolean({ default: true })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      after: Type.String({ minLength: 2, maxLength: 32, pattern: "^[0-9]+(?:[mMhHdD][0-9]*)*[mMhHdD]$" }),
      prompt: Type.String({ minLength: 1, maxLength: MAX_CRON_PROMPT_BYTES }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      run_at: Type.String({ minLength: 10, maxLength: 64 }),
      prompt: Type.String({ minLength: 1, maxLength: MAX_CRON_PROMPT_BYTES }),
    },
    { additionalProperties: false },
  ),
]);
const ListParameters = Type.Object({}, { additionalProperties: false });
const DeleteParameters = Type.Object(
  { id: Type.String({ minLength: 8, maxLength: 8, pattern: "^[0-9a-fA-F]{8}$" }) },
  { additionalProperties: false },
);

export function createCronToolDefinitions(runtime: CronRuntime): ToolDefinition[] {
  return [createTool(runtime), listTool(runtime), deleteTool(runtime)];
}

function createTool(runtime: CronRuntime): ToolDefinition<typeof CreateParameters, unknown> {
  return {
    name: "CronCreate",
    label: "Cron Create",
    description:
      "Schedule a visible prompt in this foreground session. Use cron for a standard local-time 5-field schedule, after for a relative one-shot such as 2h or 30m, or run_at for an absolute ISO date-time. Fires wait until idle and the VSPi process must remain running.",
    promptSnippet: "Schedule visible recurring or one-shot prompts in this foreground Session.",
    promptGuidelines: [
      "Cron jobs may be created autonomously when future continuation is useful, including an expected model quota or budget recovery; keep them visible and do not use shell sleep as a scheduler.",
    ],
    parameters: CreateParameters,
    executionMode: "sequential",
    async execute(_id, raw) {
      const task =
        "cron" in raw
          ? await runtime.create(raw)
          : await runtime.createAt({
              runAt:
                "after" in raw
                  ? runtime.now() + parseCronDuration(raw.after)
                  : parseCronRunAt(raw.run_at, runtime.now()),
              prompt: raw.prompt,
            });
      const details = {
        id: task.id,
        ...(task.cron
          ? { cron: task.cron, humanSchedule: describeCron(parseCronExpression(task.cron)) }
          : { runAt: task.runAt, humanSchedule: `once at ${formatCronLocalTime(task.runAt ?? 0)}` }),
        recurring: task.recurring,
        nextFireAt: nextCronTaskRun(task),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      return result(details);
    },
  };
}

function listTool(runtime: CronRuntime): ToolDefinition<typeof ListParameters, unknown> {
  return {
    name: "CronList",
    label: "Cron List",
    description: "List prompts scheduled in the current session. This operation is read-only.",
    parameters: ListParameters,
    executionMode: "parallel",
    async execute() {
      const details = {
        cron_jobs: runtime.list().map((task) => {
          return {
            ...task,
            humanSchedule: task.cron
              ? describeCron(parseCronExpression(task.cron))
              : `once at ${formatCronLocalTime(task.runAt ?? 0)}`,
            nextFireAt: nextCronTaskRun(task),
          };
        }),
      };
      return result(details);
    },
  };
}

function deleteTool(runtime: CronRuntime): ToolDefinition<typeof DeleteParameters, unknown> {
  return {
    name: "CronDelete",
    label: "Cron Delete",
    description: "Permanently cancel a cron task in the current session by its ID.",
    parameters: DeleteParameters,
    executionMode: "sequential",
    async execute(_id, raw) {
      if (!(await runtime.delete(raw.id))) throw new Error(`No cron task with id ${raw.id}`);
      return result({ deleted: raw.id });
    },
  };
}

function result<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export type CronCreateParameters = Static<typeof CreateParameters>;
