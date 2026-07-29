import { randomUUID } from "node:crypto";
import { type Component, type Focusable, Input, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { AttachmentService } from "../attachments/service.js";
import type {
  ChatBackend,
  ChatQueueState,
  ModelSelectionResult,
  NewSessionOptions,
  RuntimeModelOption,
  SessionHandoffInteraction,
  SessionHandoffProjection,
  SessionHandoffRelay,
  SessionHandoffResponse,
} from "../backend/types.js";
import { loadSettingsLayers, saveSettings } from "../config/settings.js";
import { COMPACTION_PROFILES, type CompactOptions } from "../continuity/compaction-profiles.js";
import {
  type ActionDefinition,
  type ActionHandler,
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
import { UserQuestionCancelledError } from "../questions/tool.js";
import type { ExternalSessionSource } from "../sessions/external-history.js";
import { normalizeSkillInstallSource } from "../skills/service.js";
import type { SkillCatalogItem, SkillScope } from "../skills/types.js";
import {
  HttpThinkingTranslator,
  normalizeTranslationEndpoint,
  type ThinkingTranslator,
} from "../translation/thinking-translator.js";
import { renderActivityRail, renderQueuedMessage } from "../ui/activity.js";
import { padLine } from "../ui/ansi.js";
import { AuthDialog } from "../ui/auth-dialog.js";
import { Composer, type ComposerActivity } from "../ui/composer.js";
import {
  type InteractionState,
  matchesInteraction,
  matchingInteraction,
  renderInteractionHint,
} from "../ui/interactions.js";
import { PanelController, type PanelEvent } from "../ui/panels.js";
import type { StartupStatus } from "../ui/splash.js";
import { renderStatusLines } from "../ui/status.js";
import type { VspiTheme } from "../ui/theme.js";
import {
  buildTranscriptNodes,
  isQueuedTranscriptMessage,
  renderTranscript,
  selectTranscriptWindow,
  type TranscriptNode,
  TranscriptRenderCache,
  type TranscriptWindow,
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
  thinkingTranslator?: ThinkingTranslator;
  openOnStart?: "sessions" | "providers";
  onForegroundRelinquish?: () => void;
  onForegroundResume?: () => void;
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

const BUSY_SAFE_ACTIONS = new Set<ActionHandler>([
  "models",
  "effort",
  "policy",
  "settings",
  "thinkingSettings",
  "theme",
  "usage",
  "tools",
  "plan",
]);

interface ActiveSubmission {
  id: number;
  raw: string;
  attachments: Attachment[];
  transcriptLength: number;
  cancelled: boolean;
  restored: boolean;
}

interface PendingQuestion {
  questions: Question[];
  relaying: boolean;
  ownedByRoute: boolean;
  resolve(questions: Question[]): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface PendingApproval {
  request: ApprovalRequest;
  relaying: boolean;
  resolve(response: ApprovalResponse): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class VspiApp implements Component, Focusable {
  readonly composer: Composer;
  private tui: TUI;
  private messages: TranscriptMessage[] = [];
  private committedMessageCount = 0;
  private activityPresentationActive = false;
  private readonly panels: PanelController;
  private usage: UsageSnapshot = DEFAULT_USAGE;
  private effort: EffortLevel = "medium";
  private modelLabel: string;
  private pendingModelLabel: string | undefined;
  private busy = false;
  private runActive = false;
  private queueState: ChatQueueState = { steering: 0, followUp: 0 };
  private clearingQueue = false;
  private workingFrame = 0;
  private workingStartedAt: number | undefined;
  private workingTimer: NodeJS.Timeout | undefined;
  private workingTimerInterval: number | undefined;
  private workspaceFocus: "composer" | "transcript" | "plan" = "composer";
  private panelFocused = false;
  private inspectIndex: number | undefined;
  private inspectNodeId: string | undefined;
  private inspectToolId: string | undefined;
  private inspectDepth: "node" | "tool" = "node";
  private transcriptStartNodeId: string | undefined;
  private nextBehavior: "prompt" | "followUp" = "prompt";
  private renameAttachmentId: string | undefined;
  private renameInput = "";
  private readonly renameField = new Input();
  private preview: Component | undefined;
  private previewLabel = "";
  private notice: { text: string; tone: NoticeTone; progress: boolean } | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private _focused = false;
  private renderReady = false;
  private submissionId = 0;
  private activeSubmission: ActiveSubmission | undefined;
  private disposing = false;
  private sessionHandoffPending = false;
  private sessionHandoffRelay: SessionHandoffRelay | undefined;
  private foregroundRelinquished = false;
  private handoffSnapshotQueued: TranscriptMessage[] = [];
  private startupShellReady = false;
  private backendSessionReady = false;
  private runtimeSurfacePromise: Promise<void> | undefined;
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
  private planRefreshSequence = 0;
  private planPanelExplicit = false;
  private promptProfileSnapshot: PromptProfileSnapshot | undefined;
  private effectivePromptSegments: EffectivePromptSegment[] = [];
  private readonly transcriptRenderCache = new TranscriptRenderCache();
  private readonly thinkingTranslator: ThinkingTranslator;
  private thinkingTranslationQueue: Promise<void> = Promise.resolve();
  private thinkingTranslationAbort: AbortController | undefined;
  private thinkingTranslationRevision = 0;
  private readonly translatedThinkingSources = new Map<string, string>();

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
    this.thinkingTranslator = options.thinkingTranslator ?? new HttpThinkingTranslator();
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
          if (index >= 0 && current) {
            const next = { ...current, ...patch } as TranscriptMessage;
            this.messages[index] = next;
            if (
              current.kind === "thinking" &&
              next.kind === "thinking" &&
              current.streaming &&
              next.streaming === false
            ) {
              this.queueThinkingTranslation(id);
            }
          }
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
        onWorkflowSnapshot: (snapshot) => {
          if (!this.options.workflowAdapter) return;
          this.panels.setWorkflowSnapshot(snapshot);
          this.requestRender();
        },
        onSessionWait: (waiting) => {
          this.setRunActive(waiting);
        },
        onSessionReady: () => {
          this.backendSessionReady = true;
          if (this.startupShellReady)
            void this.initializeRuntimeSurface().catch((error) => this.handleRuntimeError(error));
        },
        onSessionError: (error) => this.handleRuntimeError(error),
        onHandoffInteraction: (interaction, signal) => this.answerHandoffInteraction(interaction, signal),
        onHandoffProjection: (projection) => this.applyHandoffProjection(projection),
        onHandoffPending: (relay) => this.beginSessionHandoff(relay),
        onHandoffCancelled: () => this.cancelSessionHandoff(),
        onTakeover: () => {
          if (!this.foregroundRelinquished) {
            this.messages.push({
              id: `session-handoff:${Date.now()}`,
              role: "assistant",
              kind: "session",
              text: "Session 已移交到新终端；此终端已退出。",
            });
            this.showNotice("Session 已移交；当前终端退出", "info");
            this.requestRender(true);
          }
          setImmediate(() => this.options.onExit());
        },
        onSessionInvalidating: () => {
          this.cancelPendingQuestion("Question cancelled because the session changed");
          this.cancelPendingApproval("Approval cancelled because the session changed");
        },
        onSessionReset: (session) => {
          this.sessionTransition = false;
          this.sessionHandoffPending = false;
          this.sessionHandoffRelay = undefined;
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
      this.renderReady = true;
      this.startupShellReady = true;
      this.backendSessionReady = this.backend.isSessionReady?.() ?? true;
      if (this.backendSessionReady) await this.initializeRuntimeSurface();
      await this.refreshPlanSnapshot(this.sessionEpoch);
      await this.refreshWorkflowSnapshot();
      this.queueVisibleThinkingTranslations();
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

  private initializeRuntimeSurface(): Promise<void> {
    if (this.runtimeSurfacePromise) return this.runtimeSurfacePromise;
    this.runtimeSurfacePromise = (async () => {
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
      if (catalog && catalog.diagnostics.length > 0) {
        this.showNotice(catalog.diagnostics[0] ?? "Provider 配置诊断", "warning");
      }
      this.currentModelIdentity = backendModelIdentity;
      this.runtimeDefaults = this.options.runtimeDefaultsFactory?.(this.backend.isProjectTrusted?.() ?? false);
      await this.applyRuntimeDefaults();
      if (this.attachmentSessionId) await this.switchAttachmentSession(this.attachmentSessionId, this.sessionEpoch);
      if (this.startupRuntimeDefaultsDiagnostic) {
        const diagnostic = this.startupRuntimeDefaultsDiagnostic;
        this.startupRuntimeDefaultsDiagnostic = undefined;
        this.showNotice(diagnostic, "warning");
      }
      this.requestRender();
    })();
    return this.runtimeSurfacePromise;
  }

  private handleRuntimeError(error: unknown): void {
    this.setRunActive(false);
    this.showNotice(`Session 接管失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
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
    this.thinkingTranslationRevision += 1;
    this.thinkingTranslationAbort?.abort();
    this.thinkingTranslationAbort = undefined;
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
    if (this.sessionHandoffPending) {
      this.showNotice("Session 正在移交；请在新终端继续", "info");
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
    // Modal panels own their complete keyspace. Composer Tab completion/Inspect navigation
    // must never preempt Question direct-answer, Approval, or settings controls.
    if (this.panels.kind !== "plan" && this.panels.kind !== "commands") {
      this.handlePanelInput(data);
      return;
    }
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
        this.renameField.setValue(this.renameInput);
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
    if (this.panels.kind === "commands" && this.panels.acceptsInput(data)) {
      this.handlePanelInput(data);
      return;
    }
    if (this.panels.kind === "plan" && this.panelFocused) {
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
    if (matchesKey(data, Key.pageUp) && this.focusTranscript()) {
      this.handleInspectInput(data);
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
    if (this.panels.kind === "sessions") {
      const status = this.renderStatus(width);
      const notice = this.notice ? [this.renderNotice(width)] : [];
      const terminalRows = Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows : 24;
      // Keep one physical row free. A first TUI render starts immediately after the
      // persisted Splash, and an exact-height surface can scroll its title offscreen
      // on terminals that commit a pending bottom-margin wrap.
      const availableRows = Math.max(3, terminalRows - status.length - notice.length - 1);
      const surfaceRows = this.panels.sessionsSurfaceHeight(availableRows);
      const surface = this.panels.renderSessionsSurface(width, surfaceRows, this.theme);
      const padding = Math.max(0, terminalRows - surface.length - notice.length - status.length - 1);
      return [...surface, ...Array.from({ length: padding }, () => padLine("", width)), ...notice, ...status];
    }
    const transcriptFocused = this.workspaceFocus === "transcript";
    const activityActive = this.activityActive();
    const composer = this.composer.render(width, activityActive ? this.composerActivity() : undefined);
    const activity =
      activityActive && this.options.settings.workingStyle === 1
        ? [
            renderActivityRail(
              {
                indicator: this.activityReducedMotion()
                  ? this.theme.capabilities.unicode
                    ? "■"
                    : "*"
                  : this.theme.capabilities.unicode
                    ? this.workingFrame % 2 === 0
                      ? "■"
                      : "□"
                    : this.workingFrame % 2 === 0
                      ? "*"
                      : "+",
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
    const planSurfaceVisible =
      !transcriptFocused && (this.panels.kind !== "plan" || this.panels.hasPlanContent() || this.planPanelExplicit);
    const panelRows = this.panelRowBudget(composer.length, activity.length, queuedMessages.length, status.length);
    const previewLines = this.preview?.render(width);
    // The transcript gets only the rows left over after every other surface. Keeping the
    // whole frame within the visible viewport guarantees pi-tui's differential renderer
    // can always reach changed lines; a taller frame would force full redraws that clear
    // the screen (and native scrollback) whenever an early line changes.
    const reserved = previewLines ? previewLines.length + 1 : (planSurfaceVisible ? panelRows : 0) + 1; // hint/notice row
    const terminalRows = Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows : 24;
    const transcriptRows = Math.max(
      3,
      terminalRows - composer.length - activity.length - queuedMessages.length - status.length - reserved - 3,
    );
    const transcriptWindow = this.currentTranscriptWindow(width, transcriptRows);
    const output = renderTranscript(transcriptWindow.messages, width, this.theme, {
      ...(transcriptFocused && this.inspectNodeId ? { selectedNodeId: this.inspectNodeId } : {}),
      ...(transcriptFocused && this.inspectDepth === "tool" && this.inspectToolId
        ? { selectedToolId: this.inspectToolId }
        : {}),
      thinkingDisplay: this.options.settings.thinkingDisplay,
      wrapCode: this.options.settings.wrapCode,
      collapseCompletedTools: this.options.settings.collapseTools,
      cache: this.transcriptRenderCache,
    });
    if (output.length > 0) output.push("");
    if (previewLines) {
      output.push(...previewLines);
      output.push(this.notice ? this.renderNotice(width) : this.theme.muted(padLine(this.previewLabel, width)));
    } else {
      if (planSurfaceVisible) {
        output.push(...this.panels.render(width, panelRows, this.theme, this.usage, this.panelFocused));
      }
      const hint = this.notice
        ? this.renderNotice(width)
        : transcriptFocused
          ? this.theme.muted(padLine(this.renderInspectHint(), width))
          : planSurfaceVisible
            ? this.renderPanelHint(width)
            : undefined;
      if (hint !== undefined) output.push(hint);
    }
    output.push(...activity);
    output.push(...queuedMessages);
    output.push(...composer);
    output.push(...status);
    if (this.workspaceFocus !== "transcript" && this.supportsStaticTranscript()) {
      const padding = Math.max(0, terminalRows - output.length - 1);
      if (padding > 0) output.unshift(...Array.from({ length: padding }, () => ""));
    }
    return output;
  }

  commitStableTranscript(): number {
    const commit = (this.tui as TUI & { commitStatic?: (lines: readonly string[]) => void }).commitStatic;
    if (!commit) return 0;
    let end = this.committedMessageCount;
    while (end < this.messages.length) {
      const message = this.messages[end];
      if (!message || isQueuedTranscriptMessage(message) || ("streaming" in message && message.streaming === true))
        break;
      end += 1;
    }
    if (end <= this.committedMessageCount) return 0;
    const messages = this.messages.slice(this.committedMessageCount, end);
    const lines = renderTranscript(messages, Math.max(1, this.tui.terminal.columns), this.theme, {
      thinkingDisplay: this.options.settings.thinkingDisplay,
      wrapCode: this.options.settings.wrapCode,
      collapseCompletedTools: this.options.settings.collapseTools,
      cache: this.transcriptRenderCache,
    });
    if (lines.length === 0) return 0;
    const committed = end - this.committedMessageCount;
    this.committedMessageCount = end;
    commit.call(this.tui, [...lines, ""]);
    return committed;
  }

  private supportsStaticTranscript(): boolean {
    return typeof (this.tui as TUI & { commitStatic?: unknown }).commitStatic === "function";
  }

  private panelRowBudget(composerRows: number, activityRows: number, queuedRows: number, statusRows: number): number {
    if (this.panels.kind === "approval") {
      return Math.min(
        14,
        Math.max(3, this.tui.terminal.rows - composerRows - activityRows - queuedRows - statusRows - 6),
      );
    }
    if (this.tui.terminal.rows <= 24) {
      return Math.max(3, (this.panels.kind === "models" ? 10 : 9) - activityRows - queuedRows - (statusRows - 1));
    }
    return Math.min(
      16,
      Math.max(3, this.tui.terminal.rows - composerRows - activityRows - queuedRows - 7 - statusRows),
    );
  }

  invalidate(): void {
    this.composer.invalidate();
  }

  private renderPanelHint(width: number): string | undefined {
    if (this.panels.kind === "plan" && !this.panelFocused) {
      return this.theme.muted(padLine(renderInteractionHint("panel", "plan", {}), width));
    }
    if (this.panels.hintRenderedInline()) return undefined;
    return this.panels.renderHint(width, this.theme);
  }

  private renderInspectHint(): string {
    const hint = renderInteractionHint("inspect", "transcript", this.inspectInteractionState());
    return this.panels.hasPlanContent() ? hint : hint.replace("Shift+Tab 进入 Plan", "Shift+Tab 返回输入");
  }

  private async submit(raw: string, options?: { skipPlanRoute?: boolean }): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const queuedDuringWork = this.activityActive();
    const behavior = this.nextBehavior;
    this.nextBehavior = "prompt";
    if (text.startsWith("/")) {
      const command = resolveCommand(text);
      if (!command) {
        this.showNotice(`未知命令：${text.split(/\s+/, 1)[0]}`, "error");
        return;
      }
      const action = getActionDefinition(command);
      if (queuedDuringWork && (!action?.handler || !BUSY_SAFE_ACTIONS.has(action.handler))) {
        this.showNotice("该命令需等待当前任务结束；Model、Effort、Policy 与界面设置可立即调整", "info");
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
        const result = await this.backend.send(text, {
          attachments,
          effort: this.effort,
          behavior,
          clientMessageId: messageId,
        });
        this.composer.editor.addToHistory(text);
        if (result?.status !== "queued") {
          // The backend was already idle despite the app's busy view: it started a new prompt.
          // Reconcile presentation with the backend's authoritative decision instead of leaving
          // the message stuck in the queued lane forever.
          const settled = this.messages.find((message) => message.id === messageId);
          if (settled?.kind === "text") delete settled.delivery;
        } else {
          const mode = result?.delivery ?? delivery;
          const queuedMessage = this.messages.find((message) => message.id === messageId);
          if (queuedMessage?.kind === "text" && mode) queuedMessage.delivery = mode;
          this.showNotice(
            mode === "followUp" ? "已加入 Follow-up，将在当前任务完成后继续" : "已插入，将在下一次模型调用前送达",
            "success",
          );
        }
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
      const result = await this.backend.send(text, {
        attachments,
        effort: this.effort,
        behavior,
        clientMessageId: messageId,
      });
      if (submission.cancelled || result?.status === "cancelled") {
        this.finalizeCancelledSubmission(submission);
        return;
      }
      if (result?.status === "queued") {
        // The backend was still streaming although the app already saw an idle boundary
        // (agent_end precedes Pi's final settle). Adopt the backend's authoritative decision:
        // present the message in the queued lane so its lifecycle matches what the model sees.
        const queuedMessage = this.messages.find((message) => message.id === messageId);
        if (queuedMessage?.kind === "text") queuedMessage.delivery = result.delivery ?? "steer";
        this.composer.editor.addToHistory(text);
        this.showNotice(
          (result.delivery ?? "steer") === "followUp"
            ? "已加入 Follow-up，将在当前任务完成后继续"
            : "已插入，将在下一次模型调用前送达",
          "success",
        );
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
        modelLabel: this.pendingModelLabel ? `Next ${this.pendingModelLabel}` : this.modelLabel,
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
    const icon = this.theme.capabilities.unicode
      ? this.notice.progress
        ? "◌"
        : this.notice.tone === "error"
          ? "×"
          : this.notice.tone === "warning"
            ? "!"
            : this.notice.tone === "success"
              ? "✓"
              : "i"
      : this.notice.progress
        ? "..."
        : this.notice.tone === "error"
          ? "x"
          : this.notice.tone === "warning"
            ? "!"
            : this.notice.tone === "success"
              ? "+"
              : "i";
    return this.theme.noticeSurface(padLine(` ${style(icon)} ${this.notice.text}`, width));
  }

  private showNotice(text: string, tone: NoticeTone): void {
    this.setNotice(text, tone, false);
  }

  private showProgress(text: string): void {
    this.setNotice(text, "info", true);
  }

  private clearNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.notice = undefined;
    this.requestRender();
  }

  private setNotice(text: string, tone: NoticeTone, progress: boolean): void {
    this.notice = { text, tone, progress };
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    if (!progress) {
      this.noticeTimer = setTimeout(() => {
        this.notice = undefined;
        this.noticeTimer = undefined;
        this.requestRender();
      }, 3_500);
    }
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

  private activityReducedMotion(): boolean {
    return this.options.settings.reducedMotion;
  }

  private composerActivity(): ComposerActivity | undefined {
    const style = this.options.settings.workingStyle;
    if (style === 1 || !this.activityActive()) return undefined;
    return {
      style,
      frame: this.workingFrame,
      elapsedSeconds: this.workingStartedAt === undefined ? 0 : (Date.now() - this.workingStartedAt) / 1_000,
      reducedMotion: this.activityReducedMotion(),
    };
  }

  private syncActivityPresentation(): void {
    const active = this.activityActive();
    const completedActivity = this.activityPresentationActive && !active;
    this.activityPresentationActive = active;
    const reducedMotion = this.activityReducedMotion();
    const timerInterval = reducedMotion ? (this.options.settings.workingStyle === 1 ? undefined : 1_000) : 240;
    if (active && this.workingStartedAt === undefined) this.workingStartedAt = Date.now();
    if (active && timerInterval !== undefined && (!this.workingTimer || this.workingTimerInterval !== timerInterval)) {
      if (this.workingTimer) clearInterval(this.workingTimer);
      this.workingTimerInterval = timerInterval;
      this.workingTimer = setInterval(() => {
        if (!this.activityReducedMotion()) this.workingFrame = (this.workingFrame + 1) % 24;
        this.requestRender();
      }, timerInterval);
      this.workingTimer.unref();
    } else if ((!active || timerInterval === undefined) && this.workingTimer) {
      clearInterval(this.workingTimer);
      this.workingTimer = undefined;
      this.workingTimerInterval = undefined;
    }
    if (!active) {
      this.workingStartedAt = undefined;
      this.workingFrame = 0;
      this.pendingModelLabel = undefined;
    }
    if (completedActivity) this.commitStableTranscript();
    if (this.renderReady) this.tui.terminal.setProgress(active);
    this.requestRender();
  }

  private completeOneShotPanel(): void {
    this.panels.close();
    this.focusComposer();
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
    if (action.handler !== "plan") this.planPanelExplicit = false;
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
        this.completeOneShotPanel();
        this.requestRender(true);
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
        this.composer.setText("");
        this.panels.close();
      } catch (error) {
        this.composer.setText(raw);
        this.showNotice(`上下文压缩失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "update") {
      this.panels.close();
      this.showProgress("正在检查 VSPi 更新…");
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
      this.planPanelExplicit = true;
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
    } else if (action.handler === "externalImport") {
      try {
        if (!this.backend.listExternalSessions) throw new Error("当前后端不支持外部会话导入");
        const source = parseExternalImportSource(raw);
        this.showProgress("正在扫描 Codex 与 Claude Code 历史…");
        const sessions = await this.backend.listExternalSessions({ limit: 5_000 });
        this.panels.setExternalSessions(sessions, source);
        this.panels.open("externalImport");
        this.showNotice(`已载入 ${sessions.length} 个外部会话`, "success");
      } catch (error) {
        this.showNotice(`外部会话读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (action.handler === "skills") {
      try {
        if (!this.backend.listSkills) throw new Error("当前后端不支持 Skill 管理");
        this.showProgress("正在读取 Pi、Codex 与 Claude Code Skill…");
        const catalog = await this.backend.listSkills();
        this.panels.setSkillCatalog(catalog);
        this.panels.open("skills");
        this.showNotice(`已载入 ${catalog.items.length} 个 Skill`, "success");
      } catch (error) {
        this.showNotice(`Skill 读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
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
      if (this.pendingQuestion) this.cancelPendingQuestion("Question cancelled by user", { userInitiated: true });
      if (this.pendingRouteSubmission) {
        this.composer.setText(this.pendingRouteSubmission.raw);
        this.pendingRouteSubmission = undefined;
      }
    } else if (event.type === "command") {
      this.composer.setText("");
      await this.executeCommand(event.command, event.command.label);
    } else if (event.type === "model") {
      const switchingDuringActivity = this.activityActive();
      try {
        if (!this.backend.selectModel || !event.model.provider) throw new Error("该模型缺少 runtime Provider identity");
        const selected = await this.backend.selectModel(event.model.provider, event.model.id);
        this.modelLabel = this.backend.modelLabel;
        if (switchingDuringActivity && this.activityActive()) this.pendingModelLabel = this.modelLabel;
        this.currentModelIdentity = { provider: event.model.provider, id: selected.modelId };
        this.effort = selected.effort;
        this.panels.confirmModelSelection({ provider: event.model.provider, id: selected.modelId });
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.completeOneShotPanel();
        if (defaultsSaved) {
          const threshold = Math.max(0, selected.contextWindow - 16_384);
          const needsCompaction = selected.contextWindow > 0 && (this.usage.contextTokens ?? 0) > threshold;
          this.showNotice(
            switchingDuringActivity
              ? needsCompaction
                ? `下一次模型调用将使用 ${this.modelLabel}；上下文超过目标安全阈值，将先自动压缩`
                : `下一次模型调用将使用 ${this.modelLabel} · Effort ${effortLabel(this.effort)}`
              : `模型已切换为 ${this.modelLabel} · Effort ${effortLabel(this.effort)}`,
            needsCompaction ? "warning" : "success",
          );
        }
      } catch (error) {
        this.showNotice(`模型切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "modelGroup") {
      const switchingDuringActivity = this.activityActive();
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
        if (switchingDuringActivity && this.activityActive()) this.pendingModelLabel = this.modelLabel;
        this.currentModelIdentity = { provider: model.provider, id: selected.modelId };
        this.effort = role.effort;
        this.panels.confirmModelSelection(this.currentModelIdentity);
        this.panels.confirmModelGroupSelection(event.group.id);
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.completeOneShotPanel();
        if (defaultsSaved)
          this.showNotice(
            switchingDuringActivity
              ? `下一次模型调用将使用模型组 ${event.group.label} · Effort ${effortLabel(this.effort)}`
              : `模型组已切换为 ${event.group.label} · Effort ${effortLabel(this.effort)}`,
            "success",
          );
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
            this.completeOneShotPanel();
            this.commitStableTranscript();
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
        this.completeOneShotPanel();
        this.commitStableTranscript();
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
        this.completeOneShotPanel();
        this.commitStableTranscript();
      } catch (error) {
        this.sessionTransition = false;
        this.showNotice(`会话分支失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "externalImport") {
      if (this.activityActive()) {
        this.showNotice("生成中，请等待完成后再导入会话", "warning");
        return;
      }
      try {
        if (!this.backend.previewExternalSession || !this.backend.importExternalSession) {
          throw new Error("当前后端不支持外部会话导入");
        }
        this.showProgress("正在读取外部会话的完整可见记录…");
        const preview = await this.backend.previewExternalSession(event.session.id);
        const contextWarning =
          this.usage.contextWindow > 0 && preview.estimatedTokens > this.usage.contextWindow * 0.8
            ? `导入内容超过当前 ${formatTokenEstimate(this.usage.contextWindow)} 上下文的 80%，首次继续时可能触发压缩。`
            : undefined;
        const epoch = this.sessionEpoch;
        this.sessionTransition = true;
        await this.backend.importExternalSession(event.session.id, preview.fingerprint);
        if (this.sessionEpoch === epoch) this.sessionTransition = false;
        this.completeOneShotPanel();
        this.commitStableTranscript();
        if (contextWarning) this.showNotice(contextWarning, "warning");
        else this.showNotice("外部会话已导入", "success");
      } catch (error) {
        this.sessionTransition = false;
        if (error instanceof Error && error.name === "AbortError") {
          this.clearNotice();
          return;
        }
        this.showNotice(`会话导入失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "skillInstall") {
      try {
        if (!this.backend.installSkill || !this.backend.listSkills) throw new Error("当前后端不支持 Skill 安装");
        const source = normalizeSkillInstallSource(event.source);
        const [answered] = await this.requestQuestions([
          {
            id: "skill-install",
            title: "安装 Skill",
            prompt: `${source}\nScope ${event.scope === "project" ? "Project" : "Global"}。只加载包内 Skill，extension、prompt 与 theme 保持禁用。`,
            kind: "singleChoice",
            options: [
              { id: "install-enable", label: "安装并启用", description: "保存 Pi 原生包记录并加载发现的 Skill" },
              { id: "install-only", label: "仅安装", description: "保存包记录，但暂不加载任何 Skill" },
              { id: "cancel", label: "取消", description: "不安装、不修改设置" },
            ],
          },
        ]);
        if (answered?.answer !== "install-enable" && answered?.answer !== "install-only") {
          this.panels.open("skills");
          return;
        }
        this.showProgress("正在安装 Skill 包…");
        const result = await this.backend.installSkill(source, event.scope, answered.answer === "install-enable");
        this.panels.setSkillCatalog(await this.backend.listSkills());
        this.panels.open("skills");
        this.showNotice(`${result.enabled ? "已安装并启用" : "已安装"} ${result.skills.length} 个 Skill`, "success");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          this.clearNotice();
          return;
        }
        this.panels.open("skills");
        this.showNotice(`Skill 安装失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "skillAgentSearch") {
      this.panels.close();
      this.focusComposer();
      await this.submit(
        `请搜索并筛选可靠的 Agent Skill，找到明确的 Git 或 npm 来源后，使用 skill_manage 工具向我提议安装。需求：${event.query}`,
      );
    } else if (event.type === "skillToggle") {
      await this.applySkillToggle(event.skill, event.enabled);
    } else if (event.type === "skillUpdate") {
      await this.applySkillMutation("update", event.skill);
    } else if (event.type === "skillRemove") {
      await this.applySkillMutation("remove", event.skill);
    } else if (event.type === "settings") {
      try {
        const settings = {
          ...event.settings,
          thinkingTranslationEndpoint: normalizeTranslationEndpoint(event.settings.thinkingTranslationEndpoint),
        };
        const path = await saveSettings(this.options.cwd, settings, undefined, {
          trustedProject: this.backend.isProjectTrusted?.() ?? false,
        });
        this.panels.confirmSettings(settings);
        if (this.options.settings.scope === settings.scope) {
          const endpointChanged =
            this.options.settings.thinkingTranslationEndpoint !== settings.thinkingTranslationEndpoint;
          this.options.settings = { ...settings };
          this.applyThinkingDisplay(settings.thinkingDisplay);
          if (endpointChanged) this.applyThinkingTranslationEndpoint();
          this.syncActivityPresentation();
        }
        this.completeOneShotPanel();
        this.showNotice(`${settings.scope === "global" ? "全局" : "项目"}设置已保存到 ${path}`, "success");
      } catch (error) {
        this.showNotice(`设置保存失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "effort") {
      try {
        if (!this.backend.setEffort) throw new Error("当前后端不支持 Effort 切换");
        await this.backend.setEffort(event.effort);
        this.effort = event.effort;
        const defaultsSaved = await this.persistRuntimeDefaults();
        this.completeOneShotPanel();
        if (defaultsSaved) this.showNotice(`Effort 已切换为 ${effortLabel(event.effort)}`, "success");
      } catch (error) {
        this.showNotice(`Effort 切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "approval") {
      const pending = this.pendingApproval;
      this.pendingApproval = undefined;
      pending?.cleanup();
      pending?.resolve(event.response);
      this.completeOneShotPanel();
    } else if (event.type === "policyChange") {
      try {
        const snapshot = await this.executionPolicy.switchPolicy(event.policy);
        this.panels.setPolicySnapshot(snapshot);
        this.completeOneShotPanel();
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
      this.completeOneShotPanel();
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
    const refreshSequence = ++this.planRefreshSequence;
    const binding = this.backend.getPlanBinding?.();
    if (!binding || !this.options.planBackend) {
      if (epoch === this.sessionEpoch && refreshSequence === this.planRefreshSequence) {
        this.planSnapshot = undefined;
        if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(undefined);
        this.requestRender();
      }
      return;
    }
    try {
      const plan = await this.options.planBackend.read(binding.planId);
      if (
        epoch !== this.sessionEpoch ||
        refreshSequence !== this.planRefreshSequence ||
        this.backend.getPlanBinding?.()?.planId !== binding.planId
      )
        return;
      this.planSnapshot = plan ? structuredClone(plan) : undefined;
      if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(this.planSnapshot);
      if (!plan) this.showNotice(`绑定的 Local Plan ${binding.planId} 不存在`, "warning");
      this.requestRender();
    } catch (error) {
      if (
        epoch !== this.sessionEpoch ||
        refreshSequence !== this.planRefreshSequence ||
        this.backend.getPlanBinding?.()?.planId !== binding.planId
      )
        return;
      this.planSnapshot = undefined;
      if (!this.options.workflowAdapter) this.panels.setPlanSnapshot(undefined);
      this.showNotice(`Local Plan 读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      this.requestRender();
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
      this.planRefreshSequence += 1;
      this.planSnapshot = structuredClone(updated);
      this.panels.setPlanSnapshot(updated);
      this.showNotice(`Local Plan 已更新到 r${updated.revision}`, "success");
    } catch (error) {
      this.showNotice(`Local Plan 更新失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      await this.refreshPlanSnapshot(this.sessionEpoch);
    }
  }

  private async applySkillToggle(skill: SkillCatalogItem, enabled: boolean): Promise<void> {
    try {
      if (!this.backend.setSkillEnabled || !this.backend.listSkills) {
        throw new Error("当前后端不支持 Skill 启停");
      }
      let scope: SkillScope | undefined;
      if (enabled && (skill.source === "codex" || skill.source === "claude") && !skill.installed) {
        const options = [
          { id: "user", label: "Global 启用", description: "登记原路径到 Pi 全局 Skill 设置" },
          ...(this.backend.isProjectTrusted?.()
            ? [{ id: "project", label: "Project 启用", description: "仅在当前可信项目中登记" }]
            : []),
          { id: "cancel", label: "取消", description: "不修改 Skill 配置" },
        ];
        const [answered] = await this.requestQuestions([
          {
            id: "skill-enable",
            title: "启用 Skill",
            prompt: `${skill.name}\n${skill.sourceLabel} · 原路径登记，不复制源文件。`,
            kind: "singleChoice",
            options,
          },
        ]);
        if (answered?.answer !== "user" && answered?.answer !== "project") {
          this.panels.open("skills");
          return;
        }
        scope = answered.answer;
      } else {
        const [answered] = await this.requestQuestions([
          {
            id: enabled ? "skill-enable" : "skill-disable",
            title: enabled ? "启用 Skill" : "停用 Skill",
            prompt: `${skill.name}\n${skill.sourceLabel} · ${skill.scope}`,
            kind: "singleChoice",
            options: [
              {
                id: "confirm",
                label: enabled ? "启用" : "停用",
                description: enabled ? "加入当前 VSPi Skill 目录" : "保留源文件或安装包，仅停止加载",
              },
              { id: "cancel", label: "取消", description: "不修改 Skill 配置" },
            ],
          },
        ]);
        if (answered?.answer !== "confirm") {
          this.panels.open("skills");
          return;
        }
      }
      await this.backend.setSkillEnabled(skill.id, enabled, scope);
      this.panels.setSkillCatalog(await this.backend.listSkills());
      this.panels.open("skills");
      this.showNotice(`${skill.name} 已${enabled ? "启用" : "停用"}`, "success");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.panels.open("skills");
      this.showNotice(`Skill 操作失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    }
  }

  private async applySkillMutation(action: "update" | "remove", skill: SkillCatalogItem): Promise<void> {
    try {
      if (!this.backend.listSkills || (action === "update" ? !this.backend.updateSkill : !this.backend.removeSkill)) {
        throw new Error("当前后端不支持 Skill 管理");
      }
      const [answered] = await this.requestQuestions([
        {
          id: `skill-${action}`,
          title: action === "update" ? "更新 Skill" : "移除 Skill",
          prompt: `${skill.name}\n${skill.sourceLabel} · ${skill.scope}${action === "remove" && skill.packageSource ? "\n将移除该受管包提供的全部 Skill。" : ""}`,
          kind: "singleChoice",
          options: [
            {
              id: "confirm",
              label: action === "update" ? "更新" : "移除",
              description: action === "update" ? "从已记录的包来源获取更新" : "删除受管包或解除外部路径登记",
            },
            { id: "cancel", label: "取消", description: "不修改 Skill 配置" },
          ],
        },
      ]);
      if (answered?.answer !== "confirm") {
        this.panels.open("skills");
        return;
      }
      if (action === "update") await this.backend.updateSkill?.(skill.id);
      else await this.backend.removeSkill?.(skill.id);
      this.panels.setSkillCatalog(await this.backend.listSkills());
      this.panels.open("skills");
      this.showNotice(`${skill.name} 已${action === "update" ? "更新" : "移除"}`, "success");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.panels.open("skills");
      this.showNotice(
        `Skill ${action === "update" ? "更新" : "移除"}失败：${error instanceof Error ? error.message : "未知错误"}`,
        "error",
      );
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
        questions: structuredClone(questions),
        relaying: false,
        ownedByRoute: false,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      if (this.sessionHandoffRelay) void this.relayPendingQuestion(this.pendingQuestion);
      else this.panels.openQuestions(questions);
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

  private cancelPendingQuestion(message: string, options: { userInitiated?: boolean; abort?: boolean } = {}): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = undefined;
    pending.cleanup();
    if (this.panels.kind === "question") this.panels.close();
    const error = options.userInitiated ? new UserQuestionCancelledError(message) : new Error(message);
    if (!options.userInitiated || options.abort) error.name = "AbortError";
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
        request: structuredClone(request),
        relaying: false,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      if (this.sessionHandoffRelay) void this.relayPendingApproval(this.pendingApproval);
      else this.panels.openApproval(request);
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

  private beginSessionHandoff(relay: SessionHandoffRelay): void {
    if (this.sessionHandoffPending) return;
    this.sessionHandoffPending = true;
    this.sessionHandoffRelay = relay;
    relay.project({ kind: "snapshot-start" });
    for (const message of this.messages) {
      relay.project({ kind: "snapshot-message", message: structuredClone(message) });
    }
    relay.project({
      kind: "snapshot-state",
      modelLabel: this.modelLabel,
      modelId: this.backend.modelId,
      ...(this.backend.modelProvider ? { modelProvider: this.backend.modelProvider } : {}),
      supportsVision: this.backend.supportsVision,
      effort: this.effort,
      usage: structuredClone(this.usage),
      queue: { ...this.queueState },
      busy: this.activityActive(),
    });
    if (this.panels.kind === "question" || this.panels.kind === "approval") this.panels.close();
    if (this.pendingQuestion) void this.relayPendingQuestion(this.pendingQuestion);
    if (this.pendingApproval) void this.relayPendingApproval(this.pendingApproval);
    this.messages.push({
      id: "session-handoff-foreground",
      role: "assistant",
      kind: "session",
      text: "Session 已在另一终端继续；此终端已退出前台。",
    });
    this.showNotice("Session 已在另一终端继续", "info");
    this.requestRender(true);
    this.foregroundRelinquished = true;
    setImmediate(() => this.options.onForegroundRelinquish?.());
  }

  private cancelSessionHandoff(): void {
    if (!this.sessionHandoffPending) return;
    this.sessionHandoffPending = false;
    this.sessionHandoffRelay = undefined;
    if (this.foregroundRelinquished) {
      this.messages = this.messages.filter((message) => message.id !== "session-handoff-foreground");
      this.foregroundRelinquished = false;
      this.options.onForegroundResume?.();
    }
    if (this.pendingQuestion) {
      this.pendingQuestion.relaying = false;
      this.panels.openQuestions(this.pendingQuestion.questions);
    } else if (this.pendingApproval) {
      this.pendingApproval.relaying = false;
      this.panels.openApproval(this.pendingApproval.request);
    }
    this.showNotice("新终端已断开；Session 仍由当前终端继续", "warning");
    this.requestRender();
  }

  private applyHandoffProjection(projection: SessionHandoffProjection): void {
    if (projection.kind === "snapshot-start") {
      this.handoffSnapshotQueued = this.messages.filter(isQueuedTranscriptMessage);
      this.committedMessageCount = 0;
      this.activityPresentationActive = false;
      this.messages = [];
    } else if (projection.kind === "snapshot-message") {
      this.messages.push(structuredClone(projection.message));
    } else if (projection.kind === "snapshot-state") {
      const queued = [...this.handoffSnapshotQueued, ...this.messages.filter(isQueuedTranscriptMessage)];
      const seen = new Set(this.messages.map((message) => message.id));
      this.messages.push(...queued.filter((message) => !seen.has(message.id)));
      this.handoffSnapshotQueued = [];
      this.modelLabel = projection.modelLabel;
      this.currentModelIdentity = projection.modelProvider
        ? { provider: projection.modelProvider, id: projection.modelId }
        : undefined;
      this.effort = projection.effort;
      this.usage = structuredClone(projection.usage);
      this.queueState = { ...projection.queue };
      this.setBusy(projection.busy);
    } else if (projection.kind === "message") {
      this.messages.push(this.withThinkingDisplayDefault(structuredClone(projection.message)));
    } else if (projection.kind === "message-update") {
      const index = this.messages.findIndex((message) => message.id === projection.id);
      const current = this.messages[index];
      if (index >= 0 && current) {
        this.messages[index] = { ...current, ...structuredClone(projection.patch) } as TranscriptMessage;
      }
    } else if (projection.kind === "busy") {
      this.setBusy(projection.busy);
    } else if (projection.kind === "queue") {
      this.queueState = { ...projection.queue };
      this.syncActivityPresentation();
    } else if (projection.kind === "usage") {
      this.usage = structuredClone(projection.usage);
    } else if (projection.kind === "queued-consumed") {
      this.messages = this.messages.filter((message) => message.id !== projection.id);
    } else if (projection.kind === "notice") {
      this.showNotice(projection.message, projection.tone);
    }
    this.requestRender();
  }

  private async relayPendingQuestion(pending: PendingQuestion): Promise<void> {
    const relay = this.sessionHandoffRelay;
    if (!relay || pending.relaying) return;
    pending.relaying = true;
    try {
      const response = await relay.request({ kind: "question", questions: structuredClone(pending.questions) });
      if (response.kind !== "question") throw new Error("Session handoff returned the wrong interaction type");
      if (this.pendingQuestion !== pending) return;
      this.pendingQuestion = undefined;
      pending.cleanup();
      pending.resolve(response.questions);
    } catch (error) {
      if (this.pendingQuestion !== pending) return;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      if (!this.sessionHandoffPending) {
        pending.relaying = false;
        this.panels.openQuestions(pending.questions);
        this.requestRender();
        return;
      }
      this.pendingQuestion = undefined;
      pending.cleanup();
      pending.reject(error instanceof Error ? error : new Error("Session handoff Question failed"));
    }
  }

  private async relayPendingApproval(pending: PendingApproval): Promise<void> {
    const relay = this.sessionHandoffRelay;
    if (!relay || pending.relaying) return;
    pending.relaying = true;
    try {
      const response = await relay.request({ kind: "approval", request: structuredClone(pending.request) });
      if (response.kind !== "approval") throw new Error("Session handoff returned the wrong interaction type");
      if (this.pendingApproval !== pending) return;
      this.pendingApproval = undefined;
      pending.cleanup();
      pending.resolve(response.response);
    } catch (error) {
      if (this.pendingApproval !== pending) return;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      if (!this.sessionHandoffPending) {
        pending.relaying = false;
        this.panels.openApproval(pending.request);
        this.requestRender();
        return;
      }
      this.pendingApproval = undefined;
      pending.cleanup();
      pending.reject(error instanceof Error ? error : new Error("Session handoff Approval failed"));
    }
  }

  private async answerHandoffInteraction(
    interaction: SessionHandoffInteraction,
    signal?: AbortSignal,
  ): Promise<SessionHandoffResponse> {
    if (interaction.kind === "question") {
      const questions = await this.requestQuestions(interaction.questions, signal);
      return { kind: "question", questions };
    }
    const response = await this.requestApproval(interaction.request, signal);
    return { kind: "approval", response };
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
    if (!this.panels.hasPlanContent()) this.planPanelExplicit = false;
    this.workspaceFocus = "composer";
    this.panelFocused = false;
    this.inspectIndex = undefined;
    this.transcriptStartNodeId = undefined;
    this.requestRender();
  }

  private focusPlan(): void {
    if (!this.panels.hasPlanContent() && !this.planPanelExplicit) return;
    this.workspaceFocus = "plan";
    this.panelFocused = true;
    this.inspectIndex = undefined;
    this.transcriptStartNodeId = undefined;
    this.requestRender();
  }

  private currentTranscriptWindow(width?: number, maxRows?: number): TranscriptWindow {
    const terminalWidth = width ?? this.tui.terminal.columns;
    const safeWidth = Number.isFinite(terminalWidth) ? Math.max(1, terminalWidth) : 80;
    const source =
      this.workspaceFocus === "transcript" ? this.messages : this.messages.slice(this.committedMessageCount);
    return selectTranscriptWindow(source, {
      width: safeWidth,
      maxRows: Math.max(1, maxRows ?? this.transcriptViewportRows(safeWidth)),
      maxBlocks: 80,
      maxCharacters: 60_000,
      thinkingDisplay: this.options.settings.thinkingDisplay,
      collapseCompletedTools: this.options.settings.collapseTools,
      ...(this.workspaceFocus === "transcript" && this.inspectNodeId ? { pinnedNodeId: this.inspectNodeId } : {}),
      ...(this.workspaceFocus === "transcript" && this.transcriptStartNodeId
        ? { startNodeId: this.transcriptStartNodeId }
        : {}),
    });
  }

  /** Move the Inspect selection one node earlier and extend the window batch-wise around it. */
  private extendTranscriptHistory(): boolean {
    const all = buildTranscriptNodes(this.messages);
    const firstId = this.currentTranscriptWindow().nodes[0]?.id;
    const firstGlobal = all.findIndex((node) => node.id === firstId);
    const target = firstGlobal > 0 ? all[firstGlobal - 1] : undefined;
    if (!firstId || !target) return false;
    this.inspectNodeId = target.id;
    this.inspectToolId = undefined;
    this.inspectDepth = "node";
    this.inspectIndex = target.messageIndexes[0];
    this.transcriptStartNodeId = target.id;
    return true;
  }

  /** Keep the Inspect window anchored around the selection; fall back to tail-following near the end. */
  private reconcileTranscriptStart(): void {
    const all = buildTranscriptNodes(this.messages);
    const selectedGlobal = all.findIndex((node) => node.id === this.inspectNodeId);
    if (selectedGlobal < 0 || selectedGlobal >= all.length - 3) {
      this.transcriptStartNodeId = undefined;
      return;
    }
    const window = this.currentTranscriptWindow();
    if (window.nodes.some((node) => node.id === this.inspectNodeId)) {
      if (window.truncatedTailBlocks === 0) this.transcriptStartNodeId = undefined;
      return;
    }
    this.transcriptStartNodeId = all[selectedGlobal]?.id;
  }

  /** Rows the transcript may occupy without pushing the whole frame past the visible viewport. */
  private transcriptViewportRows(width: number): number {
    const terminalRows = Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows : 24;
    const activityActive = this.activityActive();
    const composerRows = this.composer.render(width, activityActive ? this.composerActivity() : undefined).length;
    const activityRows = activityActive && this.options.settings.workingStyle === 1 ? 1 : 0;
    const queuedRows = this.messages.filter(isQueuedTranscriptMessage).length;
    const statusRows = this.renderStatus(width).length;
    const planSurfaceVisible =
      this.workspaceFocus !== "transcript" &&
      (this.panels.kind !== "plan" || this.panels.hasPlanContent() || this.planPanelExplicit);
    const previewRows = this.preview ? this.preview.render(width).length + 1 : 0;
    const panelRows =
      previewRows === 0 && planSurfaceVisible
        ? this.panelRowBudget(composerRows, activityRows, queuedRows, statusRows)
        : 0;
    const chrome = composerRows + activityRows + queuedRows + statusRows + panelRows + previewRows + 1;
    return Math.max(3, terminalRows - chrome - 3);
  }

  private focusTranscript(): boolean {
    this.transcriptStartNodeId = undefined;
    const previousFocus = this.workspaceFocus;
    this.workspaceFocus = "transcript";
    const nodes = this.currentTranscriptWindow().nodes;
    if (nodes.length === 0) {
      this.workspaceFocus = previousFocus;
      this.showNotice("暂无消息，无法进入 Transcript", "info");
      return false;
    }

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
    const hasPlan = this.panels.hasPlanContent();
    if (this.workspaceFocus === "composer") {
      if (buildTranscriptNodes(this.messages).length > 0) this.focusTranscript();
      else if (hasPlan) this.focusPlan();
      return;
    }
    if (this.workspaceFocus === "transcript") {
      if (hasPlan) this.focusPlan();
      else this.focusComposer();
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
    if (interaction.handler === "moveInspect" && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown))) {
      this.pageTranscript(matchesKey(data, Key.pageUp) ? -1 : 1);
      this.requestRender();
      return;
    }
    if (interaction.handler === "closeInspect") {
      this.focusComposer();
      return;
    }
    if (interaction.handler === "cycleWorkspaceFocus") {
      this.cycleWorkspaceFocus();
      return;
    }

    const nodes = this.currentTranscriptWindow().nodes;
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
      if (offset < 0 && nodeIndex === 0) {
        // 到达当前窗口顶部：选中上移一条并向前扩展一批更早历史。
        if (!this.extendTranscriptHistory()) this.showNotice("已到最早内容", "info");
        this.requestRender();
        return;
      }
      if (offset > 0 && nodeIndex === nodes.length - 1) {
        // 到达锚点窗口底部：选中下移一条，窗口跟随或回到 tail 模式。
        const all = buildTranscriptNodes(this.messages);
        const selectedGlobal = all.findIndex((node) => node.id === this.inspectNodeId);
        const nextGlobal = selectedGlobal >= 0 ? all[selectedGlobal + 1] : undefined;
        if (nextGlobal) {
          this.inspectNodeId = nextGlobal.id;
          this.inspectToolId = undefined;
          this.inspectDepth = "node";
          this.inspectIndex = nextGlobal.messageIndexes[0];
          this.reconcileTranscriptStart();
        }
        this.requestRender();
        return;
      }
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, nodeIndex + offset))];
      if (next) {
        this.inspectNodeId = next.id;
        this.inspectToolId = undefined;
        this.inspectDepth = "node";
        this.inspectIndex = next.messageIndexes[0];
        this.reconcileTranscriptStart();
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

  /** Move by one currently visible batch; anchoring the target loads the adjacent history batch. */
  private pageTranscript(direction: -1 | 1): void {
    const all = buildTranscriptNodes(this.messages);
    const selectedGlobal = all.findIndex((node) => node.id === this.inspectNodeId);
    if (selectedGlobal < 0 || all.length === 0) return;
    const visibleNodes = this.currentTranscriptWindow().nodes.length;
    const distance = Math.max(5, visibleNodes);
    const targetGlobal = Math.max(0, Math.min(all.length - 1, selectedGlobal + direction * distance));
    if (targetGlobal === selectedGlobal) {
      this.showNotice(direction < 0 ? "已到最早内容" : "已到最新内容", "info");
      return;
    }
    const target = all[targetGlobal];
    if (!target) return;
    this.inspectNodeId = target.id;
    this.inspectToolId = undefined;
    this.inspectDepth = "node";
    this.inspectIndex = target.messageIndexes[0];
    this.transcriptStartNodeId = targetGlobal >= all.length - 1 ? undefined : target.id;
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
    const nodes = this.currentTranscriptWindow().nodes;
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

  private applyThinkingTranslationEndpoint(): void {
    this.thinkingTranslationRevision += 1;
    this.thinkingTranslationAbort?.abort();
    this.thinkingTranslationAbort = undefined;
    this.translatedThinkingSources.clear();
    this.messages = this.messages.map((message) =>
      message.kind === "thinking" ? { ...message, translatedText: undefined, translationStatus: undefined } : message,
    );
    this.transcriptRenderCache.clear();
    this.queueVisibleThinkingTranslations();
  }

  private queueVisibleThinkingTranslations(): void {
    if (!this.options.settings.thinkingTranslationEndpoint) return;
    const visible = this.currentTranscriptWindow().messages.filter(
      (message): message is Extract<TranscriptMessage, { kind: "thinking" }> =>
        message.kind === "thinking" && !message.streaming,
    );
    for (const message of visible.slice(-20)) this.queueThinkingTranslation(message.id);
  }

  private queueThinkingTranslation(id: string): void {
    const endpoint = this.options.settings.thinkingTranslationEndpoint;
    if (!endpoint) return;
    const index = this.messages.findIndex((message) => message.id === id);
    const message = this.messages[index];
    if (index < 0 || message?.kind !== "thinking" || message.streaming || !message.text.trim()) return;
    const sourceKey = `${endpoint}\0${message.text}`;
    if (this.translatedThinkingSources.get(id) === sourceKey) return;
    this.translatedThinkingSources.set(id, sourceKey);
    this.messages[index] = { ...message, translatedText: undefined, translationStatus: "pending" };
    const sessionEpoch = this.sessionEpoch;
    const revision = this.thinkingTranslationRevision;
    const sourceText = message.text;
    this.thinkingTranslationQueue = this.thinkingTranslationQueue
      .catch(() => undefined)
      .then(async () => {
        if (sessionEpoch !== this.sessionEpoch || revision !== this.thinkingTranslationRevision) return;
        const controller = new AbortController();
        this.thinkingTranslationAbort = controller;
        try {
          const translatedText = await this.thinkingTranslator.translate(sourceText, endpoint, controller.signal);
          if (sessionEpoch !== this.sessionEpoch || revision !== this.thinkingTranslationRevision) return;
          this.updateThinkingTranslation(id, sourceText, {
            translatedText,
            translationStatus: translatedText ? "translated" : "error",
          });
        } catch {
          if (sessionEpoch !== this.sessionEpoch || revision !== this.thinkingTranslationRevision) return;
          this.updateThinkingTranslation(id, sourceText, { translatedText: undefined, translationStatus: "error" });
        } finally {
          if (this.thinkingTranslationAbort === controller) this.thinkingTranslationAbort = undefined;
        }
      });
    this.requestRender();
  }

  private updateThinkingTranslation(
    id: string,
    sourceText: string,
    patch: Pick<Extract<TranscriptMessage, { kind: "thinking" }>, "translatedText" | "translationStatus">,
  ): void {
    const index = this.messages.findIndex((message) => message.id === id);
    const current = this.messages[index];
    if (index < 0 || current?.kind !== "thinking" || current.text !== sourceText) return;
    this.messages[index] = { ...current, ...patch };
    this.requestRender();
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
    this.committedMessageCount = 0;
    this.activityPresentationActive = false;
    this.messages = [];
    this.thinkingTranslationRevision += 1;
    this.thinkingTranslationAbort?.abort();
    this.thinkingTranslationAbort = undefined;
    this.translatedThinkingSources.clear();
    this.transcriptRenderCache.clear();
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
    this.transcriptStartNodeId = undefined;
    this.nextBehavior = "prompt";
    this.pendingRouteSubmission = undefined;
    this.planPanelExplicit = false;
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
    if (interaction.handler === "deleteRenameCharacter" || interaction.handler === "editRename") {
      if (this.renameField.getValue() !== this.renameInput) this.renameField.setValue(this.renameInput);
      this.renameField.handleInput(data);
      if (Array.from(this.renameField.getValue()).length > 200) {
        this.renameField.setValue(Array.from(this.renameField.getValue()).slice(0, 200).join(""));
      }
      this.renameInput = this.renameField.getValue();
      this.requestRender();
      return;
    }
    if (interaction.handler === "commitRename") {
      const id = this.renameAttachmentId;
      if (id) void this.commitAttachmentRename(id);
      return;
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

function parseExternalImportSource(raw: string): ExternalSessionSource {
  const value = raw.trim().split(/\s+/u)[1]?.toLocaleLowerCase();
  return value === "claude" || value === "claude-code" ? "claude" : "codex";
}

function formatTokenEstimate(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}K`;
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
