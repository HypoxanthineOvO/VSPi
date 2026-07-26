import { randomUUID } from "node:crypto";
import { type Component, type Focusable, Key, matchesKey, TUI } from "@earendil-works/pi-tui";
import type { AttachmentService } from "../attachments/service.js";
import type {
  ChatBackend,
  ChatQueueState,
  ModelSelectionResult,
  NewSessionOptions,
  RuntimeModelOption,
} from "../backend/types.js";
import { loadSettingsLayers, saveSettings } from "../config/settings.js";
import { COMPACTION_PROFILES, type CompactOptions } from "../continuity/compaction-profiles.js";
import {
  type ActionDefinition,
  type CommandDefinition,
  commandCompletion,
  getActionDefinition,
  resolveCommand,
} from "../domain/commands.js";
import { DEFAULT_USAGE } from "../domain/defaults.js";
import { effortLabel } from "../domain/effort.js";
import type {
  AppSettings,
  Attachment,
  EffortLevel,
  ProviderOption,
  Question,
  SessionOption,
  TranscriptMessage,
  UsageSnapshot,
} from "../domain/types.js";
import type { LocalPlanBackend, PlanBinding, PlanInput, PlanStatus, StoredPlan } from "../plans/types.js";
import {
  type ApprovalRequest,
  type ApprovalResponse,
  createExecutionPolicyService,
  type PolicySnapshot,
} from "../policy/execution-policy.js";
import {
  createYoloAcknowledgementBroker,
  type InteractiveApprovalBroker,
  type YoloAcknowledgementBroker,
} from "../policy/startup-runtime.js";
import type { EffectivePromptSegment } from "../prompts/effective-prompt.js";
import type {
  ModelIdentity,
  PromptProfileConfig,
  PromptProfileRule,
  PromptProfileSnapshot,
  ResolvedPromptProfile,
} from "../prompts/types.js";
import { renderActivityRail, renderQueuedMessage } from "../ui/activity.js";
import { padLine } from "../ui/ansi.js";
import { AuthDialog } from "../ui/auth-dialog.js";
import { Composer } from "../ui/composer.js";
import {
  type InteractionState,
  matchesInteraction,
  matchingInteraction,
  renderInteractionHint,
} from "../ui/interactions.js";
import { PanelController, type PanelEvent } from "../ui/panels.js";
import { renderSplash, type StartupStatus } from "../ui/splash.js";
import { renderStatusLines } from "../ui/status.js";
import type { VspiTheme } from "../ui/theme.js";
import {
  buildTranscriptNodes,
  isQueuedTranscriptMessage,
  renderTranscript,
  type TranscriptNode,
} from "../ui/transcript.js";
import { type SelfUpdateResult, updateVspi } from "../update/self-update.js";
import { VSPI_VERSION } from "../version.js";
import type { WorkflowAdapter, WorkflowSnapshot } from "../workflow/types.js";

export interface VspiAppOptions {
  cwd: string;
  settings: AppSettings;
  attachments: AttachmentService;
  renderOnce?: boolean;
  providerConfigFactory?: (trustedProject: boolean) => ProviderConfigUi;
  runtimeDefaultsFactory?: (trustedProject: boolean) => RuntimeDefaultsUi;
  executionPolicy?: ExecutionPolicyUi;
  approvalBroker?: InteractiveApprovalBroker;
  yoloAcknowledgementBroker?: YoloAcknowledgementBroker;
  planBackend?: Pick<LocalPlanBackend, "read" | "update">;
  planTaskRouter?: PlanTaskRouter;
  workflowAdapter?: WorkflowAdapter;
  promptProfiles?: PromptProfileUi;
  selfUpdate?: (currentVersion: string) => Promise<SelfUpdateResult>;
  openOnStart?: "sessions" | "providers";
  onExit: () => void;
}

interface PromptProfileUi {
  load(): Promise<PromptProfileSnapshot>;
  resolve(identity: ModelIdentity): ResolvedPromptProfile;
  save(
    scope: "global" | "project" | "session",
    config: PromptProfileConfig,
    options?: { expectedHash?: string },
  ): Promise<PromptProfileSnapshot>;
  fork(
    factoryId: string,
    input: { id: string; name: string; scope: "global" | "project" | "session" },
  ): Promise<unknown>;
  export(profileId: string): string;
  importFile(path: string, options: { scope: "global" | "project" | "session" }): Promise<unknown>;
  writeExport(profileId: string): Promise<string>;
}

export interface PlanTaskRouter {
  route(input: {
    text: string;
    binding: PlanBinding;
    plan: StoredPlan;
  }): Promise<{ kind: "current-plan" } | { kind: "question"; questions: Question[] }>;
}

interface ExecutionPolicyUi {
  snapshot(): PolicySnapshot;
  switchPolicy(policy: PolicySnapshot["policy"]): Promise<PolicySnapshot>;
}

interface RuntimeDefaultsUi {
  load(): Promise<{
    value: { model?: { provider: string; id: string }; effort: EffortLevel };
    diagnostics: string[];
  }>;
  save(
    scope: "global" | "project",
    value: { model?: { provider: string; id: string }; effort: EffortLevel },
  ): Promise<string>;
}

interface ProviderConfigUi {
  loadCatalog(): Promise<{
    hash: string;
    diagnostics: string[];
    providers: Array<{ id: string; source: "builtin" | "global" | "project" }>;
  }>;
  saveProjectProvider(
    id: string,
    value: { name: string; baseUrl: string; protocol: string },
    options: { expectedHash: string },
  ): Promise<{ hash: string; path: string }>;
}

type NoticeTone = "info" | "success" | "warning" | "error";

const WORKING_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

interface ActiveSubmission {
  id: number;
  raw: string;
  attachments: Attachment[];
  transcriptLength: number;
  cancelled: boolean;
  restored: boolean;
}

