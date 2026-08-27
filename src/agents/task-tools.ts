// Tool surface adapted from Kimi Code's TaskList/TaskOutput/TaskStop/WaitFor contract.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentTaskRuntime } from "./task-runtime.js";

const TaskListParameters = Type.Object(
  {
    active_only: Type.Optional(Type.Boolean({ default: true })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  },
  { additionalProperties: false },
);
const TaskOutputParameters = Type.Object(
  {
    task_id: Type.String({ minLength: 1, maxLength: 128 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
  },
  { additionalProperties: false },
);
const TaskStopParameters = Type.Object(
  {
    task_id: Type.String({ minLength: 1, maxLength: 128 }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500, default: "Stopped by TaskStop" })),
  },
  { additionalProperties: false },
);
const WaitForParameters = Type.Object(
  {
    task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    timeout: Type.Integer({ minimum: 1, maximum: 600 }),
  },
  { additionalProperties: false },
);

export function createAgentTaskTools(runtime: AgentTaskRuntime, ownerAgentId = "main"): ToolDefinition[] {
  const list: ToolDefinition<typeof TaskListParameters, unknown> = {
    name: "TaskList",
    label: "Task List",
    description:
      "List this agent's background tasks and statuses. Use active_only=false to include completed, failed, timed_out, killed, and lost tasks.",
    promptSnippet: "List durable background tasks and their current status.",
    parameters: TaskListParameters,
    executionMode: "parallel",
    async execute(_id, args) {
      return result({ tasks: runtime.list(ownerAgentId, args.active_only ?? true, args.limit ?? 20) });
    },
  };
  const output: ToolDefinition<typeof TaskOutputParameters, unknown> = {
    name: "TaskOutput",
    label: "Task Output",
    description:
      "Return a non-blocking metadata and output snapshot for one background task. The full log remains available at outputPath.",
    promptSnippet: "Inspect a durable background task without waiting for it.",
    parameters: TaskOutputParameters,
    executionMode: "parallel",
    async execute(_id, args) {
      if (args.offset !== undefined || args.max_bytes !== undefined) {
        return result(
          await runtime.outputRange(args.task_id, ownerAgentId, args.offset ?? 0, args.max_bytes ?? 16_384),
        );
      }
      return result(await runtime.output(args.task_id, ownerAgentId));
    },
  };
  const stop: ToolDefinition<typeof TaskStopParameters, unknown> = {
    name: "TaskStop",
    label: "Task Stop",
    description:
      "Stop one running background task. This is destructive and may leave partial side effects; a terminal task is returned unchanged.",
    promptSnippet: "Stop a running durable background task.",
    parameters: TaskStopParameters,
    executionMode: "sequential",
    async execute(_id, args) {
      const task = await runtime.stop(args.task_id, args.reason ?? "Stopped by TaskStop", "killed", ownerAgentId);
      if (!task) throw new Error(`Unknown background task: ${args.task_id}`);
      return result({ task });
    },
  };
  const wait: ToolDefinition<typeof WaitForParameters, unknown> = {
    name: "WaitFor",
    label: "Wait For",
    description:
      "Wait for one background task without making model requests. Timeout is 1-600 seconds and does not stop the task.",
    promptSnippet: "Wait for a background task only when its result blocks the next step.",
    parameters: WaitForParameters,
    executionMode: "parallel",
    async execute(_id, args, signal) {
      if (args.task_id) {
        const task = await runtime.wait(args.task_id, ownerAgentId, args.timeout * 1_000, signal);
        return result({ tasks: [task], timed_out: task.status === "running" });
      }
      const tasks = await runtime.waitAny(ownerAgentId, args.timeout * 1_000, signal);
      return result({ tasks, timed_out: tasks.length === 0 });
    },
  };
  return [list, output, stop, wait];
}

function result(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
