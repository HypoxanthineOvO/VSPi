import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSession,
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { EffortLevel } from "../domain/types.js";
import type { ExecutionPolicyService, PolicyAction } from "../policy/execution-policy.js";
import {
  createPolicyToolOverrides,
  platformChildToolNames,
  policyToolsForPlatform,
} from "../policy/pi-policy-tools.js";
import {
  AGENT_TOOL_NAMES,
  defaultAgentProjectConfig,
  loadAgentProjectConfig,
  saveAgentProjectConfig,
} from "./config.js";
import { AgentLeaseConflictError, acquireAgentExclusiveLease } from "./exclusive-lease.js";
import { type AgentGenerationLease, type AgentTreeContext, AgentTreeScheduler } from "./scheduler.js";
import { type AgentTaskRecord, AgentTaskRuntime } from "./task-runtime.js";
import { createAgentTaskTools } from "./task-tools.js";
import type {
  AgentCompletionEvent,
  AgentLaneSnapshot,
  AgentProjectConfig,
  AgentRole,
  AgentRunSnapshot,
  AgentSnapshot,
  AgentStatusEvent,
  ResolvedAgentModelPool,
  TeammateDefinition,
} from "./types.js";
import { AGENT_ROLES } from "./types.js";
import { createWorkspaceBashOperations } from "./workspace-tools.js";

const ModelSelector = Type.String({ minLength: 3, maxLength: 200, pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._:+-]+$" });
const MAX_ENUMERATED_MODEL_SELECTORS = 64;
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_PROMPT = `Your previous response was too brief. Provide a comprehensive final handoff for the parent agent. Include concrete technical details, findings, changes made, validation performed, unresolved risks, and any next steps. Return the complete report in this response.`;
const RETAINED_TASK_AGENT_LIMIT = 16;
const Effort = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const AgentRoleSchema = Type.Union(AGENT_ROLES.map((role) => Type.Literal(role)));
const BaseTaskAgentParameters = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 40_000 }),
    role: Type.Optional(AgentRoleSchema),
    context: Type.Optional(Type.String({ maxLength: 100_000 })),
    instructions: Type.Optional(Type.String({ maxLength: 40_000 })),
    system_prompt: Type.Optional(Type.String({ maxLength: 80_000 })),
    effort: Type.Optional(Effort),
    tools: Type.Optional(Type.Array(Type.Union(AGENT_TOOL_NAMES.map((name) => Type.Literal(name))), { maxItems: 7 })),
    inherit_parent_context: Type.Optional(Type.Boolean()),
    fork: Type.Optional(Type.Boolean()),
    run_in_background: Type.Optional(Type.Boolean()),
    resume: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
type AgentTaskValue = Static<typeof BaseTaskAgentParameters> & {
  model?: string;
  fallback_models?: string[];
  teammate?: string;
  lane?: string;
};

interface ParentIdentity {
  model?: { provider: string; id: string };
  effort: EffortLevel;
  tools: string[];
}

interface CachedLane {
  session: AgentSession;
  manager: SessionManager;
  model: string;
  effort: EffortLevel;
}

interface RunOutcome {
  output: string;
  run: AgentRunSnapshot;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}

interface RetainedTaskAgent {
  session?: AgentSession;
  manager: SessionManager;
  model: string;
  effort: EffortLevel;
  tools: string[];
  systemPrompt: string;
  instructions: string;
}

interface ResolvedRunSettings {
  teammate?: TeammateDefinition;
  tools: string[];
  effort: EffortLevel;
  role: AgentRole;
  preferred: string;
  modelReason: string;
}

export interface PiAgentManagerOptions {
  cwd: string;
  agentDir: string;
  trustedProject: boolean;
  recovery: boolean;
  modelRuntime: ModelRuntime;
  executionPolicy: ExecutionPolicyService;
  onStatus?: (event: AgentStatusEvent) => void;
  onCompletion?: (event: AgentCompletionEvent) => void | Promise<void>;
  sessionFactory?: (input: {
    manager: SessionManager;
    model: string;
    effort: EffortLevel;
    tools: string[];
    systemPrompt: string;
    instructions: string;
    context?: AgentTreeContext;
  }) => Promise<AgentSession>;
  taskDirectory?: string;
}

export class PiAgentManager {
  /**
   * C19 P0-3：Teammate 功能整体 Ban。配置解析与历史数据保留（agents.json 可加载），
   * 但 runtime 不再注册 teammate 路由、工具参数与 UI 投影；后续讨论再决定迁移或删除。
   */
  static readonly teammatesEnabled = false;
  private config: AgentProjectConfig;
  private readonly scheduler: AgentTreeScheduler;
  private readonly active = new Map<string, AgentRunSnapshot>();
  private readonly recent: AgentRunSnapshot[] = [];
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly retainedTaskAgents = new Map<string, RetainedTaskAgent>();
  private readonly taskRuntime: AgentTaskRuntime;
  private readonly lanes = new Map<string, CachedLane>();
  private readonly laneTails = new Map<string, Promise<void>>();
  private readonly laneStates = new Map<string, AgentLaneSnapshot>();
  private readonly pools: ResolvedAgentModelPool[];
  private rootContext: AgentTreeContext | undefined;
  private rootTaskEpoch = 0;
  private pendingRequired = new Set<string>();
  private routingHints = new Map<string, "preferred" | "consult">();
  private activeTurnOverrides = new Set<string>();
  private nextTurnOverrides = new Set<string>();
  private sessionOverrides = new Set<string>();
  private diagnostic: string | undefined;
  private disposed = false;

  private constructor(
    private readonly options: PiAgentManagerOptions,
    config: AgentProjectConfig,
    taskRuntime: AgentTaskRuntime,
    private readonly taskDirectory: string,
    diagnostic?: string,
  ) {
    this.config = config;
    this.scheduler = new AgentTreeScheduler(
      config.maxConcurrency,
      config.maxDepth,
      config.maxAgentsPerTree,
      config.maxTreeTokens,
      config.maxTreeCostUsd,
    );
    this.pools = resolveModelPools(options.modelRuntime, config);
    this.taskRuntime = taskRuntime;
    this.diagnostic = diagnostic;
  }

  static async create(options: PiAgentManagerOptions): Promise<PiAgentManager> {
    let manager: PiAgentManager | undefined;
    const taskDirectory =
      options.taskDirectory ??
      join(
        options.agentDir,
        "vspi-agent-tasks",
        createHash("sha256").update(resolve(options.cwd)).digest("hex").slice(0, 20),
      );
    const taskRuntime = await AgentTaskRuntime.open({
      directory: taskDirectory,
      onChange: () => manager?.restoreTaskProjection(),
      deliverNotification: (record, output) => manager?.deliverTaskNotification(record, output) ?? Promise.resolve(),
    });
    if (options.recovery) {
      manager = new PiAgentManager(
        options,
        { ...defaultAgentProjectConfig(), allowedModels: [] },
        taskRuntime,
        taskDirectory,
        "Recovery mode disables delegated agents",
      );
      manager.restoreTaskProjection();
      return manager;
    }
    try {
      manager = new PiAgentManager(
        options,
        await loadAgentProjectConfig(options.cwd, options.trustedProject),
        taskRuntime,
        taskDirectory,
      );
    } catch (error) {
      manager = new PiAgentManager(
        options,
        { ...defaultAgentProjectConfig(), allowedModels: [] },
        taskRuntime,
        taskDirectory,
        `Agent configuration rejected: ${safeError(error)}`,
      );
    }
    manager.restoreTaskProjection();
    manager.restoreRetainedAgents();
    await taskRuntime.retryNotifications();
    return manager;
  }

  createTaskTools(ownerAgentId = "main"): ToolDefinition[] {
    return createAgentTaskTools(this.taskRuntime, ownerAgentId);
  }

  retryTaskNotifications(): Promise<void> {
    return this.taskRuntime.retryNotifications();
  }

  async stopTask(taskId: string, reason = "Stopped by user"): Promise<void> {
    const task = await this.taskRuntime.stop(taskId, reason, "killed", "main");
    if (!task) throw new Error(`Unknown background task: ${taskId}`);
  }

  async detachTask(taskId: string): Promise<void> {
    const task = await this.taskRuntime.detach(taskId, "main");
    if (!task) throw new Error(`Unknown background task: ${taskId}`);
  }

