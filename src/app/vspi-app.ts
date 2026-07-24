import { randomUUID } from "node:crypto";
import { type Component, type Focusable, Key, matchesKey, TUI } from "@earendil-works/pi-tui";
import type { AttachmentService } from "../attachments/service.js";
import type { ChatBackend, ModelSelectionResult, NewSessionOptions } from "../backend/types.js";
import { saveSettings } from "../config/settings.js";
import { COMPACTION_PROFILES, type CompactOptions } from "../continuity/compaction-profiles.js";
import {
  type ActionDefinition,
  type CommandDefinition,
  commandCompletion,
  getActionDefinition,
  resolveCommand,
} from "../domain/commands.js";
import { DEFAULT_USAGE } from "../domain/defaults.js";
import type {
  AppSettings,
  Attachment,
  EffortLevel,
  Question,
  TranscriptMessage,
  UsageSnapshot,
} from "../domain/types.js";
import type { LocalPlanBackend, PlanBinding, PlanInput, PlanStatus, StoredPlan } from "../plans/types.js";
import { createExecutionPolicyService, type PolicySnapshot } from "../policy/execution-policy.js";
import { createYoloAcknowledgementBroker, type YoloAcknowledgementBroker } from "../policy/startup-runtime.js";
import type { EffectivePromptSegment } from "../prompts/effective-prompt.js";
import type {
  ModelIdentity,
  PromptProfileConfig,
  PromptProfileRule,
  PromptProfileSnapshot,
  ResolvedPromptProfile,
} from "../prompts/types.js";
import { padLine } from "../ui/ansi.js";
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
import { renderTranscript } from "../ui/transcript.js";
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
  yoloAcknowledgementBroker?: YoloAcknowledgementBroker;
  planBackend?: Pick<LocalPlanBackend, "read" | "update">;
  planTaskRouter?: PlanTaskRouter;
  workflowAdapter?: WorkflowAdapter;
  promptProfiles?: PromptProfileUi;
  openOnStart?: "sessions";
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

