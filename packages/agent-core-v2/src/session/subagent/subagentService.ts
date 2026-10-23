import { Service } from '#/_base/di/service';
import { collection, type CollectionView } from '#/_base/di/collection';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService, permissionModeForChild } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { ILogService } from '#/_base/log/log';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';
import { runAgentTurn } from './runAgentTurn';
import {
  resolveSubagentBinding,
  resolveSubagentThinking,
  wrapSubagentModelError,
} from './configSection';
import {
  DEFAULT_PROFILE_NAME,
  FORK_CONTEXT_NOTICE,
  type SpawnSubagentOptions,
  type SpawnedSubagent,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from './spawn';
import { selectSubagentIdentity } from './codename';
import { SECONDARY_MODEL_SECTION, type SecondaryModelConfig } from './configSection';

export interface SubagentBindingResolution {
  readonly model: string;
  readonly notice?: string;
}

export interface SubagentDefaultBindingContribution {
  resolveModel(profileName: string, requestedModel?: string): string | SubagentBindingResolution | undefined | Promise<string | SubagentBindingResolution | undefined>;
}

export const SubagentDefaultBindingContribution = collection<SubagentDefaultBindingContribution>(
  'subagent-default-binding',
  { validate: (_value, existing) => {
    if (existing.length > 0) throw new Error('Only one subagent default binding provider may be registered');
  } },
);

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private readonly reservedCodenames = new Set<string>();

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @SubagentDefaultBindingContribution private readonly defaults: CollectionView<SubagentDefaultBindingContribution>,
  ) {
    super();
  }

  run(agent: AgentContext, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.agentLifecycle.handleOf(agent.agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agent.agentId}" does not exist`, {
        details: { agentId: agent.agentId },
      });
    }
    return runAgentTurn(handle, request, { signal: opts.signal, onReady: opts.onReady });
  }

  async planSpawn(input: SubagentSpawnPlanInput): Promise<SubagentSpawnPlan> {
    const caller = this.requireCaller(input.callerAgentId);
    const fork = input.fork === true;
    await this.catalog.ready;
    const own = caller.accessor.get(IAgentProfileService).data();
    const requested = input.profileName !== undefined && input.profileName.length > 0
      ? input.profileName
      : undefined;
    const requestedProfileName =
      requested ?? (fork ? (own.profileName ?? DEFAULT_PROFILE_NAME) : DEFAULT_PROFILE_NAME);
    let allowlist = subagentAllowlistFor(this.catalog, own);
    if (allowlist !== undefined && own.subagents === undefined) {
      allowlist = withoutDelegatingTargets(this.catalog, allowlist);
    }
    if (!fork && allowlist !== undefined && !allowlist.includes(requestedProfileName)) {
      throw new Error2(
        ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
        subagentTypeNotAllowedMessage(requestedProfileName, allowlist),
        { details: { profileName: requestedProfileName, allowlist } },
      );
    }
    const profile = this.catalog.get(requestedProfileName);
    if (!fork && profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${requestedProfileName}"`, {
        details: { profileName: requestedProfileName },
      });
    }
    if (own.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: input.callerAgentId },
      });
    }
    const forced = this.configService.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.force === true;
    const resolution = !fork && !forced && input.model !== 'primary'
      ? await this.defaults.items[0]?.resolveModel(requestedProfileName, input.model)
      : undefined;
    const requestedModel = typeof resolution === 'object' ? resolution.model : resolution ?? input.model;
    const bindingNotice = typeof resolution === 'object' ? resolution.notice : undefined;
    const binding = fork
      ? { model: own.modelAlias, thinking: own.thinkingLevel, modelSource: 'inherited' as const }
      : resolveSubagentBinding(
          this.configService,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          requestedModel,
        );
    let model: Model;
    try {
      model = this.modelCatalog.get(binding.model);
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, own.modelAlias);
    }
    return {
      profileName: profile?.name ?? requestedProfileName,
      model: binding.model,
      modelSource: binding.modelSource,
      thinking: resolveSubagentThinking(this.configService, model, binding.thinking),
      fork,
      bindingNotice,
    };
  }

  async spawn(opts: SpawnSubagentOptions): Promise<SpawnedSubagent> {
    const caller = this.requireCaller(opts.callerAgentId);
    const { plan } = opts;
    const lease = plan.fork
      ? undefined
      : caller.accessor.get(IAgentRuntimeService).acquire(['process']);
    try {
      let created: IAgentScopeHandle;
      try {
        if (plan.fork) {
          const forked = await this.agentLifecycle.fork(agentContextOf(caller), {
            labels: opts.labels,
          });
          created = this.agentLifecycle.handleOf(forked.agentId)!;
          created.accessor
            .get(IAgentReminderService)
            .notify(FORK_CONTEXT_NOTICE, { variant: 'fork_context' });
        } else {
          const createdContext = await this.agentLifecycle.create({
            binding: {
              profile: plan.profileName,
              model: plan.model,
              thinking: plan.thinking,
            },
            labels: opts.labels,
            runtimeId: lease!.runtime.identity.runtimeId,
          });
          created = this.agentLifecycle.handleOf(createdContext.agentId)!;
        }
      } catch (error) {
        throw wrapSubagentModelError(
          error,
          plan.model,
          caller.accessor.get(IAgentProfileService).data().modelAlias,
        );
      }
      created.accessor
        .get(IAgentPermissionModeService)
        .setMode(permissionModeForChild(caller.accessor.get(IAgentPermissionModeService)));
      const createdUserTools = created.accessor.get(IAgentUserToolService);
      const callerUserTools = caller.accessor.get(IAgentUserToolService);
      if (plan.fork) {
        const activeToolNames = created.accessor.get(IAgentProfileService).getActiveToolNames();
        createdUserTools.inheritUserTools(callerUserTools, activeToolNames);
      } else {
        createdUserTools.inheritUserTools(callerUserTools);
      }
      const notice = plan.fork ? undefined : plan.bindingNotice;
      if (notice !== undefined) this.log.info(notice);
      const prompt = notice === undefined ? opts.prompt : `${notice}\nInclude this binding notice in your handoff.\n\n${opts.prompt}`;
      const promptText = plan.fork
        ? prompt
        : await this.applyPromptPrefix(plan.profileName, prompt, lease!.runtime);
      const identity = await this.assignIdentity(
        created.id,
        plan.profileName,
        opts.taskTitle ?? opts.prompt,
        notice,
      );
      return {
        agentId: created.id,
        profileName: plan.profileName,
        model: plan.model,
        modelSource: plan.modelSource,
        promptText,
        ...identity,
      };
    } finally {
      lease?.dispose();
    }
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  private async applyPromptPrefix(
    profileName: string,
    prompt: string,
    runtime: Runtime,
  ): Promise<string> {
    const profile = this.catalog.get(profileName);
    if (profile?.promptPrefix === undefined) return prompt;
    const view = new RuntimeWorkspaceView(runtime, {
      workDir: this.sessionContext.cwd,
    });
    return applyProfilePromptPrefix(profile, prompt, {
      cwd: view.workDir,
      process: runtime.process!,
      log: this.log,
    });
  }

  private async assignIdentity(
    agentId: string,
    profileName: string,
    taskText: string,
    bindingNotice?: string,
  ): Promise<{ readonly codename: string; readonly taskTitle: string }> {
    const metadata = await this.sessionMetadata.read();
    const existing = metadata.agents?.[agentId];
    const existingCodename = existing?.labels?.['codename'];
    const existingTaskTitle = existing?.labels?.['taskTitle'];
    if (existingCodename !== undefined && existingTaskTitle !== undefined) {
      return { codename: existingCodename, taskTitle: existingTaskTitle };
    }
    const used = new Set(this.reservedCodenames);
    for (const [id, meta] of Object.entries(metadata.agents ?? {})) {
      if (id === agentId || this.agentLifecycle.get(id) === undefined) continue;
      const codename = meta.labels?.['codename'];
      if (codename !== undefined) used.add(codename);
    }
    const selected = selectSubagentIdentity({
      sessionId: this.sessionContext.sessionId,
      agentId,
      profileName,
      taskText,
      usedCodenames: used,
    });
    const identity = { ...selected, taskTitle: bindingNotice === undefined ? selected.taskTitle : `${selected.taskTitle} — ${bindingNotice}` };
    this.reservedCodenames.add(identity.codename);
    try {
      await this.sessionMetadata.registerAgent(agentId, {
        ...existing,
        labels: { ...existing?.labels, codename: identity.codename, taskTitle: identity.taskTitle },
      });
    } finally {
      this.reservedCodenames.delete(identity.codename);
    }
    return identity;
  }

  private requireCaller(agentId: string): IAgentScopeHandle {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
