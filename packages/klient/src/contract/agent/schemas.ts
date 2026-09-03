/**
 * Shared agent-scope wire schemas — the payload/result vocabulary reused by
 * the per-domain contracts in `agent/services.ts` and pinned against the
 * engine types by `test/contract-parity.ts`. `PromptPayload.input` mirrors the
 * `PromptPart` subset of `ContentPart` (text / image_url / video_url) from
 * `agent-core-v2/kosong/contract/message.ts`. Task wire shapes mirror the
 * `TaskInfo` union in `protocol/src/events.ts`.
 */

import { z } from 'zod';

// ── prompt parts ────────────────────────────────────────────────────────────

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  imageUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

const videoUrlPartSchema = z.object({
  type: z.literal('video_url'),
  videoUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

/** `PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>`. */
export const promptPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imageUrlPartSchema,
  videoUrlPartSchema,
]);

// ── payloads / results ──────────────────────────────────────────────────────

export const emptyPayloadSchema = z.object({});

export const promptPayloadSchema = z.object({
  input: z.array(promptPartSchema),
  // Mirrors `PromptPayload.disabledTools` in the engine (client-managed
  // session denylist, full-replace).
  disabledTools: z.array(z.string()).optional(),
  // Mirrors `PromptPayload.promptId` in the engine (client-chosen prompt
  // record id, echoed on the consuming turn's `turn.started`).
  promptId: z.string().min(1).optional(),
});

/** Same shape as `PromptSkillActivation` in the engine. */
export const promptSkillActivationSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

/** Same shape as `PromptWithSkillsInput` in the engine. */
export const promptWithSkillsPayloadSchema = promptPayloadSchema.extend({
  skills: z.array(promptSkillActivationSchema).min(1),
});

/** Same shape as `PromptWithSkillsResult` in the engine. */
export const promptWithSkillsResultSchema = z.object({
  turn_id: z.number().optional(),
  prompt_id: z.string(),
  created_at: z.string(),
  state: z.enum(['running', 'queued', 'blocked']),
});

/** Same shape as `SteerPayload` in the engine. */
export const steerPayloadSchema = z.object({
  input: z.array(promptPartSchema),
  promptId: z.string().optional(),
});

/** Same shape as `SkillActivationInput`'s wire subset in the engine. */
export const activateSkillPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

export const promptLaunchResultSchema = z.object({
  turn_id: z.number(),
});

export const cancelPayloadSchema = z.object({
  turnId: z.number().optional(),
});

export const runShellCommandPayloadSchema = z.object({
  command: z.string(),
  commandId: z.string().optional(),
});

export const shellCommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  isError: z.boolean().optional(),
  backgrounded: z.boolean().optional(),
});

export const cancelShellCommandPayloadSchema = z.object({
  commandId: z.string(),
});

export const setModelPayloadSchema = z.object({
  model: z.string(),
});

export const setModelResultSchema = z.object({
  model: z.string(),
  providerName: z.string().optional(),
});

export const runtimeBindingSchema = z.object({
  workspaceId: z.string(),
  runtimeId: z.string(),
});

export const permissionModeSchema = z.enum(['manual', 'yolo', 'auto']);

export const setPermissionPayloadSchema = z.object({
  mode: permissionModeSchema,
});

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
});

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
export const goalActorSchema = z.enum(['user', 'model', 'runtime', 'system']);

export const goalBudgetReportSchema = z
  .object({
    tokenBudget: z.number().nullable(),
    turnBudget: z.number().nullable(),
    wallClockBudgetMs: z.number().nullable(),
    remainingTokens: z.number().nullable(),
    remainingTurns: z.number().nullable(),
    remainingWallClockMs: z.number().nullable(),
    tokenBudgetReached: z.boolean(),
    turnBudgetReached: z.boolean(),
    wallClockBudgetReached: z.boolean(),
    overBudget: z.boolean(),
  })
  .strict();

export const goalSnapshotSchema = z
  .object({
    goalId: z.string(),
    objective: z.string(),
    completionCriterion: z.string().optional(),
    status: goalStatusSchema,
    turnsUsed: z.number(),
    tokensUsed: z.number(),
    wallClockMs: z.number(),
    budget: goalBudgetReportSchema,
    terminalReason: z.string().optional(),
  })
  .strict();

export const goalToolResultSchema = z
  .object({ goal: goalSnapshotSchema.nullable() })
  .strict();

/** Same shape as `GoalReasonInput` in the engine. */
export const goalReasonInputSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

/** Same shape as `ResumeGoalInput` in the engine. */
export const resumeGoalInputSchema = z
  .object({
    reason: z.string().optional(),
    continueIfPaused: z.boolean().optional(),
    continueIfBlocked: z.boolean().optional(),
  })
  .strict();

export const goalChangeSchema = z
  .object({
    kind: z.enum(['lifecycle', 'completion']),
    status: goalStatusSchema.optional(),
    reason: z.string().optional(),
    stats: z
      .object({
        turnsUsed: z.number(),
        tokensUsed: z.number(),
        wallClockMs: z.number(),
      })
      .strict()
      .optional(),
    actor: goalActorSchema.optional(),
  })
  .strict();

/**
 * `AgentContextData` — `history` items are full `ContextMessage`s (deep
 * `Message` / `Tool` / `PromptOrigin` unions); mirrored as `unknown` entries.
 */
export const agentContextDataSchema = z.object({
  history: z.array(z.unknown()),
  tokenCount: z.number(),
});

/** `AgentCommandInfo` (`agent-core-v2/agent/command/agentCommand.ts`). */
export const agentCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
});

/** The facade's `runCommand` input shape. */
export const runCommandPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

/** `PlanData = null | { id, content, path }` — null is JSON-representable. */
export const planDataSchema = z.union([
  z.null(),
  z.object({
    id: z.string(),
    content: z.string(),
    path: z.string(),
  }),
]);

export const cancelPlanPayloadSchema = z.object({
  id: z.string().optional(),
});

export const getTasksPayloadSchema = z.object({
  activeOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const taskInfoBaseFields = {
  taskId: z.string(),
  description: z.string(),
  status: taskLifecycleStatusSchema,
  detached: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.union([z.number(), z.null()]),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
} as const;

/** Protocol `TaskInfo` union (`protocol/src/events.ts`). */
export const agentTaskInfoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('process'),
    command: z.string(),
    pid: z.number(),
    exitCode: z.union([z.number(), z.null()]),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().optional(),
    subagentType: z.string().optional(),
    parentToolCallId: z.string().optional(),
    model: z.string().optional(),
    thinkingEffort: z.string().optional(),
    codename: z.string().optional(),
    taskTitle: z.string().optional(),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('question'),
    questionCount: z.number(),
    toolCallId: z.string().optional(),
    ...taskInfoBaseFields,
  }),
]);

export const stopTaskPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});

export const getTaskOutputPayloadSchema = z.object({
  taskId: z.string(),
  tail: z.number().optional(),
});