  rebindRuntime(bindings: {
    modelRuntime: ModelRuntime;
    onStatus: NonNullable<PiAgentManagerOptions["onStatus"]>;
    onCompletion: NonNullable<PiAgentManagerOptions["onCompletion"]>;
  }): void {
    this.options.modelRuntime = bindings.modelRuntime;
    this.options.onStatus = bindings.onStatus;
    this.options.onCompletion = bindings.onCompletion;
    this.pools.splice(0, this.pools.length, ...resolveModelPools(bindings.modelRuntime, this.config));
  }

  createTool(
    parentTools: string[],
    allowTeammates: boolean,
    inherited?: AgentTreeContext,
    ownerAgentId = inherited?.agentId ?? "main",
  ): ToolDefinition {
    // C19 P0-3：Teammate Ban——即使 allowTeammates（root 调用）也不暴露 teammate 参数。
    const teammatesUsable = PiAgentManager.teammatesEnabled && allowTeammates && this.config.teammates.length > 0;
    const teammateSummary = this.config.teammates
      .map(
        (item) =>
          `${item.id} (${item.role}, ${item.routing}, ${item.currentModel ?? item.preferredModel ?? "inherit"})`,
      )
      .join("; ");
    const modelChoices = this.availableModelSelectors();
    const modelSchema =
      modelChoices.length > 0 && modelChoices.length <= MAX_ENUMERATED_MODEL_SELECTORS
        ? Type.Union(modelChoices.map((model) => Type.Literal(model)))
        : ModelSelector;
    const taskParameters = Type.Object(
      {
        ...BaseTaskAgentParameters.properties,
        model: Type.Optional(modelSchema),
        fallback_models: Type.Optional(Type.Array(modelSchema, { maxItems: 16 })),
      },
      { additionalProperties: false },
    );
    const teammateParameters = Type.Object(
      {
        ...taskParameters.properties,
        teammate: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" })),
        lane: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" })),
      },
      { additionalProperties: false },
    );
    const parameters = teammatesUsable ? teammateParameters : taskParameters;
    return {
      name: "subagent",
      label: "Subagent",
      description: [
        "Run one isolated Task Agent or a configured project Teammate and return its result.",
        "Task Agents receive only task/context fields unless inherit_parent_context is true.",
        "Model and effort inherit from the caller when omitted; fallback_models are used only for positively identified quota exhaustion.",
        teammatesUsable
          ? `Configured teammates: ${teammateSummary}. A teammate call requires teammate and may set lane.`
          : "Choose role instead of a concrete model; the child inherits its provider's configured model pool.",
        "Run parallel tasks by issuing multiple subagent tool calls in one response.",
        "Set run_in_background=true only for independent work; completion is delivered automatically.",
        "Use resume with a completed agent_id and a new task prompt to continue that child conversation.",
        "Set fork=true to create a new child with a one-time caller-context snapshot; fork cannot be combined with resume or model/type overrides.",
        `Nested agents may spawn children up to depth ${this.scheduler.maxDepth}.`,
        "Token, cost and duration figures are telemetry only; they never block or discard results.",
      ].join(" "),
      promptSnippet:
        "Run foreground or background delegated agents with isolated context; completed children can be resumed by agent_id.",
      promptGuidelines: [
        "Use background subagents only for independent work; their completion is delivered automatically, and resume continues a completed child by agent_id.",
      ],
      parameters,
      executionMode: "parallel",
      execute: async (_toolCallId, raw, signal, onUpdate, ctx) => {
        if (this.diagnostic) throw new Error(this.diagnostic);
        if (this.disposed) throw new Error("Agent manager is disposed");
        const task = raw as AgentTaskValue;
        this.validateForkTask(task);
        this.validateResumeTask(task);
        if (!allowTeammates && task.teammate) {
          throw new Error("Child agents cannot invoke persistent Teammates");
        }
        if (allowTeammates && task.teammate && !PiAgentManager.teammatesEnabled) {
          throw new Error("Teammates are temporarily disabled; use task agents instead");
        }
        const background = task.run_in_background === true;
        const root = background ? this.scheduler.root() : (inherited ?? this.rootContext ?? this.scheduler.root());
        const ownsTree = background || (inherited === undefined && this.rootContext === undefined);
        const agentId = task.resume?.trim() || randomUUID();
        const registered = await this.taskRuntime.register({
          agentId,
          ownerAgentId,
          description: task.task,
          detached: background,
        });
        const taskId = registered.taskId;
        const parent: ParentIdentity = {
          ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
          effort: normalizeEffort(ctx.thinkingLevel),
          tools: parentTools,
        };
        const fingerprint = compactText(task.task, 2_000).toLocaleLowerCase();
        if (/^(?:no[ -]?op|noop|unused|test|测试)[.!。\s]*$/iu.test(fingerprint)) {
          throw new Error("Subagent task must request substantive work");
        }
        if (!task.resume) this.resolveRunSettings(task, parent);
        const parentContext = () =>
          serializeParentContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        const operation = this.run(
          task,
          root,
          parent,
          parentContext,
          background ? registered.signal : signal ? AbortSignal.any([signal, registered.signal]) : registered.signal,
          (message) => {
            onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } });
          },
          taskId,
          agentId,
          background,
        );
        if (background) {
          void operation
            .then((outcome) => this.taskRuntime.settle(taskId, { status: "completed", output: outcome.output }))
            .catch((error) =>
              this.taskRuntime.settle(taskId, {
                status:
                  error instanceof Error && error.name === "AbortError"
                    ? "killed"
                    : isBudgetError(error)
                      ? "timed_out"
                      : "failed",
                stopReason: safeError(error),
              }),
            )
            .finally(() => {
              if (ownsTree) this.scheduler.finishTree(root.treeId);
            });
          const text = [
            `task_id: ${taskId}`,
            "status: running",
            `agent_id: ${agentId}`,
            "automatic_notification: enabled",
            `resume_hint: call subagent with resume="${agentId}" and a new task prompt after completion`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: { taskId, agentId, status: "running" } };
        }
        let foregroundDetached = false;
        try {
          const outcomePromise = operation;
          const release = this.taskRuntime.waitForForegroundRelease(taskId);
          const detached = release.then((reason) => (reason === "detached" ? "detached" : "terminal"));
          if ((await Promise.race([outcomePromise.then(() => "terminal" as const), detached])) === "detached") {
            foregroundDetached = true;
            void outcomePromise
              .then((outcome) => this.taskRuntime.settle(taskId, { status: "completed", output: outcome.output }))
              .catch((error) =>
                this.taskRuntime.settle(taskId, {
                  status:
                    error instanceof Error && error.name === "AbortError"
                      ? "killed"
                      : isBudgetError(error)
                        ? "timed_out"
                        : "failed",
                  stopReason: safeError(error),
                }),
              )
              .finally(() => {
                if (ownsTree) this.scheduler.finishTree(root.treeId);
              });
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `task_id: ${taskId}`,
                    "status: running",
                    `agent_id: ${agentId}`,
                    "detached: true",
                    "automatic_notification: enabled",
                  ].join("\n"),
                },
              ],
              details: { taskId, agentId, status: "running", detached: true },
            };
          }
          const outcomes = [await outcomePromise];
          await this.taskRuntime.settle(taskId, {
            status: "completed",
            ...(outcomes[0]?.output !== undefined ? { output: outcomes[0].output } : {}),
          });
          const details = { results: outcomes };
          return {
            content: [
              {
                type: "text",
                text: outcomes[0]?.output ?? "",
              },
            ],
            details,
          };
        } catch (error) {
          await this.taskRuntime.settle(taskId, {
            status:
              error instanceof Error && error.name === "AbortError"
                ? "killed"
                : isBudgetError(error)
                  ? "timed_out"
                  : "failed",
            stopReason: safeError(error),
          });
          throw error;
        } finally {
          if (ownsTree && !foregroundDetached) this.scheduler.finishTree(root.treeId);
        }
      },
    } as ToolDefinition<typeof parameters>;
  }

  beginRootTask(text: string, merge = false): void {
    const normalized = text.toLocaleLowerCase();
    const matches = (item: TeammateDefinition) =>
      item.match.length > 0 && item.match.some((match) => normalized.includes(match.toLocaleLowerCase()));
    const activeTeammates = PiAgentManager.teammatesEnabled ? this.config.teammates : [];
    const matchedRequired = new Set(
      activeTeammates.filter((item) => item.routing === "required" && matches(item)).map((item) => item.id),
    );
    const matchedHints = activeTeammates.filter(
      (item): item is TeammateDefinition & { routing: "preferred" | "consult" } =>
        (item.routing === "preferred" || item.routing === "consult") && matches(item),
    );
    if (!merge) {
      if (this.rootContext) this.scheduler.finishTree(this.rootContext.treeId);
      this.rootContext = this.scheduler.root();
      this.rootTaskEpoch += 1;
      this.activeTurnOverrides = this.nextTurnOverrides;
      this.nextTurnOverrides = new Set();
      this.pendingRequired = matchedRequired;
      this.routingHints = new Map(matchedHints.map((item) => [item.id, item.routing]));
    } else {
      for (const id of matchedRequired) this.pendingRequired.add(id);
      for (const item of matchedHints) this.routingHints.set(item.id, item.routing);
    }
    for (const id of [...this.pendingRequired]) {
      if (this.overrideApplies(id)) this.pendingRequired.delete(id);
    }
  }

  capabilityContext(): string | undefined {
    const activeTeammates = PiAgentManager.teammatesEnabled ? this.config.teammates : [];
    const activeTasks = this.taskRuntime.list("main", true, 20);
    if (activeTeammates.length === 0 && this.pendingRequired.size === 0 && activeTasks.length === 0) return;
    const lines = activeTeammates.map((item) => {
      const current = item.currentModel ?? item.preferredModel ?? "inherit";
      const fallback = item.fallback ? `; sticky fallback from ${item.fallback.from}: ${item.fallback.reason}` : "";
      return `- ${item.id}: role=${item.role}; routing=${item.routing}; model=${current}; effort=${item.effort ?? "inherit"}${fallback}`;
    });
    return [
      "<vspi_agent_capabilities>",
      "Available capability: isolated Task Agents and the project Teammates listed below. This is capability and policy state, not a workflow prescription.",
      ...(activeTasks.length > 0
        ? [
            "Background tasks are still active. Do not start duplicates; use TaskList, TaskOutput, TaskStop, or WaitFor:",
            ...activeTasks.map((task) => `- ${task.taskId}: ${task.status}; ${task.description}`),
          ]
        : []),
      ...lines,
      ...(this.pendingRequired.size > 0
        ? [`User policy for this turn requires teammate routing: ${[...this.pendingRequired].join(", ")}.`]
        : []),
      ...(this.routingHints.size > 0
        ? [
            `Routing guidance for this turn: ${[...this.routingHints]
              .map(([id, routing]) => `${routing}=${id}`)
              .join(", ")}. Preferred routes by default; consult is advisory; neither blocks main-agent completion.`,
          ]
        : []),
      ...(this.activeTurnOverrides.size > 0 || this.sessionOverrides.size > 0
        ? [
            `Typed required-routing overrides: turn=${[...this.activeTurnOverrides].join(", ") || "none"}; session=${[...this.sessionOverrides].join(", ") || "none"}.`,
          ]
        : []),
      "Manual teammates are used only when a call explicitly names them.",
      "</vspi_agent_capabilities>",
    ].join("\n");
  }

  /** Teammate Ban（C19 P0-3）：runtime 不再暴露任何 teammate 表面。 */
  private assertTeammatesEnabled(): void {
    if (!PiAgentManager.teammatesEnabled) {
      throw new Error("Teammates are temporarily disabled; configuration data is preserved");
    }
  }

  assertMainAction(action: PolicyAction): void {
    if (isPersistentAgentMutation(action, this.options.cwd)) {
      throw new Error("Persistent Teammate changes require a typed /agents action");
    }
  }

  assertRootTaskComplete(): void {
    if (this.pendingRequired.size > 0) {
      throw new Error(`Required teammate has not completed: ${[...this.pendingRequired].join(", ")}`);
    }
    if (this.rootContext) this.scheduler.finishTree(this.rootContext.treeId);
    this.rootContext = undefined;
    this.activeTurnOverrides.clear();
    this.routingHints.clear();
  }

  snapshot(): AgentSnapshot {
    return {
      enabled: !this.diagnostic,
      projectTrusted: this.options.trustedProject,
      recovery: this.options.recovery,
      limits: {
        maxDepth: this.scheduler.maxDepth,
        maxAgentsPerTree: this.scheduler.maxAgentsPerTree,
        maxConcurrency: this.scheduler.maxConcurrency,
        maxRunTokens: this.config.maxRunTokens,
        maxTreeTokens: this.config.maxTreeTokens,
        maxTreeCostUsd: this.config.maxTreeCostUsd,
        maxRunSeconds: this.config.maxRunSeconds,
      },
      pools: structuredClone(this.pools),
      active: [...this.active.values()].map(cloneRun),
      recent: this.recent.map(cloneRun),
      // C19 P0-3：Teammate Ban——snapshot 不再暴露 teammate 投影，配置数据仍在磁盘。
      teammates: (PiAgentManager.teammatesEnabled ? this.config.teammates : []).map((item) => ({
        ...structuredClone(item),
        activeLanes: [...this.lanes.keys()]
          .filter((key) => key.startsWith(`${item.id}:`))
          .map((key) => key.slice(item.id.length + 1)),
        lanes: [...this.laneStates]
          .filter(([key]) => key.startsWith(`${item.id}:`))
          .map(([, lane]) => structuredClone(lane)),
        stickyFallback: item.fallback !== undefined,
      })),
      authority: {
        pendingRequired: [...this.pendingRequired],
        turnOverrides: [...this.activeTurnOverrides],
        sessionOverrides: [...this.sessionOverrides],
        taskEpoch: this.rootTaskEpoch,
      },
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }

  async switchTeammateModel(id: string, model: string): Promise<void> {
    this.assertTeammatesEnabled();
    await this.resolveModel(model);
    const gate = await this.acquireTeammateGate(id);
    let configGate: Awaited<ReturnType<typeof acquireAgentExclusiveLease>> | undefined;
    try {
      configGate = await this.acquireConfigGate();
      await this.refreshMutableProjectConfig();
      const teammate = this.requireTeammate(id);
      this.assertAllowedModel(model);
      const previousModel = teammate.currentModel;
      const previousFallback = teammate.fallback ? structuredClone(teammate.fallback) : undefined;
      teammate.currentModel = model;
      delete teammate.fallback;
      try {
        await saveAgentProjectConfig(this.options.cwd, this.options.trustedProject, this.config);
      } catch (error) {
        if (previousModel) teammate.currentModel = previousModel;
        else delete teammate.currentModel;
        if (previousFallback) teammate.fallback = previousFallback;
        else delete teammate.fallback;
        throw error;
      }
      await this.closeTeammateLanes(id);
    } finally {
      await configGate?.release();
      await gate.release();
    }
  }

  async resetTeammateLane(id: string, lane = "default"): Promise<void> {
    this.assertTeammatesEnabled();
    this.requireTeammate(id);
    const safeLane = identifier(lane, "lane");
    const key = `${id}:${safeLane}`;
    await this.withLane(key, async () => {
      const teammate = this.requireTeammate(id);
      const cached = this.lanes.get(key);
      cached?.session.dispose();
      this.lanes.delete(key);
      const manager = await this.newLaneManager(id, safeLane);
      manager.appendCustomEntry("vspi.teammate-lane-reset", { at: new Date().toISOString() });
      const model = teammate.currentModel ?? teammate.preferredModel;
      if (!model) return;
      const session = await this.createSession(
        manager,
        model,
        teammate.effort ?? "medium",
        teammate.tools,
        teammate.systemPrompt,
        "",
        undefined,
      );
      this.lanes.set(key, { session, manager, model, effort: teammate.effort ?? "medium" });
    });
  }

  async setModelPoolRole(provider: string, role: AgentRole, model: string): Promise<void> {
    if (!this.options.trustedProject) throw new Error("Project trust is required to change Agent Pools");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider) || !AGENT_ROLES.includes(role)) {
      throw new Error("Agent Pool provider or role is invalid");
    }
    await this.resolveModel(model);
    const gate = await this.acquireConfigGate();
    try {
      await this.refreshMutableProjectConfig();
      if (!this.config.crossProviderDelegation && !model.startsWith(`${provider}/`)) {
        throw new Error("Cross-provider delegation is disabled for this project");
      }
      const previous = structuredClone(this.config.modelPools);
      this.config.modelPools[provider] = {
        roles: { ...(this.config.modelPools[provider]?.roles ?? {}), [role]: model },
      };
      try {
        await saveAgentProjectConfig(this.options.cwd, true, this.config);
      } catch (error) {
        this.config.modelPools = previous;
        throw error;
      }
      this.pools.splice(0, this.pools.length, ...resolveModelPools(this.options.modelRuntime, this.config));
    } finally {
      await gate.release();
    }
  }

  async cancelAll(): Promise<void> {
    const trees = new Set([...this.active.values()].map((run) => run.treeId));
    if (this.rootContext) trees.add(this.rootContext.treeId);
    for (const treeId of trees) this.scheduler.cancelTree(treeId);
    await Promise.all([...this.activeSessions.values()].map((session) => session.abort().catch(() => undefined)));
  }

  overrideRequiredTeammate(id: string, scope: "turn" | "session" = "turn"): void {
    this.assertTeammatesEnabled();
    const target = id === "all" ? "*" : this.requireTeammate(id).id;
    if (scope === "session") this.sessionOverrides.add(target);
    else if (this.rootContext) this.activeTurnOverrides.add(target);
    else this.nextTurnOverrides.add(target);
    if (this.rootContext) {
      for (const pending of [...this.pendingRequired]) {
        if (target === "*" || pending === target) this.pendingRequired.delete(pending);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelAll();
    for (const lane of this.lanes.values()) lane.session.dispose();
    this.lanes.clear();
    for (const retained of this.retainedTaskAgents.values()) retained.session?.dispose();
    this.retainedTaskAgents.clear();
    await this.taskRuntime.close();
  }

  private async run(
    task: AgentTaskValue,
    parentContext: AgentTreeContext,
    parent: ParentIdentity,
    parentHistory: () => string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
    runId: string,
    agentId: string,
    background: boolean,
  ): Promise<RunOutcome> {
    if (task.teammate && !PiAgentManager.teammatesEnabled) {
      throw new Error("Teammates are temporarily disabled; use task agents instead");
    }
    const taskEpoch = this.rootTaskEpoch;
    const fingerprint = compactText(task.task, 2_000).toLocaleLowerCase();
    if (/^(?:no[ -]?op|noop|unused|test|测试)[.!。\s]*$/iu.test(fingerprint)) {
      throw new Error("Subagent task must request substantive work");
    }
    const retained = task.resume ? this.requireRetainedAgent(agentId) : undefined;
    const settings = retained
      ? {
          tools: [...retained.tools],
          effort: retained.effort,
          role: task.role ?? inferAgentRole(task.task),
          preferred: retained.model,
          modelReason: "resumed child binding",
        }
      : this.resolveRunSettings(task, parent);
    const context = this.scheduler.child(parentContext, runId, fingerprint, agentId);
    const treeSignal = this.scheduler.treeSignal(context.treeId);
    const runSignal = signal ? AbortSignal.any([signal, treeSignal]) : treeSignal;
    const teammate = settings.teammate;
    const lane = teammate ? identifier(task.lane ?? "default", "lane") : undefined;
    const queuedAt = new Date().toISOString();
    const run: AgentRunSnapshot = {
      id: runId,
      agentId,
      treeId: context.treeId,
      ...(context.parentRunId ? { parentId: context.parentRunId } : {}),
      kind: teammate ? "teammate" : "task",
      ...(teammate ? { teammateId: teammate.id } : {}),
      ...(lane ? { lane } : {}),
      depth: context.depth,
      model: settings.preferred,
      provider: providerFromSelector(settings.preferred),
      role: settings.role,
      profile: teammate?.id ?? settings.role,
      modelReason: settings.modelReason,
      ...(teammate?.preferredModel ? { preferredModel: teammate.preferredModel } : {}),
      effort: settings.effort,
      contextMode: teammate ? "lane" : task.inherit_parent_context || task.fork ? "inherited" : "isolated",
      contextChars: task.context?.length ?? 0,
      task: redactAuditText(task.task, 500),
      tools: settings.tools,
      usage: emptyUsage(),
      budget: this.runBudget(context.treeId, emptyUsage()),
      timeline: [{ at: queuedAt, kind: "queued", summary: "Run queued" }],
      status: "queued",
      background,
      resumed: retained !== undefined,
    };
    this.publish(run);
    const lease = this.scheduler.createLease();
    context.lease = lease;
    parentContext.lease?.suspend();
    try {
      await lease.acquire(runSignal);
      run.status = "running";
      run.startedAt = new Date().toISOString();
      run.deadlineAt = new Date(Date.now() + this.config.maxRunSeconds * 1_000).toISOString();
      appendTimeline(run, "started", "Generation started");
      this.publish(run);
      const operation = () => {
        const current = teammate ? this.resolveRunSettings(task, parent) : settings;
        run.model = current.preferred;
        run.provider = providerFromSelector(current.preferred);
        run.role = current.role;
        run.modelReason = current.modelReason;
        run.effort = current.effort;
        run.tools = [...current.tools];
        delete run.preferredModel;
        if (current.teammate?.preferredModel) run.preferredModel = current.teammate.preferredModel;
        this.publish(run);
        return this.runWithFallback(
          task,
          current.teammate,
          lane,
          context,
          parent,
          current.tools,
          current.preferred,
          current.effort,
          parentHistory,
          runSignal,
          update,
          run,
          lease,
          agentId,
          retained,
        );
      };
      const outcome =
        teammate && lane ? await this.withLane(`${teammate.id}:${lane}`, operation, runSignal) : await operation();
      if (taskEpoch === this.rootTaskEpoch) {
        if (teammate) this.pendingRequired.delete(teammate.id);
      }
      this.publish(run);
      run.summary = redactAuditText(outcome.output, 12_000);
      this.publish(run);
      return outcome;
    } catch (error) {
      run.status = error instanceof Error && error.name === "AbortError" ? "cancelled" : "error";
      run.finishedAt = new Date().toISOString();
      run.error = safeError(error);
      appendTimeline(
        run,
        run.status === "cancelled" ? "cancelled" : isBudgetError(error) ? "budget" : "failed",
        run.status === "cancelled" ? "Run cancelled" : safeError(error),
      );
      this.publish(run);
      throw error;
    } finally {
      lease.release();
      await parentContext.lease?.resume(runSignal).catch(() => undefined);
    }
  }

  private async runWithFallback(
    task: AgentTaskValue,
    teammate: TeammateDefinition | undefined,
    lane: string | undefined,
    context: AgentTreeContext,
    parent: ParentIdentity,
    tools: string[],
    preferred: string,
    effort: EffortLevel,
    parentHistory: () => string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
    run: AgentRunSnapshot,
    lease: AgentGenerationLease,
    agentId: string,
    retained: RetainedTaskAgent | undefined,
  ): Promise<RunOutcome> {
    const fallbackModels = task.fallback_models ?? teammate?.fallbackModels ?? [];
    const candidates = [preferred, ...fallbackModels.filter((model) => model !== preferred)];
    let lastError: unknown;
    let fallbackNotice: string | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      if (!model) continue;
      this.assertAllowedModel(model);
      if (!retained) {
        this.assertProviderBoundary(model, parent, task.inherit_parent_context === true || task.fork === true);
      }
      try {
        const outcome =
          teammate && lane
            ? await this.runTeammateAttempt(
                task,
                teammate,
                lane,
                context,
                parent,
                tools,
                model,
                effort,
                parentHistory,
                signal,
                update,
                run,
                lease,
              )
            : await this.runTaskAttempt(
                task,
                context,
                parent,
                tools,
                model,
                effort,
                parentHistory,
                signal,
                update,
                run,
                lease,
                agentId,
                retained,
              );
        run.status = "success";
        run.finishedAt = new Date().toISOString();
        appendTimeline(run, "completed", "Run completed");
        this.publish(run);
        return {
          ...outcome,
          output: fallbackNotice ? `[Agent status: ${fallbackNotice}]\n\n${outcome.output}` : outcome.output,
          run: cloneRun(run),
        };
      } catch (error) {
        lastError = error;
        if (!isQuotaExhaustion(error) || index >= candidates.length - 1) throw error;
        const fallback = candidates[index + 1];
        if (!fallback) throw error;
        run.model = fallback;
        run.provider = providerFromSelector(fallback);
        run.fallbackReason = "quota_exhausted";
        const notice = teammate
          ? `Teammate ${teammate.id} fallback: ${model} -> ${fallback} (quota exhausted); binding is sticky until the user changes it.`
          : `Task Agent fallback: ${model} -> ${fallback} (quota exhausted).`;
        fallbackNotice = notice;
        appendTimeline(run, "fallback", `${model} -> ${fallback} (quota exhausted)`);
        if (teammate) {
          const configGate = await this.acquireConfigGate(signal);
          try {
            await this.refreshMutableProjectConfig();
            const persistent = this.requireTeammate(teammate.id);
            const previousModel = persistent.currentModel;
            const previousFallback = persistent.fallback ? structuredClone(persistent.fallback) : undefined;
            persistent.currentModel = fallback;
            persistent.fallback = { from: model, reason: "quota_exhausted", at: new Date().toISOString() };
            try {
              await saveAgentProjectConfig(this.options.cwd, this.options.trustedProject, this.config);
            } catch (saveError) {
              if (previousModel) persistent.currentModel = previousModel;
              else delete persistent.currentModel;
              if (previousFallback) persistent.fallback = previousFallback;
              else delete persistent.fallback;
              throw saveError;
            }
          } finally {
            await configGate.release();
          }
        }
        this.publish(run, notice);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Agent failed without a diagnostic");
  }

  private async runTaskAttempt(
    task: AgentTaskValue,
    context: AgentTreeContext,
    parent: ParentIdentity,
    tools: string[],
    model: string,
    effort: EffortLevel,
    parentHistory: () => string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
    run: AgentRunSnapshot,
    lease: AgentGenerationLease,
    agentId: string,
    retained: RetainedTaskAgent | undefined,
  ): Promise<RunOutcome> {
    const manager = SessionManager.create(
      this.options.cwd,
      join(this.taskDirectory, "agents", identifier(agentId, "agent"), "sessions"),
    );
    const inherited = task.inherit_parent_context || task.fork ? parentHistory() : undefined;
    run.contextChars = (task.context?.length ?? 0) + (inherited?.length ?? 0);
    const systemPrompt = retained?.systemPrompt ?? task.system_prompt ?? "";
    const instructions = retained?.instructions ?? task.instructions ?? "";
    const activeManager = retained?.manager ?? manager;
    const session =
      retained && this.options.sessionFactory && retained.session
        ? retained.session
        : await this.createSession(activeManager, model, effort, tools, systemPrompt, instructions, {
            ...context,
            lease,
          });
    if (retained?.session && session !== retained.session) retained.session.dispose();
    this.retainTaskAgent(agentId, {
      session,
      manager: activeManager,
      model,
      effort,
      tools: [...tools],
      systemPrompt,
      instructions,
    });
    const sessionFile = activeManager.getSessionFile();
    if (sessionFile) {
      await this.taskRuntime.updateResume(run.id, {
        sessionFile,
        model,
        effort,
        tools: [...tools],
        systemPrompt,
        instructions,
      });
    }
    return this.executeSession(session, taskPrompt(task, inherited), signal, update, run, parent, model);
  }

  private async runTeammateAttempt(
    task: AgentTaskValue,
    teammate: TeammateDefinition,
    lane: string,
    context: AgentTreeContext,
    parent: ParentIdentity,
    tools: string[],
    model: string,
    effort: EffortLevel,
    parentHistory: () => string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
    run: AgentRunSnapshot,
    lease: AgentGenerationLease,
  ): Promise<RunOutcome> {
    const key = `${teammate.id}:${lane}`;
    const previous = this.lanes.get(key);
    previous?.session.dispose();
    this.lanes.delete(key);
    const manager = await this.openLaneManager(teammate.id, lane);
    const inherited = task.inherit_parent_context ? parentHistory() : undefined;
    run.contextChars = (task.context?.length ?? 0) + (inherited?.length ?? 0);
    const session = await this.createSession(
      manager,
      model,
      effort,
      tools,
      teammate.systemPrompt,
      task.instructions ?? "",
      { ...context, lease },
    );
    const cached = { session, manager, model, effort };
    this.lanes.set(key, cached);
    return this.executeSession(cached.session, taskPrompt(task, inherited), signal, update, run, parent, model);
  }

  private async executeSession(
    session: AgentSession,
    prompt: string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
    run: AgentRunSnapshot,
    _parent: ParentIdentity,
    model: string,
  ): Promise<RunOutcome> {
    this.activeSessions.set(run.id, session);
    const baselineUsage = run.resumed ? sessionUsage(session.messages) : emptyUsage();
    let latest = "";
    let persistedLatest = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        latest = assistantText(event.message);
        if (latest) {
          const outputChunk = latest.startsWith(persistedLatest) ? latest.slice(persistedLatest.length) : `\n${latest}`;
          persistedLatest = latest;
          if (outputChunk) void this.taskRuntime.appendOutput(run.id, outputChunk);
          run.outputPreview = redactAuditText(latest, 4_000);
          run.lastActivityAt = new Date().toISOString();
          this.publish(run);
          update(`${run.kind} ${run.id.slice(0, 8)} · ${model}\n${run.outputPreview}`);
        }
      } else if (event.type === "tool_execution_start") {
        run.currentTool = event.toolName;
        run.lastActivityAt = new Date().toISOString();
        this.publish(run);
      } else if (event.type === "tool_execution_end") {
        delete run.currentTool;
        run.lastActivityAt = new Date().toISOString();
        this.publish(run);
      }
    });
    const abort = () => void session.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, this.config.maxRunSeconds * 1_000);
    timeout.unref();
    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "interactive" });
      if (timedOut) throw new Error(`Agent run deadline exceeded (${this.config.maxRunSeconds}s)`);
      const failure = assistantFailure(session.messages);
      if (failure) {
        const error = new Error(failure.message);
        if (failure.aborted) error.name = "AbortError";
        throw error;
      }
      let output = finalAssistantText(session.messages).trim();
      if (output.length > 0 && output.length < SUMMARY_MIN_LENGTH) {
        await session.prompt(SUMMARY_CONTINUATION_PROMPT, { expandPromptTemplates: false, source: "interactive" });
        if (timedOut) throw new Error(`Agent run deadline exceeded (${this.config.maxRunSeconds}s)`);
        const continuationFailure = assistantFailure(session.messages);
        if (continuationFailure) {
          const error = new Error(continuationFailure.message);
          if (continuationFailure.aborted) error.name = "AbortError";
          throw error;
        }
        output = finalAssistantText(session.messages).trim();
      }
      const usage = addUsage(run.usage, subtractUsage(sessionUsage(session.messages), baselineUsage));
      run.outputPreview = redactAuditText(output || "(no output)", 4_000);
      return { output: truncateOutput(output || "(no output)"), run: cloneRun(run), usage };
    } finally {
      const attemptUsage = subtractUsage(sessionUsage(session.messages), baselineUsage);
      run.usage = addUsage(run.usage, attemptUsage);
      delete run.currentTool;
      this.scheduler.recordUsage(
        run.treeId,
        attemptUsage.input + attemptUsage.output + attemptUsage.cacheRead + attemptUsage.cacheWrite,
        attemptUsage.cost,
      );
      run.budget = this.runBudget(run.treeId, run.usage);
      this.refreshTreeBudgets(run.treeId);
      this.publish(run);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      this.activeSessions.delete(run.id);
    }
  }

  private async createSession(
    manager: SessionManager,
    selector: string,
    effort: EffortLevel,
    tools: string[],
    systemPrompt: string,
    instructions: string,
    context: AgentTreeContext | undefined,
  ): Promise<AgentSession> {
    const model = await this.resolveModel(selector);
    const activeTools = platformChildToolNames(tools);
    if (this.options.sessionFactory) {
      return this.options.sessionFactory({
        manager,
        model: selector,
        effort,
        tools: activeTools,
        systemPrompt,
        instructions,
        ...(context ? { context } : {}),
      });
    }
    const settingsManager = SettingsManager.create(this.options.cwd, this.options.agentDir, {
      projectTrusted: this.options.trustedProject,
    });
    const factualBoundary = [
      process.platform === "win32"
        ? `Workspace boundary: ${resolve(this.options.cwd)}. File tools are confined to it; shell tools are unavailable to child agents on Windows.`
        : `Workspace boundary: ${resolve(this.options.cwd)}. File tools are confined to it; bash runs in a bubblewrap sandbox with a blank HOME.`,
      `Delegation pool: request child roles (${AGENT_ROLES.join(", ")}) instead of model names. The runtime maps roles within the current provider unless project configuration explicitly permits cross-provider delegation.`,
      "Persistent Teammate creation, deletion, reset, and model changes are user-authorized operations and are unavailable to child agents.",
      ...(instructions.trim() ? [instructions.trim()] : []),
    ];
    const services = await createAgentSessionServices({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      modelRuntime: this.options.modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        ...(systemPrompt.trim() ? { systemPrompt } : {}),
        appendSystemPrompt: factualBoundary,
      },
    });
    const policyTools = policyToolsForPlatform(
      createPolicyToolOverrides({
        workspace: this.options.cwd,
        executionPolicy: this.options.executionPolicy,
        workspaceBoundary: true,
        bashOperations: createWorkspaceBashOperations(this.options.cwd),
        preflight: (action) => this.assertChildAction(action),
        executionBoundary: (action, operation, signal) => this.withToolBoundary(action, operation, signal),
      }),
      { child: true },
    );
    const ownerAgentId = context?.agentId ?? "main";
    const recursive = this.createTool(tools, false, context, ownerAgentId);
    const taskTools = this.createTaskTools(ownerAgentId);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model,
      thinkingLevel: effort,
      customTools: [...policyTools, recursive, ...taskTools] as ToolDefinition[],
      tools: [...activeTools, "subagent", ...taskTools.map((tool) => tool.name)],
    });
    return result.session;
  }

  private async resolveModel(selector: string) {
    const slash = selector.indexOf("/");
    const provider = selector.slice(0, slash);
    const id = selector.slice(slash + 1);
    const model = this.options.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Agent model is unavailable: ${selector}`);
    return model;
  }

  private resolveRunSettings(task: AgentTaskValue, parent: ParentIdentity): ResolvedRunSettings {
    const teammate = task.teammate ? this.requireTeammate(task.teammate) : undefined;
    if (teammate && task.system_prompt !== undefined) {
      throw new Error("Teammate system_prompt is fixed by trusted project configuration");
    }
    const defaultTaskTools = ["read", "ls", "find", "grep"].filter((tool) => parent.tools.includes(tool));
    const tools = this.resolveTools(task.tools ?? teammate?.tools ?? defaultTaskTools, parent.tools);
    if (teammate && tools.some((tool) => !teammate.tools.includes(tool))) {
      throw new Error(`Teammate tools exceed configured ceiling: ${teammate.id}`);
    }
    const effort = task.effort ?? teammate?.effort ?? parent.effort;
    const role = task.role ?? inferAgentRole(task.task);
    const routed = this.routeModel(role, parent.model);
    const preferred = task.model ?? teammate?.currentModel ?? teammate?.preferredModel ?? routed.model;
    if (!preferred) throw new Error("No parent or explicit model is available for the agent");
    this.assertAllowedModel(preferred);
    this.assertProviderBoundary(preferred, parent, task.inherit_parent_context === true || task.fork === true);
    return {
      ...(teammate ? { teammate } : {}),
      tools,
      effort,
      role,
      preferred,
      modelReason: task.model
        ? "explicit model"
        : teammate?.currentModel || teammate?.preferredModel
          ? "Teammate model"
          : routed.reason,
    };
  }

  private routeModel(role: AgentRole, parent: ParentIdentity["model"]): { model?: string; reason: string } {
    const parentSelector = modelSelector(parent);
    if (!parent) return { ...(parentSelector ? { model: parentSelector } : {}), reason: "inherited parent model" };
    const pool = this.pools.find((candidate) => candidate.provider === parent.provider);
    const candidate = pool?.roles[role];
    const model =
      candidate &&
      (this.config.crossProviderDelegation || candidate.startsWith(`${parent.provider}/`)) &&
      this.modelAvailable(candidate)
        ? candidate
        : undefined;
    if (!model) return { ...(parentSelector ? { model: parentSelector } : {}), reason: "inherited parent model" };
    return { model, reason: `${pool?.source ?? "automatic"} ${parent.provider} pool · ${role}` };
  }

  private modelAvailable(selector: string): boolean {
    const slash = selector.indexOf("/");
    return this.options.modelRuntime.getModel(selector.slice(0, slash), selector.slice(slash + 1)) !== undefined;
  }

  private availableModelSelectors(): string[] {
    const runtime = this.options.modelRuntime as ModelRuntime & {
      getModels?: () => readonly { provider: string; id: string }[];
    };
    return (runtime.getModels?.() ?? [])
      .map((model) => `${model.provider}/${model.id}`)
      .filter((selector) => {
        try {
          this.assertAllowedModel(selector);
          return true;
        } catch {
          return false;
        }
      });
  }

  withToolBoundary<T>(action: PolicyAction, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const writes = action.kind === "file-write" || action.kind === "process" || action.kind === "network";
    return this.scheduler.withWriter(
      writes,
      async () => {
        if (action.kind !== "file-write") return operation();
        const lease = await acquireAgentExclusiveLease({
          agentDir: this.options.agentDir,
          namespace: "writer",
          identity: writerLeaseIdentity(this.options.cwd, action),
          ...(signal ? { signal } : {}),
          wait: true,
        });
        try {
          return await operation();
        } finally {
          await lease.release();
        }
      },
      signal,
    );
  }

  private assertProviderBoundary(selector: string, parent: ParentIdentity, inheritsParentContext: boolean): void {
    const parentProvider = parent.model?.provider;
    const provider = selector.slice(0, selector.indexOf("/"));
    if (!parentProvider || provider === parentProvider) return;
    if (inheritsParentContext) throw new Error("Full parent context cannot cross Provider boundaries");
    if (!this.config.crossProviderDelegation) throw new Error("Cross-provider delegation is disabled for this project");
  }

  private assertChildAction(action: PolicyAction): void {
    if (isPersistentAgentMutation(action, this.options.cwd)) {
      throw new Error("Child agents cannot change persistent Teammate configuration or lanes");
    }
  }

  private assertAllowedModel(selector: string): void {
    const allowed = this.config.allowedModels;
    if (
      allowed.length === 0 ||
      !allowed.some(
        (entry) =>
          entry === "*" || entry === selector || (entry.endsWith("/*") && selector.startsWith(entry.slice(0, -1))),
      )
    ) {
      throw new Error(`Agent model is outside allowedModels: ${selector}`);
    }
  }

  private resolveTools(requested: string[], parentTools: string[]): string[] {
    const parent = new Set(parentTools);
    const tools = [...new Set(requested)];
    for (const tool of tools) {
      if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) throw new Error(`Unsupported agent tool: ${tool}`);
      if (!parent.has(tool)) throw new Error(`Agent tool exceeds parent allowlist: ${tool}`);
    }
    return tools;
  }

  private requireTeammate(id: string): TeammateDefinition {
    const teammate = this.config.teammates.find((item) => item.id === id);
    if (!teammate) throw new Error(`Unknown teammate: ${id}`);
    return teammate;
  }

  private overrideApplies(id: string): boolean {
    return (
      this.activeTurnOverrides.has("*") ||
      this.activeTurnOverrides.has(id) ||
      this.sessionOverrides.has("*") ||
      this.sessionOverrides.has(id)
    );
  }

  private async openLaneManager(teammate: string, lane: string): Promise<SessionManager> {
    const directory = await this.ensureLaneDirectory(teammate, lane);
    const sessions = await SessionManager.list(this.options.cwd, directory);
    return sessions.length > 0
      ? SessionManager.continueRecent(this.options.cwd, directory)
      : SessionManager.create(this.options.cwd, directory);
  }

  private async newLaneManager(teammate: string, lane: string): Promise<SessionManager> {
    return SessionManager.create(this.options.cwd, await this.ensureLaneDirectory(teammate, lane));
  }

  private async ensureLaneDirectory(teammate: string, lane: string): Promise<string> {
    const projectDir = join(resolve(this.options.cwd), ".vspi");
    const agentsDir = join(projectDir, "agent-sessions");
    const teammateDir = join(agentsDir, identifier(teammate, "teammate"));
    const laneDir = join(teammateDir, identifier(lane, "lane"));
    for (const directory of [projectDir, agentsDir, teammateDir, laneDir]) {
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Teammate lane path is not a safe directory");
    }
    return laneDir;
  }

  private async withLane<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.laneTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.laneTails.set(key, tail);
    const separator = key.indexOf(":");
    const teammate = key.slice(0, separator);
    const lane = key.slice(separator + 1);
    this.laneStates.set(key, {
      lane,
      state: "waiting",
      owner: `pid ${process.pid}`,
      updatedAt: new Date().toISOString(),
    });
    let teammateGate: Awaited<ReturnType<typeof acquireAgentExclusiveLease>> | undefined;
    let laneLease: Awaited<ReturnType<typeof acquireAgentExclusiveLease>> | undefined;
    let blocked = false;
    try {
      await waitForPromise(previous, signal);
      teammateGate = await this.acquireTeammateGate(teammate, signal);
      laneLease = await acquireAgentExclusiveLease({
        agentDir: this.options.agentDir,
        namespace: "lane",
        identity: `${resolve(this.options.cwd)}:${key}`,
        ...(signal ? { signal } : {}),
        wait: false,
      });
      this.laneStates.set(key, {
        lane,
        state: "owned",
        owner: `pid ${process.pid}`,
        updatedAt: new Date().toISOString(),
      });
      await this.refreshMutableProjectConfig();
      return await operation();
    } catch (error) {
      if (error instanceof AgentLeaseConflictError) {
        blocked = true;
        this.laneStates.set(key, {
          lane,
          state: "blocked",
          owner: `${error.owner.hostname}:${error.owner.pid}`,
          updatedAt: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      await laneLease?.release();
      await teammateGate?.release();
      release();
      if (this.laneTails.get(key) === tail) this.laneTails.delete(key);
      if (!blocked) {
        this.laneStates.set(key, { lane, state: "idle", updatedAt: new Date().toISOString() });
      }
    }
  }

  private acquireTeammateGate(id: string, signal?: AbortSignal) {
    return acquireAgentExclusiveLease({
      agentDir: this.options.agentDir,
      namespace: "teammate",
      identity: `${resolve(this.options.cwd)}:${identifier(id, "teammate")}`,
      ...(signal ? { signal } : {}),
      wait: false,
    });
  }

  private acquireConfigGate(signal?: AbortSignal) {
    return acquireAgentExclusiveLease({
      agentDir: this.options.agentDir,
      namespace: "config",
      identity: resolve(this.options.cwd),
      ...(signal ? { signal } : {}),
      wait: false,
    });
  }

  private async refreshMutableProjectConfig(): Promise<void> {
    const current = await loadAgentProjectConfig(this.options.cwd, this.options.trustedProject);
    this.config.allowedModels = current.allowedModels;
    this.config.modelPools = current.modelPools;
    this.config.crossProviderDelegation = current.crossProviderDelegation;
    this.config.teammates = current.teammates;
    this.pools.splice(0, this.pools.length, ...resolveModelPools(this.options.modelRuntime, this.config));
  }

  private async closeTeammateLanes(id: string): Promise<void> {
    for (const [key, lane] of this.lanes) {
      if (!key.startsWith(`${id}:`)) continue;
      lane.session.dispose();
      this.lanes.delete(key);
    }
  }

  private runBudget(treeId: string, usage: RunOutcome["usage"]): AgentRunSnapshot["budget"] {
    const tree = this.scheduler.budget(treeId);
    const runTokensUsed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    // 预算口径只产出 UI 警戒线；runtime 不据此拒绝、排队或作废成果（C19 P0-2）。
    return {
      runTokensUsed,
      maxRunTokens: this.config.maxRunTokens,
      treeTokensUsed: tree.tokens,
      maxTreeTokens: this.config.maxTreeTokens,
      treeCostUsd: tree.costUsd,
      maxTreeCostUsd: this.config.maxTreeCostUsd,
      maxRunSeconds: this.config.maxRunSeconds,
      warnRunTokens: runTokensUsed > this.config.maxRunTokens,
      warnTreeTokens: tree.tokens > this.config.maxTreeTokens,
      warnTreeCost: tree.costUsd > this.config.maxTreeCostUsd,
      warnElapsed: false,
    };
  }

  private refreshTreeBudgets(treeId: string): void {
    const tree = this.scheduler.budget(treeId);
    for (const run of [...this.active.values(), ...this.recent]) {
      if (run.treeId !== treeId) continue;
      run.budget.treeTokensUsed = tree.tokens;
      run.budget.treeCostUsd = tree.costUsd;
      void this.taskRuntime.updateRun(run.id, run);
    }
  }

  private validateResumeTask(task: AgentTaskValue): void {
    const agentId = task.resume?.trim();
    if (!agentId) return;
    const spawnOnly = [
      ["role", task.role],
      ["context", task.context],
      ["instructions", task.instructions],
      ["system_prompt", task.system_prompt],
      ["effort", task.effort],
      ["tools", task.tools],
      ["inherit_parent_context", task.inherit_parent_context],
      ["model", task.model],
      ["fallback_models", task.fallback_models],
      ["teammate", task.teammate],
      ["lane", task.lane],
    ].filter(([, value]) => value !== undefined);
    if (spawnOnly.length > 0) {
      throw new Error(`Cannot change ${spawnOnly.map(([name]) => name).join(", ")} when resuming an agent`);
    }
    if (this.active.size > 0 && [...this.active.values()].some((run) => run.agentId === agentId)) {
      throw new Error(`Agent ${agentId} is already running`);
    }
    if (!this.retainedTaskAgents.has(agentId)) {
      throw new Error(
        `Agent ${agentId} is not available to resume; only active or recent agents in this process can resume`,
      );
    }
  }

  private validateForkTask(task: AgentTaskValue): void {
    if (task.fork !== true) return;
    const incompatible = [
      ["resume", task.resume],
      ["model", task.model],
      ["fallback_models", task.fallback_models],
      ["role", task.role],
      ["teammate", task.teammate],
      ["lane", task.lane],
      ["inherit_parent_context", task.inherit_parent_context],
    ].filter(([, value]) => value !== undefined);
    if (incompatible.length > 0) {
      throw new Error(`Cannot combine fork with ${incompatible.map(([name]) => name).join(", ")}`);
    }
  }

  private requireRetainedAgent(agentId: string): RetainedTaskAgent {
    const retained = this.retainedTaskAgents.get(agentId);
    if (!retained) {
      throw new Error(`Agent ${agentId} is not available to resume in this Session`);
    }
    this.retainedTaskAgents.delete(agentId);
    this.retainedTaskAgents.set(agentId, retained);
    return retained;
  }

  private retainTaskAgent(agentId: string, retained: RetainedTaskAgent): void {
    const previous = this.retainedTaskAgents.get(agentId);
    if (previous?.session && previous.session !== retained.session) previous.session.dispose();
    this.retainedTaskAgents.delete(agentId);
    this.retainedTaskAgents.set(agentId, retained);
    while (this.retainedTaskAgents.size > RETAINED_TASK_AGENT_LIMIT) {
      const oldest = this.retainedTaskAgents.entries().next().value as [string, RetainedTaskAgent] | undefined;
      if (!oldest) break;
      this.retainedTaskAgents.delete(oldest[0]);
      oldest[1].session?.dispose();
    }
  }

  private restoreRetainedAgents(): void {
    const root = `${resolve(this.taskDirectory)}${process.platform === "win32" ? "\\" : "/"}`;
    for (const record of this.taskRuntime.all()) {
      const resume = record.resume;
      if (!resume || this.retainedTaskAgents.has(record.agentId)) continue;
      const sessionFile = resolve(resume.sessionFile);
      if (!sessionFile.startsWith(root)) continue;
      try {
        this.retainTaskAgent(record.agentId, {
          manager: SessionManager.open(sessionFile),
          model: resume.model,
          effort: resume.effort,
          tools: [...resume.tools],
          systemPrompt: resume.systemPrompt,
          instructions: resume.instructions,
        });
      } catch {
        // A broken child transcript remains visible as task history but cannot resume.
      }
    }
  }

  private async deliverTaskNotification(record: AgentTaskRecord, output: string): Promise<void> {
    if (!this.options.onCompletion || !record.run) return;
    const run = taskRecordRun(record);
    const completion: AgentCompletionEvent = {
      taskId: record.taskId,
      agentId: record.agentId,
      status: record.status === "completed" ? "success" : record.status === "killed" ? "cancelled" : "error",
      background: true,
      ...(record.status === "completed" ? { result: run.summary ?? output } : {}),
      ...(record.status !== "completed" ? { error: record.stopReason ?? run.error ?? record.status } : {}),
      run: cloneRun(run),
    };
    await this.options.onCompletion(completion);
  }

  private publish(run: AgentRunSnapshot, fallbackNotice?: string): void {
    if (run.status === "queued" || run.status === "running") this.active.set(run.id, cloneRun(run));
    else {
      this.active.delete(run.id);
      const existing = this.recent.findIndex((item) => item.id === run.id);
      if (existing >= 0) this.recent.splice(existing, 1);
      this.recent.unshift(cloneRun(run));
      this.recent.splice(64);
    }
    void this.taskRuntime.updateRun(run.id, run);
    this.options.onStatus?.({ run: cloneRun(run), ...(fallbackNotice ? { fallbackNotice } : {}) });
  }

  private restoreTaskProjection(): void {
    const records = this.taskRuntime.all().filter((record) => record.run !== undefined);
    this.active.clear();
    this.recent.length = 0;
    for (const record of records) {
      const run = taskRecordRun(record);
      if (record.status === "running") this.active.set(run.id, run);
      else if (this.recent.length < 64) this.recent.push(run);
    }
  }
}

function taskRecordRun(record: AgentTaskRecord): AgentRunSnapshot {
  const run = cloneRun(record.run as AgentRunSnapshot);
  if (record.status === "completed") run.status = "success";
  else if (record.status === "failed") run.status = "error";
  else if (record.status === "killed") run.status = "killed";
  else if (record.status === "timed_out") run.status = "timed_out";
  else if (record.status === "lost") run.status = "lost";
  if (record.stopReason && record.status !== "completed") run.error = record.stopReason;
  return run;
}

function taskPrompt(task: AgentTaskValue, inherited?: string): string {
  return [
    ...(task.fork
      ? [
          "The conversation snapshot below belongs to the caller and is reference material only. You are an independent child; perform the new task directly and report the result.",
        ]
      : []),
    `Task:\n${task.task}`,
    ...(task.context?.trim() ? [`Explicit context:\n${task.context.trim()}`] : []),
    ...(inherited ? [`Explicitly inherited parent context:\n${inherited}`] : []),
  ].join("\n\n");
}

function serializeParentContext(
  entries: ReturnType<Parameters<typeof buildSessionContext>[0]["slice"]>,
  leaf: string | null,
): string {
  return JSON.stringify(buildSessionContext(entries, leaf).messages, inheritedContextReplacer).slice(0, 1_000_000);
}

function inheritedContextReplacer(key: string, value: unknown): unknown {
  if (/^(?:api[_-]?key|token|secret|password|authorization|cookie|credential)$/i.test(key)) return "[redacted]";
  if (key === "data" && typeof value === "string") return "[binary content redacted]";
  if (typeof value !== "string") return value;
  return redactSensitiveString(value);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|cookie|credential)(\s*[=:]\s*)["']?[^\s,;"']+/gi,
      "$1$2[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, "[large encoded content redacted]");
}

function redactAuditText(value: string, max: number): string {
  return compactText(redactSensitiveString(value), max);
}

function providerFromSelector(selector: string): string {
  return selector.slice(0, selector.indexOf("/"));
}

function emptyUsage(): RunOutcome["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(left: RunOutcome["usage"], right: RunOutcome["usage"]): RunOutcome["usage"] {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
    turns: left.turns + right.turns,
  };
}

function subtractUsage(total: RunOutcome["usage"], baseline: RunOutcome["usage"]): RunOutcome["usage"] {
  return {
    input: Math.max(0, total.input - baseline.input),
    output: Math.max(0, total.output - baseline.output),
    cacheRead: Math.max(0, total.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, total.cost - baseline.cost),
    turns: Math.max(0, total.turns - baseline.turns),
  };
}

function appendTimeline(
  run: AgentRunSnapshot,
  kind: AgentRunSnapshot["timeline"][number]["kind"],
  summary: string,
): void {
  run.timeline.push({ at: new Date().toISOString(), kind, summary: redactAuditText(summary, 240) });
  if (run.timeline.length > 32) run.timeline.splice(0, run.timeline.length - 32);
}

function isBudgetError(error: unknown): boolean {
  return /\b(?:budget|deadline)\b/i.test(error instanceof Error ? error.message : String(error));
}

function modelSelector(model: ParentIdentity["model"]): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function resolveModelPools(runtime: ModelRuntime, config: AgentProjectConfig): ResolvedAgentModelPool[] {
  const getModels = (runtime as ModelRuntime & { getModels?: () => ReturnType<ModelRuntime["getModels"]> }).getModels;
  const models = typeof getModels === "function" ? getModels.call(runtime) : [];
  const providers = new Map<string, string[]>();
  for (const model of models) providers.set(model.provider, [...(providers.get(model.provider) ?? []), model.id]);
  return [...providers].map(([provider, ids]) => {
    const configured = config.modelPools[provider]?.roles ?? {};
    const automatic = automaticRoleModels(provider, ids);
    const fallback = ids[0] ? `${provider}/${ids[0]}` : "";
    const roleModel = (role: AgentRole) => configured[role] ?? automatic[role] ?? fallback;
    return {
      provider,
      source: Object.keys(configured).length > 0 ? "project" : "automatic",
      roles: {
        orchestrator: roleModel("orchestrator"),
        researcher: roleModel("researcher"),
        analyst: roleModel("analyst"),
        worker: roleModel("worker"),
      },
    };
  });
}

function automaticRoleModels(provider: string, ids: string[]): Partial<Record<AgentRole, string>> {
  const selector = (patterns: RegExp[]) => {
    const id = ids.find((candidate) => patterns.some((pattern) => pattern.test(candidate.toLocaleLowerCase())));
    return id ? `${provider}/${id}` : undefined;
  };
  const strong = selector([/(?:^|[-_.])(?:sol|pro|k3)(?:$|[-_.])/u, /reasoner/u]);
  const researcher = selector([/luna/u, /long/u]) ?? strong;
  const analyst = selector([/terra/u]) ?? strong;
  const worker = selector([/flash/u, /lite/u, /k2[._-]?6/u]) ?? analyst ?? strong;
  return {
    ...(strong ? { orchestrator: strong } : {}),
    ...(researcher ? { researcher } : {}),
    ...(analyst ? { analyst } : {}),
    ...(worker ? { worker } : {}),
  };
}

function inferAgentRole(task: string): AgentRole {
  if (/(?:研究|调研|文献|长上下文|证据抽取|research|survey|literature|long context)/iu.test(task)) return "researcher";
  if (/(?:审计|核对|验证|反例|分析|audit|verify|critic|analy[sz]e)/iu.test(task)) return "analyst";
  if (/(?:综合|汇总|协调|规划|synthesi[sz]e|orchestrat|coordinate)/iu.test(task)) return "orchestrator";
  return "worker";
}

function normalizeEffort(value: unknown): EffortLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
    ? (value as EffortLevel)
    : "medium";
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantText(messages[index]);
    if (text) return text;
  }
  return "";
}

function assistantFailure(messages: readonly unknown[]): { message: string; aborted: boolean } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length") return;
    const detail = typeof message.errorMessage === "string" ? message.errorMessage : assistantText(message);
    return {
      message:
        message.stopReason === "length"
          ? "Subagent turn failed before completing its final summary: reason=max_tokens"
          : detail || `Agent stopped: ${message.stopReason}`,
      aborted: message.stopReason === "aborted",
    };
  }
  return;
}

function sessionUsage(messages: readonly unknown[]): RunOutcome["usage"] {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
    usage.turns += 1;
    usage.input += numberValue(message.usage.input);
    usage.output += numberValue(message.usage.output);
    usage.cacheRead += numberValue(message.usage.cacheRead);
    usage.cacheWrite += numberValue(message.usage.cacheWrite);
    if (isRecord(message.usage.cost)) usage.cost += numberValue(message.usage.cost.total);
  }
  return usage;
}

function isQuotaExhaustion(error: unknown): boolean {
  const text = safeError(error).toLocaleLowerCase();
  return [
    /insufficient[_ -]?quota/,
    /quota (?:is )?(?:exceeded|exhausted)/,
    /(?:credit|balance)s? (?:are )?(?:exhausted|depleted)/,
    /billing (?:hard )?limit/,
    /usage limit (?:has been )?reached/,
  ].some((pattern) => pattern.test(text));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncateOutput(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= 50 * 1024) return value;
  let output = value.slice(0, 50 * 1024);
  while (Buffer.byteLength(output, "utf8") > 50 * 1024) output = output.slice(0, -1);
  return `${output}\n\n[Output truncated; ${bytes - Buffer.byteLength(output, "utf8")} bytes omitted.]`;
}

function compactText(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

function cloneRun(run: AgentRunSnapshot): AgentRunSnapshot {
  return structuredClone(run);
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeError(error: unknown): string {
  return redactSensitiveString(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function waitForPromise(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw agentAbortError("Teammate lane wait was cancelled");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectPromise(agentAbortError("Teammate lane wait was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolvePromise();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

function agentAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPersistentAgentMutation(action: PolicyAction, cwd: string): boolean {
  if (action.kind !== "file-write" && action.kind !== "process") return false;
  const target = action.target ?? "";
  const configPath = join(resolve(cwd), ".vspi", "agents.json");
  const sessionsPath = join(resolve(cwd), ".vspi", "agent-sessions");
  return (
    target === configPath ||
    target === sessionsPath ||
    target.startsWith(`${sessionsPath}/`) ||
    /(?:^|[\\/])\.vspi[\\/](?:agents\.json|agent-sessions)(?:$|[\\/\s'"])/u.test(target)
  );
}

function writerLeaseIdentity(cwd: string, action: PolicyAction): string {
  const workspace = resolve(cwd);
  if (action.kind === "file-write" && action.target) {
    return `${workspace}\0file\0${resolve(workspace, action.target)}`;
  }
  throw new Error("File writer lease target is missing");
}