interface PendingQuestion {
  resolve(questions: Question[]): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface PendingApproval {
  resolve(response: ApprovalResponse): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class VspiApp implements Component, Focusable {
  readonly composer: Composer;
  private tui: TUI;
  private messages: TranscriptMessage[] = [];
  private readonly panels: PanelController;
  private usage: UsageSnapshot = DEFAULT_USAGE;
  private effort: EffortLevel = "medium";
  private modelLabel: string;
  private busy = false;
  private runActive = false;
  private queueState: ChatQueueState = { steering: 0, followUp: 0 };
  private clearingQueue = false;
  private workingFrame = 0;
  private workingTimer: NodeJS.Timeout | undefined;
  private workspaceFocus: "composer" | "transcript" | "plan" = "composer";
  private panelFocused = false;
  private inspectIndex: number | undefined;
  private inspectNodeId: string | undefined;
  private inspectToolId: string | undefined;
  private inspectDepth: "node" | "tool" = "node";
  private nextBehavior: "prompt" | "followUp" = "prompt";
  private renameAttachmentId: string | undefined;
  private renameInput = "";
  private preview: Component | undefined;
  private previewLabel = "";
  private notice: { text: string; tone: NoticeTone } | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private _focused = false;
  private renderReady = false;
  private submissionId = 0;
  private activeSubmission: ActiveSubmission | undefined;
  private disposing = false;
  private sessionHandoffPending = false;
  private sessionEpoch = 0;
  private sessionTransition = false;
  private pendingRouteSubmission: { raw: string } | undefined;
  private providerConfig: ProviderConfigUi | undefined;
  private providerCatalogHash: string | undefined;
  private runtimeDefaults: RuntimeDefaultsUi | undefined;
  private startupRuntimeDefaultsDiagnostic: string | undefined;
  private currentModelIdentity: { provider: string; id: string } | undefined;
  private modelOptions: RuntimeModelOption[] = [];
  private providerOptions: ProviderOption[] = [];
  private authDialog: AuthDialog | undefined;
  private readonly executionPolicy: ExecutionPolicyUi;
  private readonly yoloAcknowledgementBroker: YoloAcknowledgementBroker;
  private pendingQuestion: PendingQuestion | undefined;
  private pendingApproval: PendingApproval | undefined;
  private attachmentSessionId: string | undefined;
  private planSnapshot: StoredPlan | undefined;
  private promptProfileSnapshot: PromptProfileSnapshot | undefined;
  private effectivePromptSegments: EffectivePromptSegment[] = [];

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.composer.focused = value;
  }

  constructor(
    tui: TUI,
    private readonly theme: VspiTheme,
    private readonly backend: ChatBackend,
    private readonly options: VspiAppOptions,
  ) {
    this.tui = tui;
    const renderingTui = {
      terminal: tui.terminal,
      requestRender: (force?: boolean) => this.requestRender(force),
    } as TUI;
    this.composer = new Composer(renderingTui, theme);
    this.panels = new PanelController(options.settings);
    this.yoloAcknowledgementBroker = options.yoloAcknowledgementBroker ?? createYoloAcknowledgementBroker();
    this.executionPolicy =
      options.executionPolicy ??
      createExecutionPolicyService({
        workspace: options.cwd,
        acknowledgeYolo: () => this.yoloAcknowledgementBroker.consume(),
      });
    this.panels.setPolicySnapshot(this.executionPolicy.snapshot());
    options.approvalBroker?.setHandler((request, signal) => this.requestApproval(request, signal));
    this.modelLabel = backend.modelLabel;
    this.composer.onSubmit = (text) => void this.submit(text);
    this.composer.onChange = (text) => {
      this.panels.setCommandQuery(text);
      this.requestRender();
    };
    this.composer.onAttachmentRemove = (attachment) => void this.removeAttachment(attachment.id);
  }

  async start(): Promise<void> {
    try {
      await this.backend.start({
        onMessage: (message) => {
          if (this.sessionTransition) return;
          this.messages.push(this.withThinkingDisplayDefault(message));
          this.requestRender();
        },
        onMessageUpdate: (id, patch) => {
          if (this.sessionTransition) return;
          const index = this.messages.findIndex((message) => message.id === id);
          const current = this.messages[index];
          if (index >= 0 && current) this.messages[index] = { ...current, ...patch } as TranscriptMessage;
          this.requestRender();
        },
        onBusy: (busy) => {
          if (this.sessionTransition) return;
          this.setBusy(busy);
        },
        onQueueUpdate: (queue) => {
          if (this.sessionTransition) return;
          if (!this.clearingQueue) {
            this.settleQueuedMessages("steer", Math.max(0, this.queueState.steering - queue.steering));
            this.settleQueuedMessages("followUp", Math.max(0, this.queueState.followUp - queue.followUp));
          }
          this.queueState = { ...queue };
          this.syncActivityPresentation();
          this.requestRender();
        },
        onUsage: (usage) => {
          if (this.sessionTransition) return;
          this.usage = usage;
          this.requestRender();
        },
        onNotice: (text, tone) => this.showNotice(text, tone),
        onQuestion: (questions, signal) => this.requestQuestions(questions, signal),
        onPlanBindingChange: () => void this.refreshPlanSnapshot(this.sessionEpoch),
        onEffectivePrompt: (segments) => {
          this.effectivePromptSegments = structuredClone(segments);
          if (this.panels.kind === "prompt") void this.refreshPromptPanel();
        },
        onSessionWait: (waiting) => {
          this.setRunActive(waiting);
        },
        onHandoffPending: () => {
          this.sessionHandoffPending = true;
          this.showNotice("Session 将在当前任务和队列完成后交接；此终端不再接收新输入", "info");
        },
        onTakeover: () => {
          this.showNotice("当前任务已完成，Session 已交接到另一终端", "info");
          this.options.onExit();
        },
        onSessionInvalidating: () => this.cancelPendingQuestion("Question cancelled because the session changed"),
        onSessionReset: (session) => {
          this.sessionTransition = false;
          this.sessionHandoffPending = false;
          this.attachmentSessionId = session.id;
          this.modelLabel = this.backend.modelLabel;
          this.currentModelIdentity = this.backend.modelProvider
            ? { provider: this.backend.modelProvider, id: this.backend.modelId }
            : undefined;
          if (this.currentModelIdentity) this.panels.confirmModelSelection(this.currentModelIdentity);
          const epoch = this.resetSessionState();
          void this.refreshPlanSnapshot(epoch);
          if (this.renderReady) void this.switchAttachmentSession(session.id, epoch);
        },
      });
      this.modelLabel = this.backend.modelLabel;
      const [models, groups, runtimeProviders] = await Promise.all([
        this.backend.getModelOptions?.() ?? [],
        this.backend.getModelGroups?.() ?? [],
        this.backend.getProviderOptions?.() ?? [],
      ]);
      const backendModelIdentity = this.backend.modelProvider
        ? { provider: this.backend.modelProvider, id: this.backend.modelId }
        : undefined;
      this.panels.setModels(models, groups, backendModelIdentity);
      this.modelOptions = structuredClone(models);
      this.providerConfig = this.options.providerConfigFactory?.(this.backend.isProjectTrusted?.() ?? false);
      const catalog = await this.providerConfig?.loadCatalog();
      this.providerCatalogHash = catalog?.hash;
      const providers = runtimeProviders.map((provider) => {
        const source = catalog?.providers.find((item) => item.id === provider.id)?.source ?? "builtin";
        return { ...provider, detail: `${source} · ${provider.detail}` };
      });
      this.providerOptions = structuredClone(providers);
      this.panels.setProviders(providers);
      if (catalog && catalog.diagnostics.length > 0)
        this.showNotice(catalog.diagnostics[0] ?? "Provider 配置诊断", "warning");
      this.currentModelIdentity = backendModelIdentity;
      this.runtimeDefaults = this.options.runtimeDefaultsFactory?.(this.backend.isProjectTrusted?.() ?? false);
      await this.applyRuntimeDefaults();
      if (this.attachmentSessionId) await this.switchAttachmentSession(this.attachmentSessionId, this.sessionEpoch);
      await this.options.attachments.start(
        {
          onAttachment: (attachment, ownership) => {
            if (
              ownership &&
              (ownership.sessionId !== this.attachmentSessionId ||
                ownership.generation !== this.options.attachments.sessionGeneration)
            ) {
              return;
            }
            this.composer.addAttachment(attachment);
          },
          onNotice: (text, tone) => this.showNotice(text, tone),
        },
        this.options.settings.bridgeEnabled,
      );
      if (this.startupRuntimeDefaultsDiagnostic) {
        const diagnostic = this.startupRuntimeDefaultsDiagnostic;
        this.startupRuntimeDefaultsDiagnostic = undefined;
        this.showNotice(diagnostic, "warning");
      }
      this.renderReady = true;
      await this.refreshPlanSnapshot(this.sessionEpoch);
      await this.refreshWorkflowSnapshot();
      if (this.options.openOnStart === "sessions") {
        try {
          this.panels.setSessions(await this.backend.listSessions());
          this.panels.open("sessions");
        } catch (error) {
          this.showNotice(`会话读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
        }
      } else if (this.options.openOnStart === "providers") {
        this.panels.open("providers");
        this.showNotice("选择 Provider 后可登录订阅账号或配置 API Key", "info");
      }
    } catch (error) {
      this.renderReady = false;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.renderReady = false;
    this.authDialog?.cancel();
    this.authDialog = undefined;
    this.yoloAcknowledgementBroker.cancel();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.workingTimer) clearInterval(this.workingTimer);
    this.cancelPendingQuestion("Question cancelled because VSPi is closing");
    this.cancelPendingApproval("Approval cancelled because VSPi is closing");
    this.options.approvalBroker?.setHandler(undefined);
    try {
      if (this.activityActive()) {
        await waitForShutdownCancellation(this.backend.cancel().catch(() => undefined));
      }
      await this.options.attachments.dispose();
    } finally {
      await this.backend.dispose();
    }
  }

  getActiveTui(): TUI {
    return this.tui;
  }

  async runStartupCommand(raw: string): Promise<void> {
    const command = resolveCommand(raw);
    if (!command) throw new Error(`未知启动命令：${raw}`);
    await this.executeCommand(command, raw);
  }

  handleInput(data: string): void {
    if (this.sessionHandoffPending && !this.pendingQuestion && !this.pendingApproval) {
      this.showNotice("正在等待安全点交接到另一终端", "info");
      return;
    }
    if (this.authDialog) {
      this.authDialog.handleInput(data);
      return;
    }
    if (this.renameAttachmentId) {
      this.handleRenameInput(data);
      return;
    }
    if (this.preview) {
      if (matchesInteraction("composer", "preview", "closePreview", data)) {
        this.preview = undefined;
        this.previewLabel = "";
        this.requestRender();
      } else {
        this.showNotice("预览打开中，按 Esc 关闭", "info");
      }
      return;
    }
    if (this.workspaceFocus === "transcript") {
      this.handleInspectInput(data);
      return;
    }
    const composerState = {
      busy: this.activityActive(),
      hasMessages: this.messages.length > 0,
      composerEmpty: this.composer.getText() === "",
      commandCompletable: this.commandCompletionAvailable(),
      selectedAttachment: this.composer.selectedAttachment() !== undefined,
    };
    if (matchesInteraction("composer", "main", "cancelOrExit", data, composerState)) {
      if (this.activityActive()) void this.cancelGeneration();
      else this.options.onExit();
      return;
    }
    if (matchesInteraction("composer", "main", "pasteAttachment", data, composerState)) {
      void this.pasteAttachment();
      return;
    }
    const selectedAttachment = this.composer.selectedAttachment();
    if (selectedAttachment) {
      if (matchesInteraction("composer", "attachment", "renameAttachment", data)) {
        this.renameAttachmentId = selectedAttachment.id;
        this.renameInput = selectedAttachment.alias;
        this.requestRender();
        return;
      }
      if (matchesInteraction("composer", "attachment", "previewAttachment", data)) {
        void this.previewAttachment(selectedAttachment.id, selectedAttachment.alias);
        return;
      }
      if (matchesInteraction("composer", "attachment", "saveAttachment", data)) {
        void this.saveAttachment(selectedAttachment.id);
        return;
      }
      if (matchesInteraction("composer", "attachment", "removeAttachment", data)) {
        this.composer.removeSelectedAttachment();
        return;
      }
    }
    if (matchesInteraction("composer", "main", "submitFollowUp", data, composerState)) {
      const text = this.composer.getText();
      if (text.trim()) {
        this.nextBehavior = "followUp";
        void this.submit(text);
      }
      return;
    }
    if (matchesInteraction("composer", "main", "enterInspect", data, composerState)) {
      this.focusTranscript();
      return;
    }
    if (matchesInteraction("composer", "main", "completeCommand", data, composerState) && this.completeCommandToken())
      return;
    if (
      this.panels.kind === "plan" &&
      matchesInteraction("composer", "main", "cycleWorkspaceFocus", data, composerState)
    ) {
      this.cycleWorkspaceFocus();
      return;
    }
    if (this.panels.kind === "plan" && this.panelFocused && matchesKey(data, Key.escape)) {
      this.focusComposer();
      return;
    }
    if (this.panels.kind === "commands") {
      if (this.panels.acceptsInput(data)) {
        this.handlePanelInput(data);
        return;
      }
    } else if (this.panels.kind !== "plan" || this.panelFocused) {
      this.handlePanelInput(data);
      return;
    }
    if (matchesInteraction("composer", "main", "interruptGeneration", data, composerState)) {
      void this.cancelGeneration();
      return;
    }
    if (matchesKey(data, Key.tab) && composerState.composerEmpty && !composerState.hasMessages) {
      this.showNotice("暂无消息，无法进入 Inspect", "info");
      return;
    }
    this.composer.handleInput(data);
  }

  private completeCommandToken(): boolean {
    const text = this.composer.getText();
    if (!/^\/[^\s]*$/.test(text)) return false;
    const match = commandCompletion(text);
    if (!match) return false;
    if (text !== match.matchedToken) this.composer.setText(match.matchedToken);
    return true;
  }

  private commandCompletionAvailable(): boolean {
    const text = this.composer.getText();
    return /^\/[^\s]*$/.test(text) && commandCompletion(text) !== undefined;
  }

  private handlePanelInput(data: string): void {
    const panelKind = this.panels.kind;
    const event = this.panels.handleInput(data);
    const policy = this.executionPolicy.snapshot();
    const confirmedYolo =
      panelKind === "policy" &&
      matchesKey(data, Key.enter) &&
      event?.type === "policyChange" &&
      event.policy === "YOLO" &&
      event.requiresAcknowledgement &&
      policy.policy !== "YOLO" &&
      !policy.recovery;
    if (confirmedYolo) this.yoloAcknowledgementBroker.grantOnce("tui");
    else if (panelKind === "policy") this.yoloAcknowledgementBroker.cancel();
    void this.applyPanelEvent(event);
  }

  startupStatus(): StartupStatus {
    const policy = this.executionPolicy.snapshot();
    return {
      model: this.modelLabel,
      backend: this.backend.kind === "pi" ? "Pi" : "Fixture",
      policy: policy.policy,
      boundary: policy.boundary,
      version: VSPI_VERSION,
      ...(policy.recovery ? { recovery: true } : {}),
    };
  }

  render(width: number): string[] {
    if (this.authDialog) return this.authDialog.render(width, this.theme);
    const transcriptFocused = this.workspaceFocus === "transcript";
    const output = renderTranscript(this.messages, width, this.theme, {
      ...(transcriptFocused && this.inspectNodeId ? { selectedNodeId: this.inspectNodeId } : {}),
      ...(transcriptFocused && this.inspectDepth === "tool" && this.inspectToolId
        ? { selectedToolId: this.inspectToolId }
        : {}),
      thinkingDisplay: this.options.settings.thinkingDisplay,
      wrapCode: this.options.settings.wrapCode,
      collapseCompletedTools: this.options.settings.collapseTools,
    });
    if (output.length > 0) output.push("");
    const composer = this.composer.render(width);
    const activity = this.activityActive()
      ? [
          renderActivityRail(
            {
              indicator: this.options.settings.reducedMotion
                ? this.theme.capabilities.unicode
                  ? "●"
                  : "*"
                : this.theme.capabilities.unicode
                  ? (WORKING_FRAMES[this.workingFrame % WORKING_FRAMES.length] ?? WORKING_FRAMES[0])
                  : "*",
              ...this.queueState,
            },
            width,
            this.theme,
          ),
        ]
      : [];
    const queuedMessages = this.messages
      .filter(isQueuedTranscriptMessage)
      .map((message) => renderQueuedMessage(message, width, this.theme));
    const status = this.renderStatus(width);
    const panelRows =
      this.panels.kind === "approval"
        ? Math.min(
            14,
            Math.max(
              3,
              this.tui.terminal.rows - composer.length - activity.length - queuedMessages.length - status.length - 6,
            ),
          )
        : this.tui.terminal.rows <= 24
          ? Math.max(
              3,
              (this.panels.kind === "models" ? 10 : 9) - activity.length - queuedMessages.length - (status.length - 1),
            )
          : Math.min(
              16,
              Math.max(
                3,
                this.tui.terminal.rows - composer.length - activity.length - queuedMessages.length - 7 - status.length,
              ),
            );
    if (this.preview) {
      output.push(...this.preview.render(width));
      output.push(this.notice ? this.renderNotice(width) : this.theme.muted(padLine(this.previewLabel, width)));
    } else {
      output.push(...this.panels.render(width, panelRows, this.theme, this.usage, this.panelFocused));
      const hint = this.notice
        ? this.renderNotice(width)
        : transcriptFocused
          ? this.theme.muted(
              padLine(renderInteractionHint("inspect", "transcript", this.inspectInteractionState()), width),
            )
          : this.renderPanelHint(width);
      output.push(hint);
    }
    output.push(...activity);
    output.push(...queuedMessages);
    output.push(...composer);
    output.push(...status);
    return output;
  }

  invalidate(): void {
    this.composer.invalidate();
  }

  private renderPanelHint(width: number): string {
    if (this.panels.kind === "plan" && !this.panelFocused) {
      return this.theme.muted(padLine(renderInteractionHint("panel", "plan", {}), width));
    }
    return this.panels.renderHint(width, this.theme);
  }

  private async submit(raw: string, options?: { skipPlanRoute?: boolean }): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const queuedDuringWork = this.activityActive();
    const behavior = this.nextBehavior;
    this.nextBehavior = "prompt";
    if (text.startsWith("/")) {
      if (queuedDuringWork) {
        this.showNotice("命令需等待当前任务结束；普通消息可直接 Enter 插入", "info");
        return;
      }
      const command = resolveCommand(text);
      if (!command) {
        this.showNotice(`未知命令：${text.split(/\s+/, 1)[0]}`, "error");
        return;
      }
      this.composer.editor.addToHistory(text);
      this.composer.setText("");
      await this.executeCommand(command, text);
      return;
    }
    const binding = queuedDuringWork ? undefined : this.backend.getPlanBinding?.();
    if (binding && this.options.planBackend && this.planSnapshot?.id !== binding.planId) {
      await this.refreshPlanSnapshot(this.sessionEpoch);
      if (this.planSnapshot?.id !== binding.planId) {
        this.showNotice("当前 Plan binding 尚未完成快照同步，请重试", "warning");
        return;
      }
    }
    if (binding && this.planSnapshot?.id === binding.planId && this.options.planTaskRouter && !options?.skipPlanRoute) {
      const route = await this.options.planTaskRouter.route({
        text,
        binding,
        plan: structuredClone(this.planSnapshot),
      });
      if (route.kind === "question") {
        this.pendingRouteSubmission = { raw };
        this.panels.openQuestions(route.questions);
        this.panelFocused = true;
        this.requestRender();
        return;
      }
    }
    const pendingAttachments = [...this.composer.attachments];
    if (pendingAttachments.length > 0 && !this.backend.supportsVision) {
      this.showNotice(`${this.modelLabel} 不支持图片输入，请先切换 vision 模型`, "error");
      return;
    }
    const transcriptLength = this.messages.length;
    const attachments = this.composer.clearAttachments();
    const messageId = randomUUID();
    const delivery = queuedDuringWork ? (behavior === "followUp" ? "followUp" : "steer") : undefined;
    this.messages.push({
      id: messageId,
      role: "user",
      kind: "text",
      text,
      attachments,
      ...(delivery ? { delivery } : {}),
    });
    this.composer.setText("");
    this.requestRender();
    if (queuedDuringWork) {
      try {
        const result = await this.backend.send(text, { attachments, effort: this.effort, behavior });
        this.composer.editor.addToHistory(text);
        const mode = result?.delivery ?? delivery;
        this.showNotice(
          mode === "followUp" ? "已加入 Follow-up，将在当前任务完成后继续" : "已插入，将在下一次模型调用前送达",
          "success",
        );
      } catch (error) {
        this.messages = this.messages.filter((message) => message.id !== messageId);
        const currentDraft = this.composer.getText().trim();
        this.composer.restoreDraft([raw, currentDraft].filter(Boolean).join("\n\n"), [
          ...attachments,
          ...this.composer.attachments,
        ]);
        this.showNotice(error instanceof Error ? error.message : "排队消息发送失败", "error");
      }
      return;
    }
    const submission: ActiveSubmission = {
      id: ++this.submissionId,
      raw,
      attachments: pendingAttachments,
      transcriptLength,
      cancelled: false,
      restored: false,
    };
    this.activeSubmission = submission;
    this.setRunActive(true);
    try {
      const result = await this.backend.send(text, { attachments, effort: this.effort, behavior });
      if (submission.cancelled || result?.status === "cancelled") {
        this.finalizeCancelledSubmission(submission);
        return;
      }
      this.modelLabel = this.backend.modelLabel;
      this.composer.editor.addToHistory(text);
    } catch (error) {
      if (submission.cancelled) {
        this.finalizeCancelledSubmission(submission);
        return;
      }
      this.setBusy(false);
      this.messages.splice(transcriptLength);
      this.composer.restoreDraft(raw, pendingAttachments);
      this.showNotice(error instanceof Error ? error.message : "消息发送失败", "error");
    } finally {
      if (this.activeSubmission?.id === submission.id) this.activeSubmission = undefined;
      if (!submission.cancelled) this.setRunActive(false);
    }
  }

  private renderStatus(width: number): string[] {
    if (this.renameAttachmentId) {
      return [this.theme.focus(padLine(`重命名  ${this.renameInput}${this.theme.inverse(" ")}`, width))];
    }
    const selectedAttachment = this.composer.selectedAttachment();
    if (selectedAttachment) {
      return [this.theme.blue(padLine(`〔${selectedAttachment.alias}〕  重命名 · 预览 · 移除 · 保存到项目`, width))];
    }
    const policy = this.executionPolicy.snapshot();
    const mode =
      this.workspaceFocus === "transcript"
        ? "Inspect"
        : this.workspaceFocus === "plan"
          ? "Plan"
          : policy.recovery
            ? "Recovery"
            : undefined;
    const runtime = this.startupStatus();
    return renderStatusLines(
      {
        cwd: this.options.cwd,
        usage: this.usage,
        modelLabel: this.modelLabel,
        effort: this.effort,
        // Runtime activity has a dedicated rail above the composer; keep telemetry free of duplicate busy text.
        busy: false,
        backend: runtime.backend,
        policy: runtime.policy,
        boundary: runtime.boundary,
        ...(mode ? { mode } : {}),
      },
      width,
      this.theme,
    );
  }

  private renderNotice(width: number): string {
    if (!this.notice) return "";
    const style =
      this.notice.tone === "error"
        ? this.theme.error
        : this.notice.tone === "warning"
          ? this.theme.warning
          : this.notice.tone === "success"
            ? this.theme.success
            : this.theme.blue;
    return style(padLine(this.notice.text, width));
  }

  private showNotice(text: string, tone: NoticeTone): void {
    this.notice = { text, tone };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = undefined;
      this.noticeTimer = undefined;
      this.requestRender();
    }, 3500);
    this.requestRender();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncActivityPresentation();
  }

  private setRunActive(active: boolean): void {
    this.runActive = active;
    if (active && this.workspaceFocus === "plan") {
      this.workspaceFocus = "composer";
      this.panelFocused = false;
      this.inspectIndex = undefined;
    }
    this.syncActivityPresentation();
  }

  private activityActive(): boolean {
    return this.runActive || this.busy || this.queueState.steering + this.queueState.followUp > 0;
  }

  private syncActivityPresentation(): void {
    const active = this.activityActive();
    if (active && !this.workingTimer && !this.options.settings.reducedMotion) {
      this.workingTimer = setInterval(() => {
        this.workingFrame = (this.workingFrame + 1) % WORKING_FRAMES.length;
        this.requestRender();
      }, 240);
      this.workingTimer.unref();
    } else if (!active && this.workingTimer) {
      clearInterval(this.workingTimer);
      this.workingTimer = undefined;
      this.workingFrame = 0;
    }
    if (this.renderReady) this.tui.terminal.setProgress(active);
    this.requestRender();
  }

  private async executeCommand(command: CommandDefinition, raw = command.label): Promise<void> {
    const action = getActionDefinition(command);
    if (!action) {
      this.showNotice(`${command.label} 没有可用的生产 handler`, "error");
      return;
    }
    if (action.availability === "disabled") {
      this.showNotice(action.disabledReason ?? `${action.label} 暂不可用`, "warning");
      this.panels.close();
      return;
    }
    await this.executeEnabledAction(action, raw);
  }

  private async executeEnabledAction(action: ActionDefinition, raw: string): Promise<void> {
    if (action.handler === "quit") {
      this.options.onExit();
      return;
    }
    if (action.handler === "newSession") {
      try {
        const newSessionOptions = parseNewSessionOptions(raw);
        const epoch = this.sessionEpoch;
        this.sessionTransition = true;
        await this.backend.newSession(newSessionOptions);
        if (this.sessionEpoch === epoch) {
          this.sessionTransition = false;
          this.resetSessionState();
        }
        if (newSessionOptions.defaults) await this.applyRuntimeDefaults();
        this.panels.close();
        this.restartTuiWithFinalSplash();
      } catch (error) {
        this.sessionTransition = false;
        this.showNotice(`新建会话失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "compact") {
      try {
        const compact = parseCompactOptions(raw);
        if (compact === "list") {
          const defaultProfile = this.backend.getPlanBinding?.() ? "execution-continuity" : "pi-native";
          this.showNotice(
            `Compact profiles: ${COMPACTION_PROFILES.map((profile) => profile.id).join(", ")} · default ${defaultProfile}`,
            "info",
          );
          return;
        }
        await this.backend.compact(compact);
        this.panels.close();
      } catch (error) {
        this.composer.setText(raw);
        this.showNotice(`上下文压缩失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "update") {
      this.panels.close();
      this.showNotice("正在检查 VSPi 更新...", "info");
      this.requestRender();
      try {
        const result = await (this.options.selfUpdate ?? updateVspi)(VSPI_VERSION);
        this.showNotice(
          result.status === "updated"
            ? `已更新到 VSPi ${result.latestVersion}，重启后生效`
            : `当前已是最新版本 ${result.currentVersion}`,
          "success",
        );
      } catch (error) {
        this.showNotice(`更新失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "effort") {
      try {
        const currentModel = this.currentModelIdentity
          ? this.modelOptions.find(
              (model) =>
                model.provider === this.currentModelIdentity?.provider && model.id === this.currentModelIdentity.id,
            )
          : undefined;
        const levels = (await this.backend.getEffortOptions?.()) ?? currentModel?.efforts ?? ["off"];
        this.panels.openEffort(this.effort, levels);
      } catch (error) {
        this.showNotice(`Effort 读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "login") {
      await this.openLogin(raw);
      return;
    }
    if (action.handler === "logout") {
      await this.openLogout(raw);
      return;
    }
    if (action.handler === "models") this.panels.open("models");
    else if (action.handler === "providers") this.panels.open("providers");
    else if (action.handler === "tools") this.panels.open("tools");
    else if (action.handler === "plan") {
      if (this.options.workflowAdapter) await this.refreshWorkflowSnapshot();
      else await this.refreshPlanSnapshot(this.sessionEpoch);
      this.panels.open("plan");
      this.focusPlan();
    } else if (action.handler === "prompt") {
      await this.executePromptCommand(raw);
    } else if (action.handler === "sessions") {
      try {
        this.panels.setSessions(await this.backend.listSessions());
        this.panels.open("sessions");
      } catch (error) {
        this.showNotice(`会话读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (action.handler === "settings" || action.handler === "thinkingSettings") {
      try {
        const layers = await loadSettingsLayers(this.options.cwd, undefined, {
          trustedProject: this.backend.isProjectTrusted?.() ?? false,
        });
        this.panels.setSettingsLayers(layers);
        this.panels.open("settings");
      } catch (error) {
        this.showNotice(`设置读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (action.handler === "usage") this.panels.open("usage");
    else if (action.handler === "policy") {
      this.panels.setPolicySnapshot(this.executionPolicy.snapshot());
      this.panels.open("policy");
    } else if (action.handler === "theme") this.panels.open("theme");
    if (action.handler !== "plan") this.focusComposer();
    this.requestRender();
  }

  private restartTuiWithFinalSplash(): void {
    const terminal = this.tui.terminal as typeof this.tui.terminal & {
      columns?: number;
      write?: (chunk: string) => void;
    };
    if (typeof terminal.write !== "function") return;
    const width = terminal.columns ?? 80;
    if (this.options.renderOnce || typeof this.tui.stop !== "function" || typeof this.tui.start !== "function") {
      terminal.write(`${renderSplash(width, this.theme, 1, this.startupStatus()).join("\n")}\n`);
      return;
    }

    const previousTui = this.tui;
    const showHardwareCursor = previousTui.getShowHardwareCursor();
    const clearOnShrink = previousTui.getClearOnShrink();
    previousTui.stop();
    terminal.write(`${renderSplash(width, this.theme, 1, this.startupStatus()).join("\n")}\n`);

    const nextTui = new TUI(terminal, showHardwareCursor);
    nextTui.setClearOnShrink(clearOnShrink);
    nextTui.addChild(this);
    nextTui.setFocus(this);
    this.tui = nextTui;
    nextTui.start();
  }

  private async applyPanelEvent(event: PanelEvent | undefined): Promise<void> {
    if (!event) {
      this.requestRender();
      return;
    }
    if (event.type === "close") {
      if (this.composer.getText() === "/") this.composer.setText("");
      if (this.pendingApproval) {
        const pending = this.pendingApproval;
        this.pendingApproval = undefined;
        pending.cleanup();
        pending.resolve({ type: "deny", reason: "Approval cancelled by user" });
      }
      if (this.pendingQuestion) this.cancelPendingQuestion("Question cancelled by user");
      if (this.pendingRouteSubmission) {
        this.composer.setText(this.pendingRouteSubmission.raw);
        this.pendingRouteSubmission = undefined;
      }
    } else if (event.type === "command") {
      this.composer.setText("");
      await this.executeCommand(event.command, event.command.label);
    } else if (event.type === "model") {
      if (this.activityActive()) {
        this.showNotice("生成中，请等待完成后再切换模型", "warning");
        this.requestRender();
        return;
      }
      try {
        if (!this.backend.selectModel || !event.model.provider) throw new Error("该模型缺少 runtime Provider identity");
        const selected = await this.backend.selectModel(event.model.provider, event.model.id);
        this.modelLabel = this.backend.modelLabel;
        this.currentModelIdentity = { provider: event.model.provider, id: selected.modelId };
        this.effort = selected.effort;
        this.panels.confirmModelSelection({ provider: event.model.provider, id: selected.modelId });
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.panels.close();
        if (defaultsSaved)
          this.showNotice(`模型已切换为 ${this.modelLabel} · Effort ${effortLabel(this.effort)}`, "success");
      } catch (error) {
        this.showNotice(`模型切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "modelGroup") {
      if (this.activityActive()) {
        this.showNotice("生成中，请等待完成后再切换模型", "warning");
        this.requestRender();
        return;
      }
      try {
        if (!this.backend.selectModel || !this.backend.setEffort || !this.backend.getModelOptions) {
          throw new Error("当前后端不支持模型组切换");
        }
        const role = event.group.roles.find((candidate) => candidate.role === "默认") ?? event.group.roles[0];
        if (!role) throw new Error(`模型组 ${event.group.label} 没有可用角色`);
        const matches = (await this.backend.getModelOptions()).filter((model) => model.id === role.modelId);
        if (matches.length !== 1 || !matches[0]?.provider) {
          throw new Error(`模型组 ${event.group.label} 的模型 ${role.modelId} 缺失或 Provider identity 不唯一`);
        }
        const model = matches[0];
        const previousEffort = this.effort;
        await this.backend.setEffort(role.effort);
        let selected: ModelSelectionResult;
        try {
          selected = await this.backend.selectModel(model.provider, model.id);
        } catch (error) {
          await this.backend.setEffort(previousEffort).catch(() => undefined);
          throw error;
        }
        this.modelLabel = this.backend.modelLabel;
        this.currentModelIdentity = { provider: model.provider, id: selected.modelId };
        this.effort = role.effort;
        this.panels.confirmModelSelection(this.currentModelIdentity);
        this.panels.confirmModelGroupSelection(event.group.id);
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.panels.close();
        if (defaultsSaved)
          this.showNotice(`模型组已切换为 ${event.group.label} · Effort ${effortLabel(this.effort)}`, "success");
      } catch (error) {
        this.showNotice(`模型组切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "provider") {
      this.showNotice(`${event.provider.label} 请先从操作菜单选择离线检查、网络测试或编辑`, "info");
    } else if (event.type === "providerActions") {
      // Panel owns the local action-menu state; opening it performs no I/O.
    } else if (event.type === "providerAction") {
      if (event.action.startsWith("login:")) {
        const type = event.action.slice("login:".length);
        if (type === "oauth" || type === "api_key") await this.startProviderLogin(event.provider, type);
      } else if (event.action === "logout") {
        await this.removeProviderCredential(event.provider);
      } else if (event.action === "edit") {
        // Panel has already entered its local, secret-free editor.
      } else if (event.action === "check-config") {
        await this.runProviderProbe(event.provider.id, "check-config");
      } else if (event.action === "test-connection") {
        await this.runProviderProbe(event.provider.id, "test-connection");
      } else {
        await this.runProviderProbe(event.provider.id, "minimal-generation", async () => event.costConfirmed === true);
      }
    } else if (event.type === "providerSave") {
      try {
        if (!this.providerConfig || !this.providerCatalogHash) throw new Error("Provider overlay service 未配置");
        const saved = await this.providerConfig.saveProjectProvider(event.provider.id, event.value, {
          expectedHash: this.providerCatalogHash,
        });
        this.providerCatalogHash = saved.hash;
        this.showNotice(
          `Provider 配置已原子保存到 ${saved.path}；使用 /new 后按 Provider/model identity 重载`,
          "success",
        );
      } catch (error) {
        this.showNotice(`Provider 配置未保存：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "session") {
      if (event.session.owner) {
        try {
          const action = await this.confirmSessionCollision(event.session);
          if (action === "cancel") {
            this.panels.setSessions(await this.backend.listSessions());
            this.panels.open("sessions");
            return;
          }
          if (action === "fork") {
            if (!this.backend.forkSession) throw new Error("当前后端不支持会话分支");
            await this.backend.forkSession(event.session.id);
            this.panels.close();
            return;
          }
        } catch (error) {
          this.showNotice(`Session 操作失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
          return;
        }
      }
      const epoch = this.sessionEpoch;
      this.sessionTransition = true;
      try {
        await this.backend.switchSession(event.session.id);
        if (this.sessionEpoch === epoch) this.sessionTransition = false;
        this.panels.close();
      } catch (error) {
        this.sessionTransition = false;
        this.showNotice(`会话切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "fork") {
      const epoch = this.sessionEpoch;
      this.sessionTransition = true;
      try {
        if (!this.backend.forkSession) throw new Error("当前后端不支持会话分支");
        await this.backend.forkSession(event.session.id);
        if (this.sessionEpoch === epoch) this.sessionTransition = false;
        this.panels.close();
      } catch (error) {
        this.sessionTransition = false;
        this.showNotice(`会话分支失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "settings") {
      try {
        const path = await saveSettings(this.options.cwd, event.settings, undefined, {
          trustedProject: this.backend.isProjectTrusted?.() ?? false,
        });
        this.panels.confirmSettings(event.settings);
        if (this.options.settings.scope === event.settings.scope) {
          this.options.settings = { ...event.settings };
          this.applyThinkingDisplay(event.settings.thinkingDisplay);
        }
        this.panels.close();
        this.showNotice(`${event.settings.scope === "global" ? "全局" : "项目"}设置已保存到 ${path}`, "success");
      } catch (error) {
        this.showNotice(`设置保存失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "effort") {
      try {
        if (!this.backend.setEffort) throw new Error("当前后端不支持 Effort 切换");
        await this.backend.setEffort(event.effort);
        this.effort = event.effort;
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.panels.close();
        if (defaultsSaved) this.showNotice(`Effort 已切换为 ${effortLabel(event.effort)}`, "success");
      } catch (error) {
        this.showNotice(`Effort 切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "approval") {
      const pending = this.pendingApproval;
      this.pendingApproval = undefined;
      pending?.cleanup();
      pending?.resolve(event.response);
      this.panels.close();
    } else if (event.type === "policyChange") {
      try {
        const snapshot = await this.executionPolicy.switchPolicy(event.policy);
        this.panels.setPolicySnapshot(snapshot);
        this.showNotice(`Policy 已切换为 ${snapshot.policy} · ${snapshot.boundary}`, "success");
      } catch (error) {
        this.panels.setPolicySnapshot(this.executionPolicy.snapshot());
        this.showNotice(`Policy 切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      } finally {
        this.yoloAcknowledgementBroker.cancel();
      }
    } else if (event.type === "questions") {
      const pending = this.pendingQuestion;
      this.pendingQuestion = undefined;
      pending?.cleanup();
      pending?.resolve(event.questions);
      this.showNotice(`已提交 ${event.questions.length} 个回答`, "success");
      this.panels.close();
      const routed = this.pendingRouteSubmission;
      this.pendingRouteSubmission = undefined;
      if (routed) {
        if (this.activityActive()) this.composer.setText(routed.raw);
        else void this.submit(routed.raw, { skipPlanRoute: true });
      }
    } else if (event.type === "planEdit") {
      await this.applyPlanEdit(event);
    } else if (event.type === "promptToggleRule") {
      await this.updatePromptSession({ toggleRule: event });
    } else if (event.type === "promptPin") {
      await this.updatePromptSession({ pin: event.profileId });
    } else if (event.type === "promptOff") {
      await this.updatePromptSession({ disabled: true });
    } else if (event.type === "promptFork") {
      try {
        if (!this.options.promptProfiles) throw new Error("Prompt Profile service 未配置");
        const id = `fork-${event.profileId.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now().toString(36)}`;
        await this.options.promptProfiles.fork(event.profileId, {
          id,
          name: `${event.profileId} Fork`,
          scope: "session",
        });
        await this.refreshPromptPanel();
        this.showNotice(`Prompt Profile 已 Fork 为 ${id}`, "success");
      } catch (error) {
        this.showNotice(`Prompt Profile Fork 失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "promptImport") {
      try {
        if (!this.options.promptProfiles) throw new Error("Prompt Profile service 未配置");
        await this.options.promptProfiles.importFile(event.path, { scope: event.scope });
        await this.refreshPromptPanel();
        this.showNotice(`Prompt Profile 已从 ${event.path} 导入 Session`, "success");
      } catch (error) {
        this.showNotice(`Prompt Profile 导入失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "promptExport") {
      try {
        const path = await this.options.promptProfiles?.writeExport(event.profileId);
        if (!path) throw new Error("Prompt Profile service 未配置");
        this.showNotice(`Prompt Profile 已导出到 ${path}`, "success");
      } catch (error) {
        this.showNotice(`Prompt Profile 导出失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else {
      this.showNotice(event.text, event.tone);
    }
    this.requestRender();
  }

  private async openLogin(raw: string): Promise<void> {
    const providerRef = raw.trim().split(/\s+/, 2)[1];
    if (!providerRef) {
      this.panels.open("providers");
      this.showNotice("选择 Provider 后打开登录操作", "info");
      this.requestRender();
      return;
    }
    const provider = this.findProvider(providerRef);
    if (!provider) {
      this.showNotice(`未找到 Provider：${providerRef}`, "error");
      return;
    }
    const method = provider.authMethods?.find((candidate) => candidate.type === "oauth") ?? provider.authMethods?.[0];
    if (!method) {
      this.showNotice(`${provider.label} 没有可交互配置的认证方式`, "warning");
      return;
    }
    await this.startProviderLogin(provider, method.type);
  }

  private async openLogout(raw: string): Promise<void> {
    const providerRef = raw.trim().split(/\s+/, 2)[1];
    if (!providerRef) {
      this.panels.open("providers");
      this.showNotice("带有已保存凭据的 Provider 会显示“移除凭据”操作", "info");
      this.requestRender();
      return;
    }
    const provider = this.findProvider(providerRef);
    if (!provider) {
      this.showNotice(`未找到 Provider：${providerRef}`, "error");
      return;
    }
    await this.removeProviderCredential(provider);
  }

  private findProvider(reference: string): ProviderOption | undefined {
    const normalized = reference.trim().toLowerCase();
    return this.providerOptions.find(
      (provider) => provider.id.toLowerCase() === normalized || provider.label.toLowerCase() === normalized,
    );
  }

  private async startProviderLogin(provider: ProviderOption, type: "api_key" | "oauth"): Promise<void> {
    if (!this.backend.loginProvider) {
      this.showNotice("当前后端不支持 Provider 登录", "error");
      return;
    }
    let cancelled = false;
    const dialog = new AuthDialog(
      provider.label,
      () => this.requestRender(),
      () => {
        cancelled = true;
        if (this.authDialog === dialog) this.authDialog = undefined;
        this.showNotice("登录已取消", "info");
      },
      type === "oauth" ? "登录" : "配置",
    );
    this.authDialog = dialog;
    this.requestRender();
    try {
      await this.backend.loginProvider(provider.id, type, dialog);
      if (cancelled || dialog.signal.aborted) return;
      this.authDialog = undefined;
      await this.refreshRuntimeCatalog();
      this.panels.open("providers");
      this.panels.selectProvider(provider.id);
      this.showNotice(
        type === "oauth" ? `${provider.label} 账号已连接` : `${provider.label} API Key 已保存`,
        "success",
      );
    } catch (error) {
      if (cancelled || dialog.signal.aborted) return;
      this.authDialog = undefined;
      this.showNotice(`登录失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    } finally {
      this.requestRender();
    }
  }

  private async removeProviderCredential(provider: ProviderOption): Promise<void> {
    if (!provider.storedCredential) {
      this.showNotice(`${provider.label} 没有由 VSPi/Pi 保存的凭据；环境变量不会被移除`, "warning");
      return;
    }
    try {
      if (!this.backend.logoutProvider) throw new Error("当前后端不支持移除 Provider 凭据");
      await this.backend.logoutProvider(provider.id);
      await this.refreshRuntimeCatalog();
      this.panels.open("providers");
      this.panels.selectProvider(provider.id);
      this.showNotice(`${provider.label} 的已保存凭据已移除；环境变量和 models.json 未改变`, "success");
    } catch (error) {
      this.showNotice(`移除凭据失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async refreshRuntimeCatalog(): Promise<void> {
    const [models, groups, providers] = await Promise.all([
      this.backend.getModelOptions?.() ?? [],
      this.backend.getModelGroups?.() ?? [],
      this.backend.getProviderOptions?.() ?? [],
    ]);
    this.modelOptions = structuredClone(models);
    this.providerOptions = structuredClone(providers);
    this.panels.setModels(models, groups, this.currentModelIdentity);
    this.panels.setProviders(providers);
  }

  private async refreshPlanSnapshot(epoch: number): Promise<void> {
    const binding = this.backend.getPlanBinding?.();
    if (!binding || !this.options.planBackend) {
      if (epoch === this.sessionEpoch) {
        this.planSnapshot = undefined;
        if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(undefined);
      }
      return;
    }
    try {
      const plan = await this.options.planBackend.read(binding.planId);
      if (epoch !== this.sessionEpoch || this.backend.getPlanBinding?.()?.planId !== binding.planId) return;
      this.planSnapshot = plan ? structuredClone(plan) : undefined;
      if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(this.planSnapshot);
      if (!plan) this.showNotice(`绑定的 Local Plan ${binding.planId} 不存在`, "warning");
    } catch (error) {
      if (epoch !== this.sessionEpoch || this.backend.getPlanBinding?.()?.planId !== binding.planId) return;
      this.planSnapshot = undefined;
      if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(undefined);
      this.showNotice(`Local Plan 读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async refreshWorkflowSnapshot(): Promise<WorkflowSnapshot | undefined> {
    if (!this.options.workflowAdapter) return undefined;
    const snapshot = await this.options.workflowAdapter.snapshot();
    this.panels.setWorkflowSnapshot(snapshot);
    return snapshot;
  }

  private async refreshPromptPanel(): Promise<void> {
    const service = this.options.promptProfiles;
    if (!service) {
      this.panels.setPromptSnapshot({
        profiles: [],
        rules: [],
        resolved: { scope: "off", pinned: false, disabled: true },
        effectiveSegments: [],
      });
      return;
    }
    const snapshot = await service.load();
    this.promptProfileSnapshot = snapshot;
    const resolved = service.resolve(this.currentPromptIdentity());
    const runtimeSegments = this.backend.getEffectivePromptSegments?.() ?? this.effectivePromptSegments;
    this.panels.setPromptSnapshot({
      profiles: snapshot.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        family: profile.family,
        sourceType: profile.sourceType,
        evaluationStatus: profile.evaluationStatus,
        ...(profile.id === resolved.profileId ? { active: true } : {}),
      })),
      rules: promptPanelRules(snapshot),
      resolved: {
        ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
        scope: resolved.scope,
        pinned: Boolean(snapshot.session?.pin ?? snapshot.project?.pin ?? snapshot.global.pin),
        disabled: resolved.scope === "off",
      },
      effectiveSegments:
        runtimeSegments.length > 0
          ? structuredClone(runtimeSegments)
          : resolved.overlay
            ? [{ source: "profile", content: resolved.overlay }]
            : [],
    });
  }

  private async executePromptCommand(raw: string): Promise<void> {
    const [, operation, ...rest] = raw.trim().split(/\s+/);
    const service = this.options.promptProfiles;
    try {
      if (!service && !operation) {
        await this.refreshPromptPanel();
        this.panels.open("prompt");
        return;
      }
      if (!service) throw new Error("Prompt Profile service 未配置");
      if (operation === "import") {
        const path = rest.join(" ");
        if (!path) throw new Error("用法：/prompt import <schema-file>");
        await service.importFile(path, { scope: "session" });
        this.showNotice(`Prompt Profile 已从 ${path} 导入 Session`, "success");
      } else if (operation === "export") {
        const profileId = rest[0] ?? service.resolve(this.currentPromptIdentity()).profileId;
        if (!profileId) throw new Error("用法：/prompt export <profile-id>");
        const path = await service.writeExport(profileId);
        this.showNotice(`Prompt Profile 已导出到 ${path}`, "success");
      } else if (operation) {
        throw new Error("用法：/prompt [import <schema-file> | export <profile-id>]");
      }
      await this.refreshPromptPanel();
      this.panels.open("prompt");
    } catch (error) {
      this.showNotice(`Prompt Profile 操作失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private currentPromptIdentity(): ModelIdentity {
    return this.currentModelIdentity
      ? { provider: this.currentModelIdentity.provider, model: this.currentModelIdentity.id }
      : { provider: this.backend.modelProvider ?? "unknown", model: this.backend.modelId };
  }

  private async updatePromptSession(input: {
    pin?: string;
    disabled?: boolean;
    toggleRule?: {
      ruleId: string;
      ownerScope?: "global" | "project" | "session";
      enabled: boolean;
    };
  }): Promise<void> {
    try {
      const service = this.options.promptProfiles;
      if (!service) throw new Error("Prompt Profile service 未配置");
      const snapshot = this.promptProfileSnapshot ?? (await service.load());
      if (input.toggleRule) {
        const scope = input.toggleRule.ownerScope ?? findPromptRuleScope(snapshot, input.toggleRule.ruleId);
        if (!scope) throw new Error(`Prompt rule ${input.toggleRule.ruleId} 不存在`);
        const layer = scope === "session" ? snapshot.session : scope === "project" ? snapshot.project : snapshot.global;
        if (!layer?.rules.some((rule) => rule.id === input.toggleRule?.ruleId)) {
          throw new Error(`Prompt rule ${scope}/${input.toggleRule.ruleId} 不存在`);
        }
        await service.save(
          scope,
          {
            ...layer,
            rules: layer.rules.map((rule) =>
              rule.id === input.toggleRule?.ruleId ? { ...rule, enabled: input.toggleRule.enabled } : rule,
            ),
          },
          expectedHashOptions(snapshot.hashes[scope]),
        );
        await this.refreshPromptPanel();
        this.showNotice("Prompt Profile rule 已更新", "success");
        return;
      }
      const current = snapshot.session ?? {
        schemaVersion: 1 as const,
        source: "vspi.prompt-profile" as const,
        profiles: [],
        rules: [],
      };
      await service.save(
        "session",
        {
          ...current,
          rules: current.rules,
          ...(input.pin ? { pin: input.pin, disabled: false } : {}),
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        },
        expectedHashOptions(snapshot.hashes.session),
      );
      await this.refreshPromptPanel();
      this.showNotice("Prompt Profile 设置已更新", "success");
    } catch (error) {
      if (error instanceof Error && /expectedHash|conflict|stale/i.test(error.message)) {
        await this.refreshPromptPanel().catch(() => undefined);
      }
      this.showNotice(`Prompt Profile 更新失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async applyPlanEdit(event: Extract<PanelEvent, { type: "planEdit" }>): Promise<void> {
    if (!this.options.planBackend || !this.planSnapshot || this.planSnapshot.id !== event.planId) {
      this.showNotice("当前 Local Plan 已变化，请重新打开 Plan", "warning");
      return;
    }
    const plan = publicPlanInput(this.planSnapshot);
    const epoch = this.sessionEpoch;
    const bindingId = this.backend.getPlanBinding?.()?.planId;
    if (event.operation.kind === "status") {
      if (!updateItemStatus(plan.items, event.operation.itemId, event.operation.status)) {
        this.showNotice("Plan work item 不存在", "error");
        return;
      }
    } else if (event.operation.kind === "focus") {
      plan.focusItemId = event.operation.itemId;
    } else {
      plan.nextAction = event.operation.value;
    }
    try {
      const updated = await this.options.planBackend.update(event.planId, {
        expectedRevision: event.expectedRevision,
        plan,
      });
      if (
        epoch !== this.sessionEpoch ||
        this.backend.getPlanBinding?.()?.planId !== bindingId ||
        bindingId !== event.planId
      ) {
        await this.refreshPlanSnapshot(this.sessionEpoch);
        return;
      }
      this.planSnapshot = structuredClone(updated);
      this.panels.setPlanSnapshot(updated);
      this.showNotice(`Local Plan 已更新到 r${updated.revision}`, "success");
    } catch (error) {
      this.showNotice(`Local Plan 更新失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      await this.refreshPlanSnapshot(this.sessionEpoch);
    }
  }

  private requestQuestions(questions: Question[], signal?: AbortSignal): Promise<Question[]> {
    if (this.pendingQuestion) return Promise.reject(new Error("Another Question is already active"));
    return new Promise<Question[]>((resolve, reject) => {
      const abort = () => {
        if (!this.pendingQuestion) return;
        this.pendingQuestion = undefined;
        this.panels.close();
        const error = new Error("Question cancelled");
        error.name = "AbortError";
        reject(error);
        this.requestRender();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pendingQuestion = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      this.panels.openQuestions(questions);
      this.requestRender();
      if (signal?.aborted) abort();
    });
  }

  private async confirmSessionCollision(session: SessionOption): Promise<"takeover" | "fork" | "cancel"> {
    const owner = session.owner;
    if (!owner) return "takeover";
    const [answered] = await this.requestQuestions([
      {
        id: `session-owner:${session.id}`,
        title: "Session 正在使用",
        prompt: `${owner.hostname} · PID ${owner.pid} 正在运行这个 Session。接管会等待当前任务和队列完成，不会中断。`,
        kind: "singleChoice",
        options: [
          { id: "takeover", label: "接管此会话", description: "默认；等待安全点后继续同一线程" },
          { id: "fork", label: "创建分支", description: "保留当前 owner，创建独立 Session" },
          { id: "cancel", label: "取消", description: "返回 Sessions，不改变任何进程" },
        ],
      },
    ]);
    return answered?.answer === "fork" ? "fork" : answered?.answer === "cancel" ? "cancel" : "takeover";
  }

  private cancelPendingQuestion(message: string): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = undefined;
    pending.cleanup();
    if (this.panels.kind === "question") this.panels.close();
    const error = new Error(message);
    error.name = "AbortError";
    pending.reject(error);
  }

  private requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse> {
    if (this.pendingApproval) return Promise.resolve({ type: "deny", reason: "Another approval is already active" });
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const abort = () => {
        if (!this.pendingApproval) return;
        this.pendingApproval = undefined;
        if (this.panels.kind === "approval") this.panels.close();
        const error = new Error("Approval cancelled");
        error.name = "AbortError";
        reject(error);
        this.requestRender();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pendingApproval = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      this.panels.openApproval(request);
      this.requestRender();
      if (signal?.aborted) abort();
    });
  }

  private cancelPendingApproval(message: string): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = undefined;
    pending.cleanup();
    if (this.panels.kind === "approval") this.panels.close();
    const error = new Error(message);
    error.name = "AbortError";
    pending.reject(error);
  }

  private async runProviderProbe(
    providerId: string,
    mode: "check-config" | "test-connection" | "minimal-generation",
    confirmCost?: () => Promise<boolean>,
  ): Promise<void> {
    try {
      if (!this.backend.runProviderProbe) throw new Error("当前后端不支持 Provider probe");
      const result = await this.backend.runProviderProbe(providerId, mode, confirmCost);
      this.showNotice(result.diagnostic, result.ok ? "success" : "error");
    } catch (error) {
      this.showNotice(`Provider probe 失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async persistRuntimeDefaults(): Promise<boolean> {
    if (!this.runtimeDefaults || this.backend.kind !== "pi") return true;
    try {
      await this.runtimeDefaults.save(this.options.settings.scope, {
        ...(this.currentModelIdentity ? { model: this.currentModelIdentity } : {}),
        effort: this.effort,
      });
      return true;
    } catch (error) {
      this.showNotice(
        `当前选择已生效，但默认配置未保存：${error instanceof Error ? error.message : "未知错误"}`,
        "warning",
      );
      return false;
    }
  }

  private async applyRuntimeDefaults(): Promise<void> {
    const defaults = await this.runtimeDefaults?.load();
    if (!defaults) return;
    const diagnostics = [...defaults.diagnostics];
    if (defaults.value.model && this.backend.kind === "pi") {
      const identity = `${defaults.value.model.provider}/${defaults.value.model.id}`;
      try {
        if (!this.backend.selectModel) throw new Error("当前后端不支持默认模型选择");
        await this.backend.selectModel(defaults.value.model.provider, defaults.value.model.id);
        this.currentModelIdentity = { ...defaults.value.model };
        this.modelLabel = this.backend.modelLabel;
        this.panels.confirmModelSelection(defaults.value.model);
      } catch (error) {
        diagnostics.push(
          `默认模型 ${identity} 当前不可用，已保留 ${this.modelLabel}：${error instanceof Error ? error.message : "未知错误"}`,
        );
      }
    }
    if (this.backend.setEffort) {
      try {
        const levels = await this.backend.getEffortOptions?.();
        if (levels && !levels.includes(defaults.value.effort)) {
          diagnostics.push(`默认 Effort ${effortLabel(defaults.value.effort)} 不受当前模型支持，已保留当前档位`);
        } else {
          await this.backend.setEffort(defaults.value.effort);
          this.effort = defaults.value.effort;
        }
      } catch (error) {
        diagnostics.push(`默认 Effort 未应用：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
    if (diagnostics.length > 0) {
      const diagnostic = diagnostics.slice(0, 2).join("；");
      if (this.renderReady) this.showNotice(diagnostic, "warning");
      else this.startupRuntimeDefaultsDiagnostic = diagnostic;
    }
  }

  private focusComposer(): void {
    this.workspaceFocus = "composer";
    this.panelFocused = false;
    this.inspectIndex = undefined;
    this.requestRender();
  }

  private focusPlan(): void {
    this.workspaceFocus = "plan";
    this.panelFocused = true;
    this.inspectIndex = undefined;
    this.requestRender();
  }

  private focusTranscript(): boolean {
    const nodes = buildTranscriptNodes(this.messages);
    if (nodes.length === 0) {
      this.showNotice("暂无消息，无法进入 Transcript", "info");
      return false;
    }

    this.workspaceFocus = "transcript";
    this.panelFocused = false;
    const selected =
      nodes.find((node) => node.id === this.inspectNodeId) ??
      nodes.find((node) => this.inspectIndex !== undefined && node.messageIndexes.includes(this.inspectIndex)) ??
      nodes.at(-1);
    if (!selected) return false;
    this.inspectNodeId = selected.id;
    const selectedToolIndex = selected.messageIndexes.find(
      (index) => this.messages[index]?.kind === "tool" && this.messages[index]?.id === this.inspectToolId,
    );
    if (selected.kind !== "toolGroup" || this.inspectDepth !== "tool" || selectedToolIndex === undefined) {
      this.inspectDepth = "node";
      this.inspectToolId = undefined;
      this.inspectIndex = selected.messageIndexes[0];
    } else {
      this.inspectIndex = selectedToolIndex;
    }
    this.requestRender();
    return true;
  }

  private cycleWorkspaceFocus(): void {
    if (this.workspaceFocus === "composer") {
      if (buildTranscriptNodes(this.messages).length > 0) this.focusTranscript();
      else this.focusPlan();
      return;
    }
    if (this.workspaceFocus === "transcript") {
      this.focusPlan();
      return;
    }
    this.focusComposer();
  }

  private handleInspectInput(data: string): void {
    if (matchesInteraction("composer", "main", "cancelOrExit", data)) {
      if (this.activityActive()) void this.cancelGeneration();
      else this.options.onExit();
      return;
    }
    const interaction = matchingInteraction("inspect", "transcript", data, this.inspectInteractionState());
    if (!interaction) return;
    if (interaction.handler === "closeInspect") {
      this.focusComposer();
      return;
    }
    if (interaction.handler === "cycleWorkspaceFocus") {
      this.focusPlan();
      return;
    }

    const nodes = buildTranscriptNodes(this.messages);
    const nodeIndex = nodes.findIndex((node) => node.id === this.inspectNodeId);
    const selectedNode = nodes[nodeIndex];
    if (!selectedNode) {
      this.focusTranscript();
      return;
    }

    if (this.inspectDepth === "tool" && selectedNode.kind === "toolGroup") {
      this.handleToolInspectInput(data, selectedNode);
      this.requestRender();
      return;
    }

    if (interaction.handler === "moveInspect") {
      const offset = matchesKey(data, Key.up) ? -1 : 1;
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, nodeIndex + offset))];
      if (next) {
        this.inspectNodeId = next.id;
        this.inspectToolId = undefined;
        this.inspectDepth = "node";
        this.inspectIndex = next.messageIndexes[0];
      }
    } else if (interaction.handler === "toggleInspectItem") {
      const message = this.messages[selectedNode.messageIndexes[0] ?? -1];
      if (selectedNode.kind === "toolGroup" && (matchesKey(data, Key.right) || matchesKey(data, Key.enter))) {
        const firstTool = selectedNode.messageIndexes
          .map((index) => this.messages[index])
          .find((candidate) => candidate?.kind === "tool");
        if (firstTool?.kind === "tool") {
          this.inspectDepth = "tool";
          this.inspectToolId = firstTool.id;
          this.inspectIndex = selectedNode.messageIndexes.find((index) => this.messages[index]?.id === firstTool.id);
        }
      } else if (message?.kind === "thinking") {
        if (matchesKey(data, Key.right)) message.collapsed = false;
        else if (matchesKey(data, Key.left)) message.collapsed = true;
        else if (matchesKey(data, Key.enter)) message.collapsed = !message.collapsed;
      }
    }
    this.requestRender();
  }

  private handleToolInspectInput(data: string, node: TranscriptNode): void {
    const toolIndexes = node.messageIndexes.filter((index) => this.messages[index]?.kind === "tool");
    if (toolIndexes.length === 0) {
      this.inspectDepth = "node";
      this.inspectToolId = undefined;
      this.inspectIndex = node.messageIndexes[0];
      return;
    }
    const currentIndex = Math.max(
      0,
      toolIndexes.findIndex((index) => this.messages[index]?.id === this.inspectToolId),
    );
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const offset = matchesKey(data, Key.up) ? -1 : 1;
      const nextIndex = toolIndexes[Math.max(0, Math.min(toolIndexes.length - 1, currentIndex + offset))];
      const next = this.messages[nextIndex ?? -1];
      if (next?.kind === "tool") {
        this.inspectToolId = next.id;
        this.inspectIndex = nextIndex;
      }
      return;
    }

    const messageIndex = toolIndexes[currentIndex];
    const message = this.messages[messageIndex ?? -1];
    if (message?.kind !== "tool") return;
    if (matchesKey(data, Key.right)) message.expanded = true;
    else if (matchesKey(data, Key.enter)) message.expanded = !message.expanded;
    else if (matchesKey(data, Key.left)) {
      if (message.expanded) message.expanded = false;
      else {
        this.inspectDepth = "node";
        this.inspectToolId = undefined;
        this.inspectIndex = node.messageIndexes[0];
      }
    }
  }

  private inspectInteractionState(): InteractionState {
    const nodes = buildTranscriptNodes(this.messages);
    const selectedNode = nodes.find((node) => node.id === this.inspectNodeId);
    const selected = this.messages[selectedNode?.messageIndexes[0] ?? -1];
    return {
      hasItems: nodes.length > 0,
      expandable: this.inspectDepth === "tool" || selectedNode?.kind === "toolGroup" || selected?.kind === "thinking",
      inspectDepth: this.inspectDepth,
    };
  }

  private withThinkingDisplayDefault(message: TranscriptMessage): TranscriptMessage {
    if (message.kind !== "thinking") return message;
    return { ...message, collapsed: this.options.settings.thinkingDisplay !== "expanded" };
  }

  private applyThinkingDisplay(mode: AppSettings["thinkingDisplay"]): void {
    for (const message of this.messages) {
      if (message.kind === "thinking") message.collapsed = mode !== "expanded";
    }
  }

  private async pasteAttachment(): Promise<void> {
    try {
      await this.options.attachments.pasteLocal();
    } catch (error) {
      this.showNotice(`图片粘贴失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async cancelGeneration(): Promise<void> {
    const submission = this.activeSubmission;
    if (submission) submission.cancelled = true;
    this.clearingQueue = true;
    let queuedMessages: string[] = [];
    try {
      const result = await this.backend.cancel();
      queuedMessages = result?.queuedMessages ?? [];
      this.showNotice(
        queuedMessages.length > 0
          ? `已中断当前运行，正在处理 ${queuedMessages.length} 条排队消息`
          : "已中断当前运行；Session、消息和部分输出已保留",
        "info",
      );
    } catch (error) {
      this.showNotice(`取消生成失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    } finally {
      this.clearingQueue = false;
      if (submission) this.finalizeCancelledSubmission(submission);
      else {
        this.setRunActive(false);
        this.setBusy(false);
      }
    }
    if (queuedMessages.length > 0) this.startInterruptedQueue(queuedMessages);
  }

  private settleQueuedMessages(delivery: "steer" | "followUp", count: number): void {
    if (count < 1) return;
    for (const message of this.messages) {
      if (count < 1) break;
      if (message.kind === "text" && message.role === "user" && message.delivery === delivery) {
        delete message.delivery;
        count -= 1;
      }
    }
  }

  private resetSessionState(): number {
    this.sessionEpoch += 1;
    this.cancelPendingQuestion("Question cancelled because the session changed");
    this.cancelPendingApproval("Approval cancelled because the session changed");
    if (this.activeSubmission) {
      this.activeSubmission.cancelled = true;
      this.activeSubmission.restored = true;
      this.activeSubmission = undefined;
    }
    this.messages = [];
    this.usage = DEFAULT_USAGE;
    this.queueState = { steering: 0, followUp: 0 };
    this.runActive = false;
    this.setBusy(false);
    this.workspaceFocus = "composer";
    this.panelFocused = false;
    this.inspectIndex = undefined;
    this.inspectNodeId = undefined;
    this.inspectToolId = undefined;
    this.inspectDepth = "node";
    this.nextBehavior = "prompt";
    this.pendingRouteSubmission = undefined;
    this.composer.restoreDraft("", []);
    this.preview = undefined;
    this.previewLabel = "";
    this.renameAttachmentId = undefined;
    this.renameInput = "";
    if (this.renderReady) this.tui.terminal.setProgress(false);
    this.requestRender();
    return this.sessionEpoch;
  }

  private async switchAttachmentSession(sessionId: string, epoch: number): Promise<void> {
    const switchSession = (this.options.attachments as Partial<Pick<AttachmentService, "switchSession">>).switchSession;
    if (!switchSession) return;
    try {
      await switchSession.call(this.options.attachments, sessionId);
      if (this.sessionEpoch !== epoch || this.attachmentSessionId !== sessionId) return;
      this.composer.restoreAttachments(this.options.attachments.store.list());
    } catch {
      if (this.sessionEpoch === epoch) this.showNotice("附件会话恢复失败", "error");
    }
  }

  private finalizeCancelledSubmission(submission: ActiveSubmission): void {
    if (submission.restored) return;
    submission.restored = true;
    this.setRunActive(false);
    this.setBusy(false);
  }

  private startInterruptedQueue(queuedMessages: string[]): void {
    const restoredAttachments: Attachment[] = [];
    const consumedMessageIds = new Set<string>();
    for (const queued of queuedMessages) {
      const message = this.messages.find(
        (candidate) =>
          candidate.kind === "text" &&
          candidate.role === "user" &&
          (candidate.delivery === "steer" || candidate.delivery === "followUp") &&
          !consumedMessageIds.has(candidate.id) &&
          queued === candidate.text,
      );
      if (message?.kind === "text") {
        consumedMessageIds.add(message.id);
        restoredAttachments.push(...(message.attachments ?? []));
      }
    }
    this.messages = this.messages.filter((message) => !consumedMessageIds.has(message.id));
    const attachments = restoredAttachments.filter(
      (attachment, index, all) => all.findIndex((candidate) => candidate.id === attachment.id) === index,
    );
    this.queueState = { steering: 0, followUp: 0 };
    this.syncActivityPresentation();
    void this.sendInterruptedQueue(queuedMessages.join("\n\n"), attachments);
  }

  private async sendInterruptedQueue(text: string, attachments: Attachment[]): Promise<void> {
    const transcriptLength = this.messages.length;
    const messageId = randomUUID();
    this.messages.push({ id: messageId, role: "user", kind: "text", text, attachments });
    const submission: ActiveSubmission = {
      id: ++this.submissionId,
      raw: text,
      attachments,
      transcriptLength,
      cancelled: false,
      restored: false,
    };
    this.activeSubmission = submission;
    this.setRunActive(true);
    this.requestRender();
    try {
      const result = await this.backend.send(text, { attachments, effort: this.effort, behavior: "prompt" });
      if (submission.cancelled || result?.status === "cancelled") {
        this.finalizeCancelledSubmission(submission);
        return;
      }
      this.modelLabel = this.backend.modelLabel;
      this.composer.editor.addToHistory(text);
    } catch (error) {
      if (submission.cancelled) {
        this.finalizeCancelledSubmission(submission);
        return;
      }
      this.setBusy(false);
      this.messages.splice(transcriptLength);
      const currentDraft = this.composer.getText().trim();
      const restoredAttachments = [...attachments, ...this.composer.attachments].filter(
        (attachment, index, all) => all.findIndex((candidate) => candidate.id === attachment.id) === index,
      );
      this.composer.restoreDraft([text, currentDraft].filter(Boolean).join("\n\n"), restoredAttachments);
      this.showNotice(error instanceof Error ? error.message : "排队消息重新发送失败", "error");
    } finally {
      if (this.activeSubmission?.id === submission.id) this.activeSubmission = undefined;
      if (!submission.cancelled) this.setRunActive(false);
    }
  }

  private async removeAttachment(id: string): Promise<void> {
    try {
      await this.options.attachments.remove(id);
    } catch (error) {
      this.showNotice(`附件移除失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private handleRenameInput(data: string): void {
    if (matchesInteraction("composer", "main", "cancelOrExit", data)) {
      if (this.activityActive()) void this.cancelGeneration();
      else this.options.onExit();
      return;
    }
    const interaction = matchingInteraction("composer", "rename", data);
    if (!interaction) return;
    if (interaction.handler === "cancelRename") {
      this.renameAttachmentId = undefined;
      this.renameInput = "";
      this.requestRender();
      return;
    }
    if (interaction.handler === "deleteRenameCharacter") {
      this.renameInput = Array.from(this.renameInput).slice(0, -1).join("");
      this.requestRender();
      return;
    }
    if (interaction.handler === "commitRename") {
      const id = this.renameAttachmentId;
      if (id) void this.commitAttachmentRename(id);
      return;
    }
    if (!data.includes("\u001b")) {
      const characters = Array.from(data).filter((character) => (character.codePointAt(0) ?? 0) >= 32);
      this.renameInput = Array.from(`${this.renameInput}${characters.join("")}`)
        .slice(0, 200)
        .join("");
      this.requestRender();
    }
  }

  private async commitAttachmentRename(id: string): Promise<void> {
    try {
      const attachment = await this.options.attachments.rename(id, this.renameInput);
      this.composer.updateAttachment(attachment);
      this.showNotice(`已重命名为 ${attachment.alias}`, "success");
    } catch (error) {
      this.showNotice(`重命名失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    } finally {
      this.renameAttachmentId = undefined;
      this.renameInput = "";
      this.requestRender();
    }
  }

  private async previewAttachment(id: string, label: string): Promise<void> {
    try {
      this.preview = await this.options.attachments.preview(id);
      this.previewLabel = label;
      this.requestRender();
    } catch (error) {
      this.showNotice(`预览失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async saveAttachment(id: string): Promise<void> {
    try {
      const path = await this.options.attachments.saveToProject(id, this.options.cwd);
      this.showNotice(`已保存到 ${path}`, "success");
    } catch (error) {
      this.showNotice(`保存失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private requestRender(force = false): void {
    if (this.renderReady) this.tui.requestRender(force);
  }
}

function parseNewSessionOptions(raw: string): NewSessionOptions {
  const arguments_ = raw.trim().split(/\s+/).slice(1);
  return {
    defaults: arguments_.includes("--default"),
    continuePlan: arguments_.includes("--continue"),
  };
}

function parseCompactOptions(raw: string): CompactOptions | "list" | undefined {
  const [, profile, ...rest] = raw.trim().split(/\s+/);
  if (!profile) return undefined;
  if (profile === "--list" || profile === "list") return "list";
  if (profile === "native" || profile === "pi-native") return { profile: "pi-native" };
  if (profile === "continuity" || profile === "execution-continuity") return { profile: "execution-continuity" };
  if (profile === "research" || profile === "research-decisions") return { profile: "research-decisions" };
  if (profile === "custom") {
    const customInstructions = rest.join(" ").trim();
    if (!customInstructions) throw new Error("用法：/compact custom <instructions>");
    return { profile: "custom", customInstructions };
  }
  throw new Error("用法：/compact [--list | native | continuity | research | custom <instructions>]");
}

function publicPlanInput(plan: StoredPlan): PlanInput & { archived: boolean } {
  return {
    title: plan.title,
    goal: plan.goal,
    ...(plan.background === undefined ? {} : { background: plan.background }),
    challenges: structuredClone(plan.challenges),
    items: structuredClone(plan.items),
    ...(plan.focusItemId === undefined ? {} : { focusItemId: plan.focusItemId }),
    blockers: structuredClone(plan.blockers),
    ...(plan.nextAction === undefined ? {} : { nextAction: plan.nextAction }),
    archived: plan.archived,
  };
}

function updateItemStatus(items: PlanInput["items"], itemId: string, status: PlanStatus): boolean {
  for (const item of items) {
    if (item.id === itemId) {
      item.status = status;
      return true;
    }
    if (item.children && updateItemStatus(item.children, itemId, status)) return true;
  }
  return false;
}

function promptRuleLabel(rule: PromptProfileRule): string {
  const match = rule.match.model ?? rule.match.provider ?? rule.match.family ?? "all";
  return `${match} -> ${rule.profileId}`;
}

function promptPanelRules(snapshot: PromptProfileSnapshot): Array<{
  id: string;
  label: string;
  enabled: boolean;
  ownerScope: "global" | "project" | "session";
}> {
  return (
    [
      ["global", snapshot.global],
      ["project", snapshot.project],
      ["session", snapshot.session],
    ] as const
  ).flatMap(([ownerScope, config]) =>
    (config?.rules ?? []).map((rule) => ({
      id: rule.id,
      label: promptRuleLabel(rule),
      enabled: rule.enabled,
      ownerScope,
    })),
  );
}

function expectedHashOptions(expectedHash: string | undefined): { expectedHash?: string } {
  return expectedHash === undefined ? {} : { expectedHash };
}

function findPromptRuleScope(
  snapshot: PromptProfileSnapshot,
  ruleId: string,
): "global" | "project" | "session" | undefined {
  if (snapshot.session?.rules.some((rule) => rule.id === ruleId)) return "session";
  if (snapshot.project?.rules.some((rule) => rule.id === ruleId)) return "project";
  if (snapshot.global.rules.some((rule) => rule.id === ruleId)) return "global";
  return undefined;
}

async function waitForShutdownCancellation(cancellation: Promise<unknown>, timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
