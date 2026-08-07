import { randomUUID } from "node:crypto";
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
import { createPolicyToolOverrides } from "../policy/pi-policy-tools.js";
import { AGENT_TOOL_NAMES, loadAgentProjectConfig, saveAgentProjectConfig } from "./config.js";
import { type AgentGenerationLease, type AgentTreeContext, AgentTreeScheduler } from "./scheduler.js";
import type {
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

export interface PiAgentManagerOptions {
  cwd: string;
  agentDir: string;
  trustedProject: boolean;
  recovery: boolean;
  modelRuntime: ModelRuntime;
  executionPolicy: ExecutionPolicyService;
  onStatus?: (event: AgentStatusEvent) => void;
  sessionFactory?: (input: {
    manager: SessionManager;
    model: string;
    effort: EffortLevel;
    tools: string[];
    systemPrompt: string;
    instructions: string;
    context?: AgentTreeContext;
  }) => Promise<AgentSession>;
}

export class PiAgentManager {
  private config: AgentProjectConfig;
  private readonly scheduler: AgentTreeScheduler;
  private readonly active = new Map<string, AgentRunSnapshot>();
  private readonly recent: AgentRunSnapshot[] = [];
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly lanes = new Map<string, CachedLane>();
  private readonly laneTails = new Map<string, Promise<void>>();
  private readonly pools: ResolvedAgentModelPool[];
  private rootContext: AgentTreeContext | undefined;
  private pendingRequired = new Set<string>();
  private explicitAgentRequired = false;
  private agentConfigMutationAuthorized = false;
  private requiredOverride = false;
  private diagnostic: string | undefined;
  private disposed = false;

  private constructor(
    private readonly options: PiAgentManagerOptions,
    config: AgentProjectConfig,
    diagnostic?: string,
  ) {
    this.config = config;
    this.scheduler = new AgentTreeScheduler(config.maxConcurrency);
    this.pools = resolveModelPools(options.modelRuntime, config);
    this.diagnostic = diagnostic;
  }

  static async create(options: PiAgentManagerOptions): Promise<PiAgentManager> {
    if (options.recovery) {
      return new PiAgentManager(
        options,
        {
          version: 1,
          maxConcurrency: 16,
          allowedModels: [],
          modelPools: {},
          crossProviderDelegation: false,
          teammates: [],
        },
        "Recovery mode disables delegated agents",
      );
    }
    try {
      return new PiAgentManager(options, await loadAgentProjectConfig(options.cwd, options.trustedProject));
    } catch (error) {
      return new PiAgentManager(
        options,
        {
          version: 1,
          maxConcurrency: 16,
          allowedModels: [],
          modelPools: {},
          crossProviderDelegation: false,
          teammates: [],
        },
        `Agent configuration rejected: ${safeError(error)}`,
      );
    }
  }

  createTool(parentTools: string[], allowTeammates: boolean, inherited?: AgentTreeContext): ToolDefinition {
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
    const teammateCallsEnabled = allowTeammates && this.config.teammates.length > 0;
    const parameters = allowTeammates
      ? teammateCallsEnabled
        ? teammateParameters
        : taskParameters
      : BaseTaskAgentParameters;
    return {
      name: "subagent",
      label: "Subagent",
      description: [
        "Run one isolated Task Agent or a configured project Teammate and return its result.",
        "Task Agents receive only task/context fields unless inherit_parent_context is true.",
        "Model and effort inherit from the caller when omitted; fallback_models are used only for positively identified quota exhaustion.",
        teammateCallsEnabled
          ? `Configured teammates: ${teammateSummary}. A teammate call requires teammate and may set lane.`
          : allowTeammates
            ? "No project Teammates are configured; omit teammate and lane."
            : "Choose role instead of a concrete model; the child inherits its provider's configured model pool.",
        "Run parallel tasks by issuing multiple subagent tool calls in one response.",
        `Limits: depth ${this.scheduler.maxDepth}, ${this.scheduler.maxAgentsPerTree} agents per tree, ${this.config.maxConcurrency} concurrent generations.`,
      ].join(" "),
      promptSnippet:
        "Delegated agents are available with isolated context, explicit model/effort/tool selection, and project Teammate lanes where configured.",
      parameters,
      executionMode: "parallel",
      execute: async (_toolCallId, raw, signal, onUpdate, ctx) => {
        if (this.diagnostic) throw new Error(this.diagnostic);
        if (this.disposed) throw new Error("Agent manager is disposed");
        const task = raw as AgentTaskValue;
        if (!allowTeammates && task.teammate) {
          throw new Error("Child agents cannot invoke persistent Teammates");
        }
        const root = inherited ?? this.rootContext ?? this.scheduler.root();
        const ownsTree = inherited === undefined && this.rootContext === undefined;
        const parent: ParentIdentity = {
          ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
          effort: normalizeEffort(ctx.thinkingLevel),
          tools: parentTools,
        };
        const parentContext = () =>
          serializeParentContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        try {
          const outcomes = [
            await this.run(task, root, parent, parentContext, signal, (message) => {
              onUpdate?.({ content: [{ type: "text", text: message }], details: { status: "running" } });
            }),
          ];
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
        } finally {
          if (ownsTree) this.scheduler.finishTree(root.treeId);
        }
      },
    } as ToolDefinition<typeof parameters>;
  }

  beginRootTask(text: string, merge = false): void {
    const normalized = text.toLocaleLowerCase();
    const matchedRequired = new Set(
      this.config.teammates
        .filter(
          (item) =>
            item.routing === "required" &&
            item.match.length > 0 &&
            item.match.some((match) => normalized.includes(match.toLocaleLowerCase())),
        )
        .map((item) => item.id),
    );
    const mentionsAgent = /\bsub[ -]?agent\b|子代理|子智能体|派(?:生|一个)?.{0,8}agent/iu.test(text);
    const rejectsAgent =
      /(?:不用|不要|禁止|别用|do not|don't|without).{0,20}(?:sub[ -]?agent|子代理|子智能体|agent)/iu.test(text);
    const explicitlyRequired = mentionsAgent && !rejectsAgent;
    const requiredOverride =
      /(?:override|ignore|bypass|接管|覆盖|绕过).{0,30}(?:teammate|队友|路由|routing|required)/iu.test(text) ||
      /(?:主模型|main agent).{0,30}(?:接管|take over|override)/iu.test(text);
    const mutationAuthorized =
      /(?:create|add|delete|remove|switch|change|reset|创建|添加|删除|切换|更换|重置).{0,40}(?:teammate|sub[ -]?agent|agent|队友|子代理)/iu.test(
        text,
      ) ||
      /(?:teammate|sub[ -]?agent|agent|队友|子代理).{0,40}(?:create|add|delete|remove|switch|change|reset|创建|添加|删除|切换|更换|重置)/iu.test(
        text,
      );
    if (!merge) {
      if (this.rootContext) this.scheduler.finishTree(this.rootContext.treeId);
      this.rootContext = this.scheduler.root();
      this.pendingRequired = matchedRequired;
      this.explicitAgentRequired = explicitlyRequired;
      this.requiredOverride = requiredOverride;
      this.agentConfigMutationAuthorized = mutationAuthorized;
    } else {
      for (const id of matchedRequired) this.pendingRequired.add(id);
      this.explicitAgentRequired ||= explicitlyRequired;
      this.requiredOverride ||= requiredOverride;
      this.agentConfigMutationAuthorized ||= mutationAuthorized;
    }
    if (requiredOverride) this.pendingRequired.clear();
  }

  capabilityContext(): string | undefined {
    if (this.config.teammates.length === 0 && this.pendingRequired.size === 0 && !this.explicitAgentRequired) return;
    const lines = this.config.teammates.map((item) => {
      const current = item.currentModel ?? item.preferredModel ?? "inherit";
      const fallback = item.fallback ? `; sticky fallback from ${item.fallback.from}: ${item.fallback.reason}` : "";
      return `- ${item.id}: role=${item.role}; routing=${item.routing}; model=${current}; effort=${item.effort ?? "inherit"}${fallback}`;
    });
    return [
      "<vspi_agent_capabilities>",
      "Available capability: isolated Task Agents and the project Teammates listed below. This is capability and policy state, not a workflow prescription.",
      ...lines,
      ...(this.pendingRequired.size > 0
        ? [`User policy for this turn requires teammate routing: ${[...this.pendingRequired].join(", ")}.`]
        : []),
      ...(this.explicitAgentRequired ? ["The user explicitly required subagent use for this turn."] : []),
      ...(this.requiredOverride ? ["The user explicitly overrode required Teammate routing for this turn."] : []),
      "</vspi_agent_capabilities>",
    ].join("\n");
  }

  assertMainAction(action: PolicyAction): void {
    if (isPersistentAgentMutation(action, this.options.cwd) && !this.agentConfigMutationAuthorized) {
      throw new Error("Persistent Teammate changes require an explicit user request");
    }
    const mutating = action.kind === "file-write" || (action.kind === "process" && action.operation !== "read");
    if (!mutating) return;
    if (this.pendingRequired.size > 0) {
      throw new Error(`Required teammate has not completed: ${[...this.pendingRequired].join(", ")}`);
    }
    if (this.explicitAgentRequired)
      throw new Error("The user explicitly required a subagent before main-agent mutation");
  }

  assertRootTaskComplete(): void {
    if (this.pendingRequired.size > 0) {
      throw new Error(`Required teammate has not completed: ${[...this.pendingRequired].join(", ")}`);
    }
    if (this.explicitAgentRequired) {
      throw new Error("The user explicitly required a subagent, but no subagent completed this turn");
    }
    if (this.rootContext) this.scheduler.finishTree(this.rootContext.treeId);
    this.rootContext = undefined;
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
      },
      pools: structuredClone(this.pools),
      active: [...this.active.values()].map(cloneRun),
      recent: this.recent.map(cloneRun),
      teammates: this.config.teammates.map((item) => ({
        ...structuredClone(item),
        activeLanes: [...this.lanes.keys()]
          .filter((key) => key.startsWith(`${item.id}:`))
          .map((key) => key.slice(item.id.length + 1)),
        stickyFallback: item.fallback !== undefined,
      })),
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }

  async switchTeammateModel(id: string, model: string): Promise<void> {
    const teammate = this.requireTeammate(id);
    this.assertAllowedModel(model);
    await this.resolveModel(model);
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
  }

  async resetTeammateLane(id: string, lane = "default"): Promise<void> {
    const teammate = this.requireTeammate(id);
    const safeLane = identifier(lane, "lane");
    const key = `${id}:${safeLane}`;
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
  }

  async setModelPoolRole(provider: string, role: AgentRole, model: string): Promise<void> {
    if (!this.options.trustedProject) throw new Error("Project trust is required to change Agent Pools");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider) || !AGENT_ROLES.includes(role)) {
      throw new Error("Agent Pool provider or role is invalid");
    }
    await this.resolveModel(model);
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
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.activeSessions.values()].map((session) => session.abort().catch(() => undefined)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancelAll();
    for (const lane of this.lanes.values()) lane.session.dispose();
    this.lanes.clear();
  }

  private async run(
    task: AgentTaskValue,
    parentContext: AgentTreeContext,
    parent: ParentIdentity,
    parentHistory: () => string,
    signal: AbortSignal | undefined,
    update: (message: string) => void,
  ): Promise<RunOutcome> {
    const runId = randomUUID();
    const fingerprint = compactText(task.task, 2_000).toLocaleLowerCase();
    if (/^(?:no[ -]?op|noop|unused|test|测试)[.!。\s]*$/iu.test(fingerprint)) {
      throw new Error("Subagent task must request substantive work");
    }
    const context = this.scheduler.child(parentContext, runId, fingerprint);
    const teammate = task.teammate ? this.requireTeammate(task.teammate) : undefined;
    const lane = teammate ? identifier(task.lane ?? "default", "lane") : undefined;
    const defaultTaskTools = ["read", "ls", "find", "grep"].filter((tool) => parent.tools.includes(tool));
    const tools = this.resolveTools(task.tools ?? teammate?.tools ?? defaultTaskTools, parent.tools);
    const effort = task.effort ?? teammate?.effort ?? parent.effort;
    const role = task.role ?? inferAgentRole(task.task);
    const routed = this.routeModel(role, parent.model);
    const preferred = task.model ?? teammate?.currentModel ?? teammate?.preferredModel ?? routed.model;
    if (!preferred) throw new Error("No parent or explicit model is available for the agent");
    this.assertAllowedModel(preferred);
    const run: AgentRunSnapshot = {
      id: runId,
      treeId: context.treeId,
      ...(context.parentRunId ? { parentId: context.parentRunId } : {}),
      kind: teammate ? "teammate" : "task",
      ...(teammate ? { teammateId: teammate.id } : {}),
      ...(lane ? { lane } : {}),
      depth: context.depth,
      model: preferred,
      role,
      modelReason: task.model
        ? "explicit model"
        : teammate?.currentModel || teammate?.preferredModel
          ? "Teammate model"
          : routed.reason,
      ...(teammate?.preferredModel ? { preferredModel: teammate.preferredModel } : {}),
      effort,
      contextMode: teammate ? "lane" : task.inherit_parent_context ? "inherited" : "isolated",
      task: compactText(task.task, 500),
      tools,
      status: "queued",
    };
    this.publish(run);
    const lease = this.scheduler.createLease();
    context.lease = lease;
    parentContext.lease?.suspend();
    try {
      await lease.acquire(signal);
      run.status = "running";
      run.startedAt = new Date().toISOString();
      this.publish(run);
      const operation = () =>
        this.runWithFallback(
          task,
          teammate,
          lane,
          context,
          parent,
          tools,
          preferred,
          effort,
          parentHistory,
          signal,
          update,
          run,
          lease,
        );
      return teammate && lane ? await this.withLane(`${teammate.id}:${lane}`, operation) : await operation();
    } catch (error) {
      run.status = error instanceof Error && error.name === "AbortError" ? "cancelled" : "error";
      run.finishedAt = new Date().toISOString();
      this.publish(run);
      throw error;
    } finally {
      lease.release();
      await parentContext.lease?.resume();
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
  ): Promise<RunOutcome> {
    const fallbackModels = task.fallback_models ?? teammate?.fallbackModels ?? [];
    const candidates = [preferred, ...fallbackModels.filter((model) => model !== preferred)];
    let lastError: unknown;
    let fallbackNotice: string | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      if (!model) continue;
      this.assertAllowedModel(model);
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
              );
        run.status = "success";
        run.finishedAt = new Date().toISOString();
        this.pendingRequired.delete(teammate?.id ?? "");
        this.explicitAgentRequired = false;
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
        run.fallbackReason = "quota_exhausted";
        const notice = teammate
          ? `Teammate ${teammate.id} fallback: ${model} -> ${fallback} (quota exhausted); binding is sticky until the user changes it.`
          : `Task Agent fallback: ${model} -> ${fallback} (quota exhausted).`;
        fallbackNotice = notice;
        if (teammate) {
          const previousModel = teammate.currentModel;
          const previousFallback = teammate.fallback ? structuredClone(teammate.fallback) : undefined;
          teammate.currentModel = fallback;
          teammate.fallback = { from: model, reason: "quota_exhausted", at: new Date().toISOString() };
          try {
            await saveAgentProjectConfig(this.options.cwd, this.options.trustedProject, this.config);
          } catch (saveError) {
            if (previousModel) teammate.currentModel = previousModel;
            else delete teammate.currentModel;
            if (previousFallback) teammate.fallback = previousFallback;
            else delete teammate.fallback;
            throw saveError;
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
  ): Promise<RunOutcome> {
    const directory = join(this.options.agentDir, "vspi-agent-runs", context.treeId, run.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(this.options.cwd, directory);
    const sessionFile = manager.getSessionFile();
    if (sessionFile) run.sessionFile = sessionFile;
    this.publish(run);
    const session = await this.createSession(
      manager,
      model,
      effort,
      tools,
      task.system_prompt ?? "",
      task.instructions ?? "",
      { ...context, lease },
    );
    return this.executeSession(
      session,
      taskPrompt(task, task.inherit_parent_context ? parentHistory() : undefined),
      signal,
      update,
      run,
      parent,
      model,
    );
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
    const manager = previous?.manager ?? (await this.openLaneManager(teammate.id, lane));
    const session = await this.createSession(
      manager,
      model,
      effort,
      tools,
      task.system_prompt ?? teammate.systemPrompt,
      task.instructions ?? "",
      { ...context, lease },
    );
    const cached = { session, manager, model, effort };
    this.lanes.set(key, cached);
    return this.executeSession(
      cached.session,
      taskPrompt(task, task.inherit_parent_context ? parentHistory() : undefined),
      signal,
      update,
      run,
      parent,
      model,
    );
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
    let latest = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        latest = assistantText(event.message);
        if (latest) {
          run.outputPreview = compactText(latest, 4_000);
          this.publish(run);
          update(`${run.kind} ${run.id.slice(0, 8)} · ${model}\n${run.outputPreview}`);
        }
      }
    });
    const abort = () => void session.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false, source: "interactive" });
      const failure = assistantFailure(session.messages);
      if (failure) {
        const error = new Error(failure.message);
        if (failure.aborted) error.name = "AbortError";
        throw error;
      }
      const output = finalAssistantText(session.messages);
      run.outputPreview = compactText(output || "(no output)", 4_000);
      const usage = sessionUsage(session.messages);
      return { output: truncateOutput(output || "(no output)"), run: cloneRun(run), usage };
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      this.activeSessions.delete(run.id);
      if (run.kind === "task") session.dispose();
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
    if (this.options.sessionFactory) {
      return this.options.sessionFactory({
        manager,
        model: selector,
        effort,
        tools: [...tools],
        systemPrompt,
        instructions,
        ...(context ? { context } : {}),
      });
    }
    const settingsManager = SettingsManager.create(this.options.cwd, this.options.agentDir, {
      projectTrusted: this.options.trustedProject,
    });
    const factualBoundary = [
      `Workspace boundary: ${resolve(this.options.cwd)}. File tools are confined to it; bash runs in a bubblewrap sandbox with a blank HOME.`,
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
    const policyTools = Object.values(
      createPolicyToolOverrides({
        workspace: this.options.cwd,
        executionPolicy: this.options.executionPolicy,
        workspaceBoundary: true,
        bashOperations: createWorkspaceBashOperations(this.options.cwd),
        preflight: (action) => this.assertChildAction(action),
        executionBoundary: (action, operation) => this.withToolBoundary(action, operation),
      }),
    );
    const recursive = this.createTool(tools, false, context);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model,
      thinkingLevel: effort,
      customTools: [...policyTools, recursive] as ToolDefinition[],
      tools: [...tools, "subagent"],
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

  withToolBoundary<T>(action: PolicyAction, operation: () => Promise<T>): Promise<T> {
    const writes =
      action.kind === "file-write" ||
      (action.kind === "process" && action.operation !== "read") ||
      action.kind === "network";
    return this.scheduler.withWriter(writes, operation);
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

  private async withLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.laneTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.laneTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.laneTails.get(key) === tail) this.laneTails.delete(key);
    }
  }

  private async closeTeammateLanes(id: string): Promise<void> {
    for (const [key, lane] of this.lanes) {
      if (!key.startsWith(`${id}:`)) continue;
      lane.session.dispose();
      this.lanes.delete(key);
    }
  }

  private publish(run: AgentRunSnapshot, fallbackNotice?: string): void {
    if (run.status === "queued" || run.status === "running") this.active.set(run.id, cloneRun(run));
    else {
      this.active.delete(run.id);
      this.recent.unshift(cloneRun(run));
      this.recent.splice(64);
    }
    this.options.onStatus?.({ run: cloneRun(run), ...(fallbackNotice ? { fallbackNotice } : {}) });
  }
}

function taskPrompt(task: AgentTaskValue, inherited?: string): string {
  return [
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
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|cookie|credential)(\s*[=:]\s*)["']?[^\s,;"']+/gi,
      "$1$2[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, "[large encoded content redacted]");
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
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return;
    const detail = typeof message.errorMessage === "string" ? message.errorMessage : assistantText(message);
    return { message: detail || `Agent stopped: ${message.stopReason}`, aborted: message.stopReason === "aborted" };
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
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:token|secret|api[_-]?key)\s*[=:]\s*[^\s;,]+/gi, "$1=[redacted]")
    .slice(0, 1_000);
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