export class VspiApp implements Component, Focusable {
  readonly composer: Composer;
  private tui: TUI;
  private messages: TranscriptMessage[] = [];
  private readonly panels: PanelController;
  private usage: UsageSnapshot = DEFAULT_USAGE;
  private effort: EffortLevel = "中";
  private modelLabel: string;
  private busy = false;
  private panelFocused = false;
  private inspectIndex: number | undefined;
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
  private sessionEpoch = 0;
  private sessionTransition = false;
  private pendingRouteSubmission: { raw: string } | undefined;
  private providerConfig: ProviderConfigUi | undefined;
  private providerCatalogHash: string | undefined;
  private runtimeDefaults: RuntimeDefaultsUi | undefined;
  private currentModelIdentity: { provider: string; id: string } | undefined;
  private readonly executionPolicy: ExecutionPolicyUi;
  private readonly yoloAcknowledgementBroker: YoloAcknowledgementBroker;
  private pendingQuestion: PendingQuestion | undefined;
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
          this.messages.push(message);
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
          this.busy = busy;
          if (this.renderReady) this.tui.terminal.setProgress(busy);
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
        onSessionInvalidating: () => this.cancelPendingQuestion("Question cancelled because the session changed"),
        onSessionReset: (session) => {
          this.sessionTransition = false;
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
      this.providerConfig = this.options.providerConfigFactory?.(this.backend.isProjectTrusted?.() ?? false);
      const catalog = await this.providerConfig?.loadCatalog();
      this.providerCatalogHash = catalog?.hash;
      const providers = runtimeProviders.map((provider) => {
        const source = catalog?.providers.find((item) => item.id === provider.id)?.source ?? "builtin";
        return { ...provider, detail: `${source} · ${provider.detail}` };
      });
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
      }
    } catch (error) {
      this.renderReady = false;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.renderReady = false;
    this.yoloAcknowledgementBroker.cancel();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.cancelPendingQuestion("Question cancelled because VSPi is closing");
    try {
      await this.options.attachments.dispose();
    } finally {
      await this.backend.dispose();
    }
  }

  getActiveTui(): TUI {
    return this.tui;
  }

  handleInput(data: string): void {
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
    if (this.inspectIndex !== undefined) {
      this.handleInspectInput(data);
      return;
    }
    const composerState = {
      busy: this.busy,
      hasMessages: this.messages.length > 0,
      composerEmpty: this.composer.getText() === "",
      commandCompletable: this.commandCompletionAvailable(),
      selectedAttachment: this.composer.selectedAttachment() !== undefined,
    };
    if (matchesInteraction("composer", "main", "cancelOrExit", data, composerState)) {
      if (this.busy) void this.cancelGeneration();
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
      if (this.busy) {
        this.showNotice("生成中，请等待完成后再提交", "info");
        return;
      }
      const text = this.composer.getText();
      if (text.trim()) {
        this.nextBehavior = "followUp";
        void this.submit(text);
      }
      return;
    }
    if (matchesInteraction("composer", "main", "enterInspect", data, composerState)) {
      this.inspectIndex = this.messages.length - 1;
      this.requestRender();
      return;
    }
    if (matchesInteraction("composer", "main", "completeCommand", data, composerState) && this.completeCommandToken())
      return;
    if (this.panels.kind === "plan" && matchesInteraction("composer", "main", "togglePlanFocus", data, composerState)) {
      this.panelFocused = !this.panelFocused;
      this.requestRender();
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
    if (matchesKey(data, Key.tab) && composerState.composerEmpty && !composerState.hasMessages) {
      this.showNotice("暂无消息，无法进入 Inspect", "info");
      return;
    }
    if (this.busy && matchesKey(data, Key.enter)) {
      this.showNotice("生成中，请等待完成后再提交", "info");
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
    const inspectedId = this.inspectIndex === undefined ? undefined : this.messages[this.inspectIndex]?.id;
    const output = renderTranscript(this.messages, width, this.theme, {
      ...(inspectedId ? { inspectedId } : {}),
      showThinking: this.options.settings.showThinking,
      wrapCode: this.options.settings.wrapCode,
    });
    if (output.length > 0) output.push("");
    const composer = this.composer.render(width);
    const status = this.renderStatus(width);
    const panelRows =
      this.tui.terminal.rows <= 24
        ? Math.max(3, 9 - (status.length - 1))
        : Math.min(16, Math.max(3, this.tui.terminal.rows - composer.length - 7 - status.length));
    if (this.preview) {
      output.push(...this.preview.render(width));
      output.push(this.theme.muted(padLine(this.previewLabel, width)));
    } else {
      output.push(...this.panels.render(width, panelRows, this.theme, this.usage, this.panelFocused));
      const hint =
        this.inspectIndex === undefined
          ? this.renderPanelHint(width)
          : this.theme.muted(
              padLine(renderInteractionHint("inspect", "transcript", this.inspectInteractionState()), width),
            );
      output.push(hint);
    }
    output.push(...composer);
    output.push(...status);
    if (this.notice) output.push(this.renderNotice(width));
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
    if (!text || this.busy) return;
    const behavior = this.nextBehavior;
    this.nextBehavior = "prompt";
    if (text.startsWith("/")) {
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
    const binding = this.backend.getPlanBinding?.();
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
    this.messages.push({ id: randomUUID(), role: "user", kind: "text", text, attachments });
    this.composer.setText("");
    this.requestRender();
    const submission: ActiveSubmission = {
      id: ++this.submissionId,
      raw,
      attachments: pendingAttachments,
      transcriptLength,
      cancelled: false,
      restored: false,
    };
    this.activeSubmission = submission;
    try {
      const result = await this.backend.send(text, { attachments, effort: this.effort, behavior });
      if (submission.cancelled || result?.status === "cancelled") {
        this.restoreCancelledSubmission(submission);
        return;
      }
      this.modelLabel = this.backend.modelLabel;
      this.composer.editor.addToHistory(text);
    } catch (error) {
      if (submission.cancelled) {
        this.restoreCancelledSubmission(submission);
        return;
      }
      this.busy = false;
      this.tui.terminal.setProgress(false);
      this.messages.splice(transcriptLength);
      this.composer.restoreDraft(raw, pendingAttachments);
      this.showNotice(error instanceof Error ? error.message : "消息发送失败", "error");
    } finally {
      if (this.activeSubmission?.id === submission.id) this.activeSubmission = undefined;
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
      this.inspectIndex !== undefined
        ? "Inspect"
        : this.panelFocused
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
        busy: this.busy,
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
      this.requestRender();
    }, 3500);
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
    if (action.handler === "effort") {
      const levels: EffortLevel[] = ["低", "中", "高"];
      const next = levels[(levels.indexOf(this.effort) + 1) % levels.length] ?? "中";
      try {
        if (!this.backend.setEffort) throw new Error("当前后端不支持 Effort 切换");
        await this.backend.setEffort(next);
        this.effort = next;
        await this.persistRuntimeDefaults();
        this.panels.close();
      } catch (error) {
        this.showNotice(`Effort 切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
      return;
    }
    if (action.handler === "models") this.panels.open("models");
    else if (action.handler === "providers") this.panels.open("providers");
    else if (action.handler === "plan") {
      if (this.options.workflowAdapter) await this.refreshWorkflowSnapshot();
      else await this.refreshPlanSnapshot(this.sessionEpoch);
      this.panels.open("plan");
      this.panelFocused = true;
    } else if (action.handler === "prompt") {
      await this.executePromptCommand(raw);
    } else if (action.handler === "sessions") {
      try {
        this.panels.setSessions(await this.backend.listSessions());
        this.panels.open("sessions");
      } catch (error) {
        this.showNotice(`会话读取失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (action.handler === "settings" || action.handler === "thinkingSettings") this.panels.open("settings");
    else if (action.handler === "usage") this.panels.open("usage");
    else if (action.handler === "policy") {
      this.panels.setPolicySnapshot(this.executionPolicy.snapshot());
      this.panels.open("policy");
    } else if (action.handler === "theme") this.panels.open("theme");
    if (action.handler !== "plan") this.panelFocused = false;
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
      if (this.pendingQuestion) this.cancelPendingQuestion("Question cancelled by user");
      if (this.pendingRouteSubmission) {
        this.composer.setText(this.pendingRouteSubmission.raw);
        this.pendingRouteSubmission = undefined;
      }
    } else if (event.type === "command") {
      this.composer.setText("");
      await this.executeCommand(event.command, event.command.label);
    } else if (event.type === "model") {
      if (this.busy) {
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
        await this.persistRuntimeDefaults();
        this.panels.close();
      } catch (error) {
        this.showNotice(`模型切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "modelGroup") {
      if (this.busy) {
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
        await this.persistRuntimeDefaults();
        this.panels.close();
      } catch (error) {
        this.showNotice(`模型组切换失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "provider") {
      this.showNotice(`${event.provider.label} 请先从操作菜单选择离线检查、网络测试或编辑`, "info");
    } else if (event.type === "providerActions") {
      // Panel owns the local action-menu state; opening it performs no I/O.
    } else if (event.type === "providerAction") {
      if (event.action === "edit") {
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
      this.options.settings = { ...event.settings };
      try {
        const path = await saveSettings(this.options.cwd, event.settings, undefined, {
          trustedProject: this.backend.isProjectTrusted?.() ?? false,
        });
        this.showNotice(`设置已保存到 ${path}`, "success");
      } catch (error) {
        this.showNotice(`设置保存失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
      }
    } else if (event.type === "policyChange") {
      try {
        if (event.policy === "YOLO" && !event.requiresAcknowledgement) {
          throw new Error("YOLO Host 高风险模式缺少 Panel 明确确认");
        }
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
        if (this.busy) this.composer.setText(routed.raw);
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

  private async persistRuntimeDefaults(): Promise<void> {
    if (!this.runtimeDefaults) return;
    try {
      const path = await this.runtimeDefaults.save(this.options.settings.scope, {
        ...(this.currentModelIdentity ? { model: this.currentModelIdentity } : {}),
        effort: this.effort,
      });
      this.showNotice(`${this.options.settings.scope} 默认 Model/Effort 已保存到 ${path}`, "success");
    } catch (error) {
      this.showNotice(
        `当前选择已生效，但默认配置未保存：${error instanceof Error ? error.message : "未知错误"}`,
        "warning",
      );
    }
  }

  private async applyRuntimeDefaults(): Promise<void> {
    const defaults = await this.runtimeDefaults?.load();
    if (!defaults) return;
    if (defaults.value.model && this.backend.kind === "pi") {
      if (!this.backend.selectModel) throw new Error("当前后端不支持默认模型选择");
      await this.backend.selectModel(defaults.value.model.provider, defaults.value.model.id);
      this.currentModelIdentity = { ...defaults.value.model };
      this.modelLabel = this.backend.modelLabel;
      this.panels.confirmModelSelection(defaults.value.model);
    }
    if (this.backend.setEffort) await this.backend.setEffort(defaults.value.effort);
    this.effort = defaults.value.effort;
    if (defaults.diagnostics.length > 0) this.showNotice(defaults.diagnostics[0] ?? "默认配置诊断", "warning");
  }

  private handleInspectInput(data: string): void {
    if (matchesInteraction("composer", "main", "cancelOrExit", data)) {
      if (this.busy) void this.cancelGeneration();
      else this.options.onExit();
      return;
    }
    const interaction = matchingInteraction("inspect", "transcript", data, this.inspectInteractionState());
    if (!interaction) return;
    if (interaction.handler === "closeInspect") {
      this.inspectIndex = undefined;
      this.requestRender();
      return;
    }
    if (interaction.handler === "moveInspect" && matchesKey(data, Key.up)) {
      this.inspectIndex = Math.max(0, (this.inspectIndex ?? 0) - 1);
    } else if (interaction.handler === "moveInspect" && matchesKey(data, Key.down)) {
      this.inspectIndex = Math.min(this.messages.length - 1, (this.inspectIndex ?? 0) + 1);
    } else {
      const message = this.messages[this.inspectIndex ?? -1];
      if ((matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.enter)) && message) {
        if (message.kind === "thinking" || message.kind === "tool") {
          const expand =
            matchesKey(data, Key.right) ||
            (matchesKey(data, Key.enter) && (message.kind === "thinking" ? message.collapsed : !message.expanded));
          if (message.kind === "thinking") message.collapsed = !expand;
          else message.expanded = expand;
        }
      }
    }
    this.requestRender();
  }

  private inspectInteractionState(): InteractionState {
    const selected = this.messages[this.inspectIndex ?? -1];
    return {
      hasItems: selected !== undefined,
      expandable: selected?.kind === "thinking" || selected?.kind === "tool",
    };
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
    try {
      await this.backend.cancel();
    } catch (error) {
      this.showNotice(`取消生成失败：${error instanceof Error ? error.message : "未知错误"}`, "error");
    } finally {
      if (submission) this.restoreCancelledSubmission(submission);
      else {
        this.busy = false;
        this.tui.terminal.setProgress(false);
      }
    }
  }

  private resetSessionState(): number {
    this.sessionEpoch += 1;
    this.cancelPendingQuestion("Question cancelled because the session changed");
    if (this.activeSubmission) {
      this.activeSubmission.cancelled = true;
      this.activeSubmission.restored = true;
      this.activeSubmission = undefined;
    }
    this.messages = [];
    this.usage = DEFAULT_USAGE;
    this.busy = false;
    this.inspectIndex = undefined;
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

  private restoreCancelledSubmission(submission: ActiveSubmission): void {
    if (submission.restored) return;
    submission.restored = true;
    this.messages.splice(submission.transcriptLength);
    this.composer.restoreDraft(submission.raw, submission.attachments);
    this.busy = false;
    this.tui.terminal.setProgress(false);
    this.requestRender();
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
      if (this.busy) void this.cancelGeneration();
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
