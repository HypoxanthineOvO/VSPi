import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  BUILTIN_COMMAND_SOURCE,
  type CommandDefinition,
  type CommandMatch,
  exactCommandCandidates,
  filterCommands,
  getActionDefinition,
  matchCommands,
} from "../domain/commands.js";
import { FX } from "../domain/defaults.js";
import type {
  AppSettings,
  ModelGroup,
  ModelOption,
  PlanItem,
  ProviderOption,
  Question,
  SessionOption,
  UsageSnapshot,
} from "../domain/types.js";
import type { PlanStatus, StoredPlan } from "../plans/types.js";
import { POLICY_LEVELS, type PolicyLevel, type PolicySnapshot } from "../policy/execution-policy.js";
import { redactPrompt } from "../prompts/effective-prompt.js";
import { BRAND_PRIORITY, providerPriorityIndex } from "../providers/builtins.js";
import type { WorkflowSnapshot } from "../workflow/types.js";
import { alignRight, emphasizePrefix, frame, padLine, stripAnsi, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import {
  type InteractionState,
  matchesInteraction,
  matchingInteraction,
  renderInteractionHint,
} from "./interactions.js";
import { formatContextUsage } from "./status.js";
import type { VspiTheme } from "./theme.js";

export type PanelKind =
  | "plan"
  | "prompt"
  | "commands"
  | "models"
  | "providers"
  | "sessions"
  | "settings"
  | "usage"
  | "theme"
  | "question"
  | "policy";

export type PanelEvent =
  | { type: "close" }
  | { type: "command"; command: CommandDefinition }
  | { type: "model"; model: ModelOption }
  | { type: "modelGroup"; group: ModelGroup }
  | { type: "provider"; provider: ProviderOption }
  | { type: "providerActions"; provider: ProviderOption; actions: string[] }
  | { type: "providerAction"; provider: ProviderOption; action: string; costConfirmed?: boolean }
  | {
      type: "providerSave";
      provider: ProviderOption;
      value: { name: string; baseUrl: string; protocol: string };
    }
  | { type: "session"; session: SessionOption }
  | { type: "fork"; session: SessionOption }
  | { type: "settings"; settings: AppSettings }
  | { type: "policyChange"; policy: PolicyLevel; requiresAcknowledgement: boolean }
  | { type: "questions"; questions: Question[] }
  | {
      type: "promptToggleRule";
      ruleId: string;
      ownerScope: "global" | "project" | "session";
      enabled: boolean;
    }
  | { type: "promptPin"; profileId: string }
  | { type: "promptOff" }
  | { type: "promptFork"; profileId: string }
  | { type: "promptImport"; path: string; scope: "session" }
  | { type: "promptExport"; profileId: string }
  | {
      type: "planEdit";
      planId: string;
      expectedRevision: number;
      operation:
        | { kind: "status"; itemId: string; status: PlanStatus }
        | { kind: "focus"; itemId: string }
        | { kind: "nextAction"; value: string };
    }
  | { type: "notice"; text: string; tone: "info" | "success" | "warning" | "error" };

interface PanelState {
  kind: PanelKind;
  selected: number;
  scroll: number;
}

export interface PromptPanelSnapshot {
  profiles: Array<{
    id: string;
    name: string;
    family: string;
    sourceType: "factory" | "user-fork" | "global" | "project" | "session";
    evaluationStatus: "unreviewed" | "reviewed" | "verified";
    active?: boolean;
  }>;
  rules: Array<{
    id: string;
    label: string;
    enabled: boolean;
    ownerScope: "global" | "project" | "session";
  }>;
  resolved: { profileId?: string; scope: string; pinned: boolean; disabled: boolean };
  effectiveSegments: Array<{
    source: "pi-base" | "system" | "append" | "context" | "profile" | "plan";
    content: string;
  }>;
}

const MODEL_WIDE_MIN_BODY_WIDTH = 58;

function usesWideModelLayout(bodyWidth: number): boolean {
  return bodyWidth >= MODEL_WIDE_MIN_BODY_WIDTH;
}

function printable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty) return kitty;
  const hasControl = Array.from(data).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!hasControl) return data;
  return undefined;
}

function panelKey(data: string, key: Parameters<typeof matchesKey>[1]): boolean {
  return data === key || matchesKey(data, key);
}

function statusStyle(status: ProviderOption["status"], theme: VspiTheme) {
  if (status === "已验证") return theme.success;
  if (status === "异常") return theme.error;
  if (status === "检测中") return theme.warning;
  if (status === "已配置") return theme.blue;
  return theme.muted;
}

function selectedLine(text: string, selected: boolean, width: number, theme: VspiTheme): string {
  const marker = selected ? theme.focus("› ") : "  ";
  const line = padLine(`${marker}${text}`, width);
  return selected ? theme.selected(line) : line;
}

function truncateStart(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…".slice(0, width);
  let suffix = "";
  for (const character of Array.from(text).reverse()) {
    if (visibleWidth(`…${character}${suffix}`) > width) break;
    suffix = `${character}${suffix}`;
  }
  return `…${suffix}`;
}

function tabLine(tabs: string[], selected: number, width: number, theme: VspiTheme): string {
  const line = tabs
    .map((tab, index) => (index === selected ? theme.selected(` ${tab} `) : theme.muted(` ${tab} `)))
    .join(" ");
  return padLine(line, width);
}

function clampSelection(state: PanelState, count: number): void {
  state.selected = Math.max(0, Math.min(state.selected, Math.max(0, count - 1)));
}

function canonicalMatch(command: CommandDefinition): CommandMatch {
  return {
    command,
    canonicalId: command.id,
    canonicalToken: command.label,
    matchedToken: command.label,
    matchKind: "canonical",
    source: command.source ?? BUILTIN_COMMAND_SOURCE,
  };
}

function commandMatches(query: string): CommandMatch[] {
  const normalized = query.trim().toLowerCase();
  const prefixMatches = normalized && normalized !== "/" ? matchCommands(query) : [];
  const candidates = prefixMatches.length > 0 ? prefixMatches : filterCommands(query).map(canonicalMatch);
  const ordered = [...candidates].sort((left, right) => {
    const leftExact = left.matchedToken.toLowerCase() === normalized ? 1 : 0;
    const rightExact = right.matchedToken.toLowerCase() === normalized ? 1 : 0;
    return rightExact - leftExact;
  });
  const seen = new Set<string>();
  return ordered.filter((match) => {
    if (seen.has(match.canonicalId)) return false;
    seen.add(match.canonicalId);
    return true;
  });
}

export class PanelController {
  private state: PanelState = { kind: "plan", selected: 0, scroll: 0 };
  private commandQuery = "";
  private modelTab = 0;
  private modelSearch = "";
  private modelNarrowDetail = false;
  private selectedModelKey = "";
  private selectedGroupId = "";
  private models: ModelOption[] = [];
  private modelGroups: ModelGroup[] = [];
  private providers: ProviderOption[] = [];
  private sessions: SessionOption[] = [];
  private providerEditing = false;
  private providerActionMenu = false;
  private activeProviderId: string | undefined;
  private providerCostConfirmation = false;
  private readonly providerActions = ["edit", "check-config", "test-connection", "minimal-generation"];
  private providerField = 0;
  private providerDraft = { label: "", baseUrl: "https://", protocol: "OpenAI compatible" };
  private planItems: PlanItem[] = [];
  private planSnapshot: StoredPlan | undefined;
  private workflowSnapshot: WorkflowSnapshot | undefined;
  private planCollapsed = new Set<string>();
  private planActionMenu = false;
  private planActionIndex = 0;
  private planNextActionEditing = false;
  private planNextActionInput = "";
  private promptSnapshot: PromptPanelSnapshot = {
    profiles: [],
    rules: [],
    resolved: { scope: "off", pinned: false, disabled: false },
    effectiveSegments: [],
  };
  private promptImportEditing = false;
  private promptImportPath = "";
  private settings: AppSettings;
  private settingsTab = 1;
  private questionIndex = 0;
  private questionReview = false;
  private questionDirectAnswer = false;
  private questionInput = "";
  private questions: Question[] = [];
  private lastBodyWidth = 78;
  private policySnapshot: PolicySnapshot = {
    policy: "Standard",
    boundary: "Sandboxed",
    sandboxed: true,
    recovery: false,
  };

  constructor(settings: AppSettings) {
    this.settings = { ...settings };
    this.settingsTab = settings.scope === "global" ? 0 : 1;
  }

  get kind(): PanelKind {
    return this.state.kind;
  }

  open(kind: PanelKind): void {
    this.state = { kind, selected: 0, scroll: 0 };
    if (kind === "commands") this.state.selected = 0;
    if (kind === "models") this.modelNarrowDetail = false;
    if (kind === "policy") this.state.selected = Math.max(0, POLICY_LEVELS.indexOf(this.policySnapshot.policy));
    if (kind === "question") {
      this.questionIndex = 0;
      this.questionReview = false;
      this.questionDirectAnswer = false;
      this.questionInput = "";
    }
  }

  openQuestions(questions: Question[]): void {
    if (questions.length === 0) throw new Error("Question panel requires at least one question");
    this.open("question");
    this.questions = structuredClone(questions);
  }

  close(): void {
    this.open("plan");
  }

  setSessions(sessions: SessionOption[]): void {
    this.sessions = sessions.length > 0 ? [...sessions] : [];
    clampSelection(this.state, this.sessions.length);
  }

  setModels(
    models: ModelOption[],
    groups: ModelGroup[] = [],
    selectedModel?: string | { provider: string; id: string },
  ): void {
    this.models = structuredClone(models);
    this.modelGroups = structuredClone(groups);
    if (selectedModel) {
      this.selectedModelKey =
        typeof selectedModel === "string"
          ? modelKey(this.models.find((model) => model.id === selectedModel))
          : modelKey(selectedModel);
    }
    this.selectedModelKey =
      modelKey(this.models.find((model) => modelKey(model) === this.selectedModelKey)) || modelKey(this.models[0]);
    this.selectedGroupId = this.modelGroups.find((group) => group.id === this.selectedGroupId)?.id ?? "";
    this.state.selected = 0;
  }

  confirmModelSelection(identity: string | { provider?: string; id: string }): void {
    const model =
      typeof identity === "string"
        ? this.models.find((item) => item.id === identity)
        : this.models.find(
            (item) =>
              item.id === identity.id && (identity.provider === undefined || item.provider === identity.provider),
          );
    if (model) this.selectedModelKey = modelKey(model);
  }

  confirmModelGroupSelection(groupId: string): void {
    if (this.modelGroups.some((group) => group.id === groupId)) this.selectedGroupId = groupId;
  }

  setProviders(providers: ProviderOption[]): void {
    this.providers = structuredClone(providers).sort(
      (left, right) =>
        providerPriorityIndex(left.id) - providerPriorityIndex(right.id) || left.label.localeCompare(right.label),
    );
    this.providerActionMenu = false;
    this.providerEditing = false;
    clampSelection(this.state, this.providers.length);
  }

  setPlanItems(items: PlanItem[]): void {
    this.planSnapshot = undefined;
    this.planItems = structuredClone(items);
    this.planCollapsed.clear();
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setPlanSnapshot(snapshot: StoredPlan | undefined): void {
    this.workflowSnapshot = undefined;
    this.planSnapshot = snapshot ? structuredClone(snapshot) : undefined;
    this.planItems = snapshot ? flattenPlanItems(snapshot) : [];
    this.planCollapsed.clear();
    this.planActionMenu = false;
    this.planNextActionEditing = false;
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setWorkflowSnapshot(snapshot: WorkflowSnapshot): void {
    this.workflowSnapshot = structuredClone(snapshot);
    this.planSnapshot = undefined;
    this.planItems =
      snapshot.status === "ready" && snapshot.delivery
        ? snapshot.delivery.milestones.map((milestone) => ({
            id: milestone.id,
            label: `${milestone.id} ${milestone.title}${milestone.stone ? " · Stone" : ""}`,
            status:
              milestone.status === "verified"
                ? "done"
                : ["executing", "pending_stone"].includes(milestone.status)
                  ? "current"
                  : "pending",
            depth: 0,
          }))
        : [];
    this.planCollapsed.clear();
    this.planActionMenu = false;
    this.planNextActionEditing = false;
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setPromptSnapshot(snapshot: PromptPanelSnapshot): void {
    this.promptSnapshot = structuredClone(snapshot);
    this.state.selected = 0;
    this.state.scroll = 0;
    this.promptImportEditing = false;
    this.promptImportPath = "";
  }

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    this.policySnapshot = { ...snapshot };
    if (this.kind === "policy") this.state.selected = Math.max(0, POLICY_LEVELS.indexOf(snapshot.policy));
  }

  setCommandQuery(query: string): void {
    this.commandQuery = query;
    if (query.startsWith("/")) {
      if (this.kind !== "commands") this.open("commands");
      clampSelection(this.state, commandMatches(query).length);
    } else if (this.kind === "commands") {
      this.close();
    }
  }

  handleInput(data: string): PanelEvent | undefined {
    const interactionState = this.interactionState();
    if (matchesInteraction("panel", this.kind, "closePanel", data, interactionState)) {
      if (this.providerEditing) {
        this.providerEditing = false;
        return;
      }
      if (this.providerActionMenu) {
        this.providerActionMenu = false;
        this.providerCostConfirmation = false;
        this.state.selected = Math.max(
          0,
          this.providers.findIndex((item) => item.id === this.activeProviderId),
        );
        return;
      }
      if (this.kind !== "plan") {
        this.close();
        return { type: "close" };
      }
      return;
    }
    if (
      this.kind === "plan" &&
      (this.planActionMenu ||
        this.planNextActionEditing ||
        data === Key.enter ||
        data === Key.up ||
        data === Key.down ||
        data === Key.left ||
        data === Key.right)
    ) {
      return this.handlePlan(data, data === Key.up || data === Key.down ? "moveSelection" : "togglePlanItem");
    }
    if (this.kind === "prompt") return this.handlePrompt(data);
    const interaction = matchingInteraction("panel", this.kind, data, interactionState);
    if (!interaction) return undefined;
    if (this.kind === "commands") return this.handleCommands(data, interaction.handler);
    if (this.kind === "models") return this.handleModels(data);
    if (this.kind === "providers") return this.handleProviders(data);
    if (this.kind === "sessions") return this.handleSessions(data, interaction.handler);
    if (this.kind === "settings") return this.handleSettings(data);
    if (this.kind === "theme") return this.handleTheme(data);
    if (this.kind === "question") return this.handleQuestion(data);
    if (this.kind === "policy") return this.handlePolicy(data);
    if (this.kind === "plan") return this.handlePlan(data, interaction.handler);
    return undefined;
  }

  render(width: number, maxRows: number, theme: VspiTheme, usage: UsageSnapshot, planFocused = false): string[] {
    const bodyWidth = Math.max(1, width - 2);
    this.lastBodyWidth = bodyWidth;
    const bodyRows = Math.max(3, maxRows - 2);
    let title: string;
    let body: string[];
    if (this.kind === "commands") [title, body] = ["命令", this.renderCommands(bodyWidth, theme)];
    else if (this.kind === "prompt") [title, body] = ["Prompt Profile", this.renderPrompt(bodyWidth, theme)];
    else if (this.kind === "models") [title, body] = ["Model", this.renderModels(bodyWidth, theme)];
    else if (this.kind === "providers") [title, body] = ["Provider", this.renderProviders(bodyWidth, theme)];
    else if (this.kind === "sessions") [title, body] = ["Sessions", this.renderSessions(bodyWidth, theme)];
    else if (this.kind === "settings") [title, body] = ["Settings", this.renderSettings(bodyWidth, theme)];
    else if (this.kind === "usage") [title, body] = ["Usage", this.renderUsage(bodyWidth, usage)];
    else if (this.kind === "theme") [title, body] = ["Theme", this.renderTheme(bodyWidth, theme)];
    else if (this.kind === "question") [title, body] = ["Question", this.renderQuestion(bodyWidth, theme)];
    else if (this.kind === "policy") [title, body] = ["Policy", this.renderPolicy(bodyWidth, theme)];
    else [title, body] = ["当前计划", this.renderPlan(bodyWidth, theme, planFocused)];

    let footer: string | undefined;
    if (body.length > bodyRows) {
      // 选中行由 selectedLine 以 "› " 前缀标记；用前缀而不是 includes 避免正文里的 "›" 误判。
      const highlightedRows = body
        .map((line, index) => (stripAnsi(line).startsWith("› ") ? index : -1))
        .filter((index) => index >= 0);
      const selectionStart = Math.max(0, Math.min(highlightedRows[0] ?? this.state.selected, body.length - 1));
      const selectionEnd = highlightedRows.at(-1) ?? selectionStart;
      this.state.scroll = Math.max(0, Math.min(this.state.scroll, body.length - bodyRows));
      if (selectionStart < this.state.scroll) this.state.scroll = selectionStart;
      if (selectionEnd >= this.state.scroll + bodyRows) this.state.scroll = selectionEnd - bodyRows + 1;
      const total = body.length;
      body = body.slice(this.state.scroll, this.state.scroll + bodyRows);
      footer = `${this.state.scroll + 1}-${this.state.scroll + body.length} / ${total}`;
    }
    return frame(body, width, theme, {
      title,
      ...(footer ? { footer } : {}),
      focused: this.kind !== "plan" || planFocused,
      maxBodyLines: bodyRows,
    });
  }

  renderHint(width: number, theme: VspiTheme): string {
    this.lastBodyWidth = Math.max(1, width - 2);
    const hint = renderInteractionHint("panel", this.kind, this.interactionState());
    return theme.muted(padLine(this.kind === "question" ? this.questionHint(hint) : hint, width));
  }

  // Registry 的 Question hint 按 questionMode 粗粒度生成，这里按真实题型补齐/剔除键位。
  private questionHint(hint: string): string {
    if (this.questionReview) return hint;
    const question = this.questions[this.questionIndex];
    if (!question) return hint;
    // 文本输入态下 Shift+S 是字面字符 "S"，跳过不可用，hint 不再宣告。
    if (this.questionDirectAnswer || question.kind === "freeText") return hint.replace("  Shift+S 跳过", "");
    let adjusted = hint;
    if (question.kind === "ranking") adjusted = adjusted.replace("Enter 确认", "Tab 直接回答  Enter 确认");
    if (question.kind !== "multiChoice") adjusted = adjusted.replace("Space 多选  ", "");
    return adjusted;
  }

  acceptsInput(data: string): boolean {
    // 唯一候选的 Tab 补全由 composer 层完成；多候选时面板不拦截 Tab（Registry 宣告了 Tab 补全）。
    if (this.kind === "commands" && panelKey(data, Key.tab)) return false;
    return matchingInteraction("panel", this.kind, data, this.interactionState()) !== undefined;
  }

  private interactionState(): InteractionState {
    const state: InteractionState = { narrowModel: !usesWideModelLayout(this.lastBodyWidth) };
    if (this.kind === "plan") state.hasItems = this.visiblePlanItems().length > 0;
    else if (this.kind === "sessions") state.hasItems = this.sessions.length > 0;
    else if (this.kind === "commands") {
      const matches = commandMatches(this.commandQuery);
      const selected = matches[this.state.selected];
      state.hasItems = selected !== undefined;
      if (selected) state.commandAvailable = getActionDefinition(selected.command)?.availability !== "disabled";
    } else if (this.kind === "providers") {
      state.providerEditing = this.providerEditing;
      state.providerActionMenu = this.providerActionMenu;
      if (this.providerEditing) {
        state.providerField = this.providerField === 0 ? 0 : this.providerField === 1 ? 1 : 2;
        const text = this.providerField === 0 ? this.providerDraft.label : this.providerDraft.baseUrl;
        state.providerTextPresent = this.providerField !== 2 && text.length > 0;
      }
    } else if (this.kind === "policy") {
      state.policyYolo = POLICY_LEVELS[this.state.selected] === "YOLO";
    } else if (this.kind === "question") {
      const question = this.questions[this.questionIndex];
      state.questionMode = this.questionReview
        ? "review"
        : this.questionDirectAnswer || question?.kind === "freeText"
          ? "freeText"
          : question?.kind === "ranking"
            ? "ranking"
            : "choice";
    }
    return state;
  }

  private move(data: string, count: number): boolean {
    if (panelKey(data, Key.up)) {
      this.state.selected = Math.max(0, this.state.selected - 1);
      return true;
    }
    if (panelKey(data, Key.down)) {
      this.state.selected = Math.min(Math.max(0, count - 1), this.state.selected + 1);
      return true;
    }
    return false;
  }

  private handleCommands(data: string, handler: string): PanelEvent | undefined {
    const matches = commandMatches(this.commandQuery);
    if (handler === "moveSelection" && this.move(data, matches.length)) return;
    if (handler === "activateCommand") {
      if (exactCommandCandidates(this.commandQuery).length > 1) return;
      const match = matches[this.state.selected];
      if (match) return { type: "command", command: match.command };
    }
    return undefined;
  }

  private handleModels(data: string): PanelEvent | undefined {
    if (matchesKey(data, Key.tab)) {
      this.modelTab = this.modelTab === 0 ? 1 : 0;
      this.state.selected = 0;
      this.modelNarrowDetail = false;
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.modelNarrowDetail = true;
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.modelNarrowDetail = false;
      return;
    }
    const models = this.filteredModels();
    const count = this.modelTab === 0 ? models.length : this.modelGroups.length;
    if (this.move(data, count)) return;
    if (matchesKey(data, Key.backspace) && this.modelTab === 0) {
      this.modelSearch = this.modelSearch.slice(0, -1);
      this.state.selected = 0;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.modelTab === 0) {
        const model = models[this.state.selected];
        if (model) {
          return { type: "model", model };
        }
      } else {
        const group = this.modelGroups[this.state.selected];
        if (group) {
          return { type: "modelGroup", group };
        }
      }
    }
    const char = printable(data);
    if (char && this.modelTab === 0) {
      this.modelSearch += char;
      this.state.selected = 0;
    }
    return undefined;
  }

  private handleProviders(data: string): PanelEvent | undefined {
    if (this.providerEditing) {
      if (this.move(data, 3)) {
        this.providerField = this.state.selected;
        return;
      }
      if (this.providerField === 2 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
        this.providerDraft.protocol = this.providerDraft.protocol === "Responses" ? "OpenAI compatible" : "Responses";
        return;
      }
      const key = this.providerField === 0 ? "label" : this.providerField === 1 ? "baseUrl" : undefined;
      if (key && matchesKey(data, Key.backspace)) {
        this.providerDraft[key] = this.providerDraft[key].slice(0, -1);
        return;
      }
      const char = printable(data);
      if (key && char) {
        this.providerDraft[key] += char;
        return;
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        const provider = this.providers.find((item) => item.id === this.activeProviderId);
        if (!provider) return { type: "notice", text: "Provider identity 已失效，拒绝保存", tone: "error" };
        this.providerEditing = false;
        return {
          type: "providerSave",
          provider,
          value: {
            name: this.providerDraft.label || provider.label,
            baseUrl: this.providerDraft.baseUrl,
            protocol: this.providerDraft.protocol,
          },
        };
      }
      return;
    }
    if (this.providerActionMenu) {
      if (this.move(data, this.providerActions.length)) {
        this.providerCostConfirmation = false;
        return;
      }
      if (!matchesKey(data, Key.enter)) return;
      const provider = this.providers.find((item) => item.id === this.activeProviderId);
      const action = this.providerActions[this.state.selected];
      if (!provider || !action) {
        this.providerActionMenu = false;
        return { type: "notice", text: "Provider identity 已失效，操作已取消", tone: "error" };
      }
      if (action === "minimal-generation" && !this.providerCostConfirmation) {
        this.providerCostConfirmation = true;
        return { type: "notice", text: "最小生成可能产生费用；再次按 Enter 确认", tone: "warning" };
      }
      if (action === "edit") {
        this.providerEditing = true;
        this.providerActionMenu = false;
        this.providerField = 0;
        this.state.selected = 0;
      }
      const costConfirmed = action === "minimal-generation" && this.providerCostConfirmation;
      this.providerCostConfirmation = false;
      return { type: "providerAction", provider, action, ...(costConfirmed ? { costConfirmed } : {}) };
    }
    if (this.move(data, this.providers.length)) return;
    if (matchesKey(data, Key.enter)) {
      const provider = this.providers[this.state.selected];
      if (!provider) return;
      this.activeProviderId = provider.id;
      this.providerDraft = {
        label: provider.label,
        baseUrl: provider.baseUrl ?? "https://",
        protocol: provider.protocol,
      };
      this.providerActionMenu = true;
      this.providerCostConfirmation = false;
      this.state.selected = 0;
      return { type: "providerActions", provider, actions: [...this.providerActions] };
    }
    return undefined;
  }

  private handleSessions(data: string, handler: string): PanelEvent | undefined {
    if (handler === "moveSelection" && this.move(data, this.sessions.length)) return;
    const session = this.sessions[this.state.selected];
    if (!session) return;
    if (handler === "openSession") return { type: "session", session };
    if (handler === "forkSession") return { type: "fork", session };
    return undefined;
  }

  private handleSettings(data: string): PanelEvent | undefined {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.settingsTab = this.settingsTab === 0 ? 1 : 0;
      this.settings.scope = this.settingsTab === 0 ? "global" : "project";
      return { type: "settings", settings: { ...this.settings } };
    }
    const rows = this.settingRows();
    if (this.move(data, rows.length)) return;
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const row = rows[this.state.selected];
      if (!row) return;
      if (row.key === "theme") {
        this.open("theme");
        return;
      }
      const key = row.key;
      this.settings[key] = !this.settings[key];
      return { type: "settings", settings: { ...this.settings } };
    }
    return undefined;
  }

  private handleTheme(data: string): PanelEvent | undefined {
    const themes: AppSettings["theme"][] = ["VSPi Dark", "VSPi Light", "Terminal"];
    if (this.move(data, themes.length)) return;
    if (matchesKey(data, Key.enter)) {
      const selected = themes[this.state.selected];
      if (selected) {
        this.settings.theme = selected;
        return { type: "settings", settings: { ...this.settings } };
      }
    }
    return undefined;
  }

  private handlePolicy(data: string): PanelEvent | undefined {
    if (this.move(data, POLICY_LEVELS.length)) return;
    if (!matchesKey(data, Key.enter)) return;
    const policy = POLICY_LEVELS[this.state.selected];
    if (!policy) return;
    return { type: "policyChange", policy, requiresAcknowledgement: policy === "YOLO" };
  }

  private handlePlan(data: string, handler: string): PanelEvent | undefined {
    const visible = this.visiblePlanItems();
    if (this.planNextActionEditing) {
      if (panelKey(data, Key.ctrl("u"))) {
        this.planNextActionInput = "";
        return;
      }
      if (panelKey(data, Key.backspace)) {
        this.planNextActionInput = this.planNextActionInput.slice(0, -1);
        return;
      }
      if (panelKey(data, Key.enter) && this.planSnapshot) {
        const event: PanelEvent = {
          type: "planEdit",
          planId: this.planSnapshot.id,
          expectedRevision: this.planSnapshot.revision,
          operation: { kind: "nextAction", value: this.planNextActionInput },
        };
        this.planNextActionEditing = false;
        this.planActionMenu = false;
        return event;
      }
      const value = printable(data);
      if (value) this.planNextActionInput = `${this.planNextActionInput}${value}`.slice(0, 4_000);
      return;
    }
    if (this.planActionMenu) {
      if (panelKey(data, Key.up)) this.planActionIndex = Math.max(0, this.planActionIndex - 1);
      else if (panelKey(data, Key.down)) this.planActionIndex = Math.min(2, this.planActionIndex + 1);
      else if (panelKey(data, Key.escape)) this.planActionMenu = false;
      else if (panelKey(data, Key.enter) && this.planSnapshot) {
        const item = visible[this.state.selected];
        if (!item) return;
        if (this.planActionIndex === 0) {
          this.planActionMenu = false;
          return {
            type: "planEdit",
            planId: this.planSnapshot.id,
            expectedRevision: this.planSnapshot.revision,
            operation: { kind: "status", itemId: item.id, status: nextPlanStatus(item.id, this.planSnapshot) },
          };
        }
        if (this.planActionIndex === 1) {
          this.planActionMenu = false;
          return {
            type: "planEdit",
            planId: this.planSnapshot.id,
            expectedRevision: this.planSnapshot.revision,
            operation: { kind: "focus", itemId: item.id },
          };
        }
        this.planNextActionEditing = true;
        this.planNextActionInput = this.planSnapshot.nextAction ?? "";
      }
      return;
    }
    if (handler === "moveSelection" && this.move(data, visible.length)) return;
    const item = visible[this.state.selected];
    if (!item) return;
    if (matchesKey(data, Key.left)) {
      this.planCollapsed.add(item.id);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.planCollapsed.delete(item.id);
      return;
    }
    if (panelKey(data, Key.enter) && this.planSnapshot) {
      this.planActionMenu = true;
      this.planActionIndex = 0;
    }
    return undefined;
  }

  private handlePrompt(data: string): PanelEvent | undefined {
    if (this.promptImportEditing) {
      if (panelKey(data, Key.ctrl("u"))) {
        this.promptImportPath = "";
        return;
      }
      if (panelKey(data, Key.backspace)) {
        this.promptImportPath = this.promptImportPath.slice(0, -1);
        return;
      }
      if (data === "\r" || data === Key.enter) {
        if (!this.promptImportPath) return;
        const event: PanelEvent = { type: "promptImport", path: this.promptImportPath, scope: "session" };
        this.promptImportEditing = false;
        this.promptImportPath = "";
        return event;
      }
      const value = printable(data);
      if (value) this.promptImportPath = `${this.promptImportPath}${value}`.slice(0, 4_096);
      return;
    }
    const profiles = this.promptSnapshot.profiles;
    if (data === Key.up) {
      this.state.selected = Math.max(0, this.state.selected - 1);
      return;
    }
    if (data === Key.down) {
      this.state.selected = Math.min(Math.max(0, profiles.length - 1), this.state.selected + 1);
      return;
    }
    const profile = profiles[this.state.selected];
    if (data === Key.enter && profile) return { type: "promptPin", profileId: profile.id };
    if (data === "o") return { type: "promptOff" };
    if (data === "f" && profile) return { type: "promptFork", profileId: profile.id };
    if (data === "i") {
      this.promptImportEditing = true;
      this.promptImportPath = "";
      return;
    }
    if (data === "e" && profile) return { type: "promptExport", profileId: profile.id };
    if (data === "t") {
      const rule = this.promptSnapshot.rules[0];
      if (rule) {
        return {
          type: "promptToggleRule",
          ruleId: rule.id,
          ownerScope: rule.ownerScope,
          enabled: !rule.enabled,
        };
      }
    }
    return undefined;
  }

  private handleQuestion(data: string): PanelEvent | undefined {
    if (this.questionReview) {
      if (panelKey(data, Key.enter)) return { type: "questions", questions: structuredClone(this.questions) };
      if (panelKey(data, Key.left)) {
        this.questionReview = false;
        this.questionIndex = this.questions.length - 1;
      }
      return;
    }
    const question = this.questions[this.questionIndex];
    if (!question) return;
    if (panelKey(data, Key.left) || panelKey(data, Key.right)) {
      const offset = panelKey(data, Key.left) ? -1 : 1;
      this.questionIndex = Math.max(0, Math.min(this.questions.length - 1, this.questionIndex + offset));
      this.questionDirectAnswer = false;
      this.questionInput = "";
      this.state.selected = 0;
      return;
    }
    if (this.questionDirectAnswer || question.kind === "freeText") {
      if (panelKey(data, Key.backspace)) {
        this.questionInput = this.questionInput.slice(0, -1);
        return;
      }
      if (panelKey(data, Key.enter)) {
        question.answer = this.questionInput;
        this.advanceQuestion();
        return;
      }
      const char = printable(data);
      if (char && Array.from(this.questionInput).length < 2_000) this.questionInput += char;
      return;
    }
    // 跳过键只在选择/排序导航态生效；freeText 输入态下 Shift+S 是字面字符 "S"。
    if (panelKey(data, Key.shift("s"))) {
      question.skipped = true;
      this.advanceQuestion();
      return;
    }
    const options = [...(question.options ?? []), { id: "other", label: "其他" }];
    if (this.move(data, options.length)) return;
    if (panelKey(data, Key.tab)) {
      this.questionDirectAnswer = true;
      this.questionInput = "";
      return;
    }
    const rankingUp = panelKey(data, Key.ctrl("up")) || panelKey(data, Key.alt("up"));
    const rankingDown = panelKey(data, Key.ctrl("down")) || panelKey(data, Key.alt("down"));
    if (question.kind === "ranking" && (rankingUp || rankingDown)) {
      const current = question.options ?? [];
      const from = this.state.selected;
      const to = rankingUp ? Math.max(0, from - 1) : Math.min(current.length - 1, from + 1);
      const [item] = current.splice(from, 1);
      if (item) current.splice(to, 0, item);
      this.state.selected = to;
      return;
    }
    if (panelKey(data, Key.enter) || panelKey(data, Key.space)) {
      const selected = options[this.state.selected];
      if (!selected) return;
      if (selected.id === "other") {
        this.questionDirectAnswer = true;
        this.questionInput = "";
        return;
      }
      if (question.kind === "multiChoice") {
        const answer = Array.isArray(question.answer) ? question.answer : [];
        if (panelKey(data, Key.space)) {
          question.answer = answer.includes(selected.id)
            ? answer.filter((id) => id !== selected.id)
            : [...answer, selected.id];
        } else {
          if (!question.answer) question.answer = [];
          this.advanceQuestion();
        }
      } else if (question.kind === "ranking") {
        question.answer = (question.options ?? []).map((item) => item.id);
        this.advanceQuestion();
      } else {
        question.answer = selected.id;
        this.advanceQuestion();
      }
    }
    return undefined;
  }

  private advanceQuestion(): void {
    this.questionDirectAnswer = false;
    this.questionInput = "";
    this.state.selected = 0;
    if (this.questionIndex >= this.questions.length - 1) this.questionReview = true;
    else this.questionIndex += 1;
  }

  private renderCommands(width: number, theme: VspiTheme): string[] {
    const matches = commandMatches(this.commandQuery);
    if (matches.length === 0) return [theme.muted(padLine("没有匹配的命令", width))];
    const lines: string[] = [];
    let group: CommandDefinition["group"] | undefined;
    matches.forEach((match, index) => {
      const command = match.command;
      if (command.group !== group) {
        group = command.group;
        lines.push(theme.muted(padLine(`  ${group}`, width)));
      }
      lines.push(...this.renderCommandRow(match, index === this.state.selected, width, theme));
    });
    return lines;
  }

  private renderCommandRow(match: CommandMatch, selected: boolean, width: number, theme: VspiTheme): string[] {
    const query = this.commandQuery.trim();
    const matchedToken = emphasizePrefix(match.matchedToken, query, theme);
    const aliases = match.command.aliases.map((alias) => `/${alias}`);
    const identity =
      match.matchKind === "alias"
        ? `别名（${matchedToken}） → ${theme.blue(match.canonicalToken)}`
        : `${matchedToken}${aliases.length > 0 ? theme.muted(`  ${aliases.join(" · ")}`) : ""}`;
    const source = match.source === BUILTIN_COMMAND_SOURCE ? "Built-in" : match.source;
    const action = getActionDefinition(match.command);
    const description =
      action?.availability === "disabled"
        ? (action.disabledReason ?? match.command.description)
        : match.command.description;

    if (width < 58) {
      const available = Math.max(1, width - 2);
      const sourceWidth = Math.min(15, Math.max(8, visibleWidth(source)));
      const descriptionWidth = Math.max(1, available - sourceWidth);
      const detailText = truncateStart(description, descriptionWidth);
      const detail = `${padLine(theme.muted(detailText), descriptionWidth)}${padLine(theme.muted(source), sourceWidth)}`;
      return [selectedLine(identity, selected, width, theme), selectedLine(detail, selected, width, theme)];
    }

    const available = Math.max(1, width - 2);
    const identityWidth = width >= 100 ? 38 : 28;
    const sourceWidth = width >= 100 ? 20 : 16;
    const descriptionWidth = Math.max(1, available - identityWidth - sourceWidth);
    const row = `${padLine(identity, identityWidth)}${padLine(description, descriptionWidth)}${padLine(theme.muted(source), sourceWidth)}`;
    return [selectedLine(row, selected, width, theme)];
  }

  private filteredModels(): ModelOption[] {
    const query = this.modelSearch.toLowerCase();
    const brandIndex = (brand: string) => {
      const index = BRAND_PRIORITY.indexOf(brand);
      return index === -1 ? BRAND_PRIORITY.length : index;
    };
    return this.models
      .filter((model) => !query || `${model.brand} ${model.label} ${model.id}`.toLowerCase().includes(query))
      .sort((left, right) => {
        const brand = brandIndex(left.brand) - brandIndex(right.brand);
        if (brand !== 0) return brand;
        if (left.releasedAt && right.releasedAt) return right.releasedAt.localeCompare(left.releasedAt);
        return 0;
      });
  }

  private renderModels(width: number, theme: VspiTheme): string[] {
    const modelTab = this.modelSearch ? `选择模型 · ${this.modelSearch}` : "选择模型";
    const tabs = tabLine([modelTab, "模型组"], this.modelTab, width, theme);
    const body = usesWideModelLayout(width)
      ? this.renderWideModels(width, theme)
      : this.renderNarrowModels(width, theme);
    return [tabs, ...body];
  }

  private renderWideModels(width: number, theme: VspiTheme): string[] {
    const rowCount = width >= 90 ? 6 : 5;
    const leftWidth = Math.max(18, Math.floor((width - 1) * 0.4));
    const rightWidth = width - leftWidth - 1;
    const left = this.modelListRows(rowCount, leftWidth, theme);
    const right =
      this.modelTab === 0 ? this.modelDetailRows(rowCount, theme) : this.modelGroupDetailRows(rowCount, theme);
    return Array.from({ length: rowCount }, (_, index) => {
      const leftRow = left[index] ?? padLine("", leftWidth);
      const rightRow = padLine(right[index] ?? "", rightWidth);
      return `${leftRow}${theme.border("│")}${rightRow}`;
    });
  }

  private renderNarrowModels(width: number, theme: VspiTheme): string[] {
    const rowCount = 5;
    if (this.modelNarrowDetail) {
      const details =
        this.modelTab === 0 ? this.modelDetailRows(rowCount, theme) : this.modelGroupDetailRows(rowCount, theme);
      return Array.from({ length: rowCount }, (_, index) => padLine(details[index] ?? "", width));
    }
    return this.modelListRows(rowCount, width, theme);
  }

  private modelListRows(rowCount: number, width: number, theme: VspiTheme): string[] {
    const items = this.modelTab === 0 ? this.filteredModels() : this.modelGroups;
    const start = Math.max(0, Math.min(this.state.selected - Math.floor(rowCount / 2), items.length - rowCount));
    return Array.from({ length: rowCount }, (_, row) => {
      const index = start + row;
      const item = items[index];
      if (!item) return padLine("", width);
      const selected = index === this.state.selected;
      const active =
        this.modelTab === 0
          ? modelKey(item as ModelOption) === this.selectedModelKey
          : (item as ModelGroup).id === this.selectedGroupId;
      const marker = selected ? theme.focus("› ") : "  ";
      const check = active ? theme.success("✓ ") : "  ";
      const vision = this.modelTab === 0 && (item as ModelOption).vision ? theme.blue(" ◉") : "";
      const line = padLine(`${marker}${check}${item.label}${vision}`, width);
      return selected ? theme.selected(line) : line;
    });
  }

  private modelDetailRows(rowCount: number, theme: VspiTheme): string[] {
    const model = this.filteredModels()[this.state.selected];
    if (!model) return [theme.muted("没有匹配的模型")];
    const input = model.price.inputUsdPerMillion * FX.fxRate;
    const output = model.price.outputUsdPerMillion * FX.fxRate;
    const provider = `${theme.muted("Provider  ")}${model.brand}`;
    const modelId = `${theme.muted("Model ID  ")}${model.id}`;
    const capability = `${theme.muted("能力  ")}${model.vision ? "文本 · 图片" : "文本"}`;
    const effort = `${theme.muted("Effort  ")}${model.efforts.join(" / ")}`;
    const release = model.releasedAt ? `${theme.muted("发布  ")}${model.releasedAt}` : "";
    const price = `${theme.warning("输入 ¥")}${input.toFixed(2)} / 百万  ${theme.warning("输出 ¥")}${output.toFixed(2)} / 百万`;
    if (rowCount >= 6) {
      return [theme.bold(theme.focus(model.label)), provider, modelId, `${capability}  ${effort}`, release, price];
    }
    return [
      theme.bold(theme.focus(model.label)),
      `${provider}  ${modelId}`,
      `${capability}  ${effort}`,
      release,
      price,
    ];
  }

  private modelGroupDetailRows(rowCount: number, theme: VspiTheme): string[] {
    const group = this.modelGroups[this.state.selected];
    if (!group) return [theme.muted("没有匹配的模型组")];
    const rows = [theme.bold(theme.focus(group.label))];
    for (const role of group.roles) {
      const model = this.models.find((item) => item.id === role.modelId);
      rows.push(`${theme.muted(`${role.role}  `)}${model?.label ?? role.modelId} · Effort ${role.effort}`);
    }
    return rows.slice(0, rowCount);
  }

  private renderProviders(width: number, theme: VspiTheme): string[] {
    if (this.providerEditing) {
      const fields = [
        ["名称", this.providerDraft.label || "自定义 Provider"],
        ["Base URL", this.providerDraft.baseUrl],
        ["协议", this.providerDraft.protocol],
      ];
      return fields.map(([label, value], index) =>
        selectedLine(`${theme.muted(`${label}  `)}${value}`, index === this.providerField, width, theme),
      );
    }
    if (this.providerActionMenu) {
      const labels: Record<string, string> = {
        edit: "编辑本地配置",
        "check-config": "检查配置（离线）",
        "test-connection": "测试连接（网络）",
        "minimal-generation": "最小生成（需费用确认）",
      };
      return this.providerActions.map((action, index) =>
        selectedLine(
          action === "minimal-generation" && this.providerCostConfirmation
            ? "再次 Enter 确认最小生成费用"
            : (labels[action] ?? action),
          index === this.state.selected,
          width,
          theme,
        ),
      );
    }
    if (this.providers.length === 0) return [theme.muted(padLine("没有可用 Provider", width))];
    if (width >= MODEL_WIDE_MIN_BODY_WIDTH) {
      const rowCount = 5;
      const leftWidth = Math.max(20, Math.floor((width - 1) * 0.4));
      const rightWidth = width - leftWidth - 1;
      const list = this.providerListRows(rowCount, leftWidth, theme);
      const provider = this.providers[this.state.selected];
      const details = provider
        ? [
            theme.bold(theme.focus(provider.label)),
            `${theme.muted("Provider ID  ")}${provider.id}`,
            `${theme.muted("协议  ")}${provider.protocol}`,
            `${theme.muted("状态  ")}${provider.status}`,
            `${theme.muted("来源  ")}${provider.detail}`,
          ]
        : [theme.muted("没有可用 Provider")];
      return Array.from(
        { length: rowCount },
        (_, index) =>
          `${list[index] ?? padLine("", leftWidth)}${theme.border("│")}${padLine(details[index] ?? "", rightWidth)}`,
      );
    }
    return this.providerListRows(this.providers.length, width, theme);
  }

  private providerListRows(rowCount: number, width: number, theme: VspiTheme): string[] {
    const start = Math.max(
      0,
      Math.min(this.state.selected - Math.floor(rowCount / 2), Math.max(0, this.providers.length - rowCount)),
    );
    return Array.from({ length: rowCount }, (_, row) => {
      const index = start + row;
      const provider = this.providers[index];
      if (!provider) return padLine("", width);
      const status = statusStyle(provider.status, theme)(provider.status);
      return selectedLine(
        alignRight(`${provider.label}  ${theme.muted(provider.protocol)}`, status, Math.max(1, width - 2)),
        index === this.state.selected,
        width,
        theme,
      );
    });
  }

  private renderSessions(width: number, theme: VspiTheme): string[] {
    if (this.sessions.length === 0) return [theme.muted(padLine("暂无会话", width))];
    return this.sessions.map((session, index) => {
      const branch = session.branchDepth > 0 ? `${theme.muted("└─")} ` : "";
      const current = session.current ? theme.success("● ") : "  ";
      return selectedLine(
        alignRight(
          `${"  ".repeat(session.branchDepth)}${branch}${current}${session.label}`,
          session.relativeTime,
          Math.max(1, width - 2),
        ),
        index === this.state.selected,
        width,
        theme,
      );
    });
  }

  private settingRows(): Array<{
    label: string;
    key: "theme" | "reducedMotion" | "showThinking" | "wrapCode" | "bridgeEnabled";
    group: string;
  }> {
    return [
      { group: "外观", label: `主题  ${this.settings.theme}`, key: "theme" },
      { group: "外观", label: `减少动效  ${this.settings.reducedMotion ? "开" : "关"}`, key: "reducedMotion" },
      { group: "Transcript", label: `显示 thinking  ${this.settings.showThinking ? "开" : "关"}`, key: "showThinking" },
      { group: "Transcript", label: `代码自动换行  ${this.settings.wrapCode ? "开" : "关"}`, key: "wrapCode" },
      { group: "附件", label: `SSH 图片桥接  ${this.settings.bridgeEnabled ? "开" : "关"}`, key: "bridgeEnabled" },
    ];
  }

  private renderSettings(width: number, theme: VspiTheme): string[] {
    const lines = [tabLine(["全局", "项目"], this.settingsTab, width, theme)];
    let group: string | undefined;
    this.settingRows().forEach((row, index) => {
      if (row.group !== group) {
        group = row.group;
        lines.push(theme.muted(padLine(`  ${group}`, width)));
      }
      lines.push(selectedLine(row.label, index === this.state.selected, width, theme));
    });
    lines.push(theme.muted(padLine("  键位方案  VSPi 默认", width)));
    return lines;
  }

  private renderUsage(width: number, usage: UsageSnapshot): string[] {
    return [
      alignRight("上下文", formatContextUsage(usage), width),
      alignRight("输入 Token", usage.inputTokens.toLocaleString("zh-CN"), width),
      alignRight("输出 Token", usage.outputTokens.toLocaleString("zh-CN"), width),
      alignRight("原始费用", `$${usage.costUsd.toFixed(4)} USD`, width),
      alignRight("人民币估算", `约 ¥${(usage.costUsd * usage.fxRate).toFixed(2)}`, width),
    ];
  }

  private renderTheme(width: number, theme: VspiTheme): string[] {
    const themes: AppSettings["theme"][] = ["VSPi Dark", "VSPi Light", "Terminal"];
    return themes.map((name, index) =>
      selectedLine(
        `${name === this.settings.theme ? theme.success("✓ ") : "  "}${name}`,
        index === this.state.selected,
        width,
        theme,
      ),
    );
  }

  private renderPolicy(width: number, theme: VspiTheme): string[] {
    const rows = POLICY_LEVELS.map((policy, index) => {
      const active = policy === this.policySnapshot.policy;
      const boundary = policy === "YOLO" ? "Host" : "Sandboxed";
      return selectedLine(
        `${active ? theme.success("✓ ") : "  "}${policy} · ${boundary}`,
        index === this.state.selected,
        width,
        theme,
      );
    });
    const selected = POLICY_LEVELS[this.state.selected];
    if (selected === "YOLO") {
      rows.push(theme.warning(padLine("YOLO · Host 高风险：绕过 VSPi approval 与 sandbox；Enter 明确确认", width)));
    } else if (this.policySnapshot.recovery) {
      rows.push(theme.warning(padLine("Recovery 强制 Standard · Sandboxed，拒绝切换", width)));
    } else {
      rows.push(theme.muted(padLine("Safe 只读 · Standard 默认询问 · Auto 有界免询问", width)));
    }
    return rows;
  }

  private visiblePlanItems(): PlanItem[] {
    const output: PlanItem[] = [];
    let hiddenDepth: number | undefined;
    for (const item of this.planItems) {
      if (hiddenDepth !== undefined && item.depth > hiddenDepth) continue;
      hiddenDepth = undefined;
      output.push(item);
      if (item.depth === 0 && this.planCollapsed.has(item.id)) hiddenDepth = item.depth;
    }
    return output;
  }

  private renderPlan(width: number, theme: VspiTheme, focused: boolean): string[] {
    if (this.workflowSnapshot) return this.renderWorkflowPlan(width, theme, focused);
    const items = this.visiblePlanItems();
    if (items.length === 0) return [theme.muted(padLine("当前计划为空", width))];
    const snapshot = this.planSnapshot;
    const complete = this.planItems.filter((item) => item.status === "done").length;
    const lines = snapshot
      ? [
          alignRight(
            theme.bold(snapshot.title),
            theme.muted(`r${snapshot.revision} · ${complete}/${this.planItems.length}`),
            width,
          ),
          padLine(`目标  ${snapshot.goal}`, width),
          ...(snapshot.background ? [padLine(`背景  ${snapshot.background}`, width)] : []),
          ...snapshot.challenges.map((challenge) => padLine(`难点  ${challenge}`, width)),
        ]
      : [alignRight("", theme.muted(`${complete} / ${this.planItems.length}`), width)];
    items.forEach((item, index) => {
      const symbol =
        item.status === "done" ? theme.success("✓") : item.status === "current" ? theme.focus("●") : theme.muted("○");
      const sourceIndex = this.planItems.findIndex((candidate) => candidate.id === item.id);
      const hasChildren = (this.planItems[sourceIndex + 1]?.depth ?? 0) > item.depth;
      const fold = hasChildren ? (this.planCollapsed.has(item.id) ? "▸ " : "▾ ") : "  ";
      lines.push(
        selectedLine(
          `${"  ".repeat(item.depth)}${fold}${symbol} ${item.label}`,
          focused && index === this.state.selected,
          width,
          theme,
        ),
      );
    });
    if (snapshot) {
      for (const blocker of snapshot.blockers) lines.push(theme.warning(padLine(`阻塞  ${blocker}`, width)));
      if (snapshot.nextAction) lines.push(theme.blue(padLine(`下一步  ${snapshot.nextAction}`, width)));
      if (this.planActionMenu) {
        lines.push(selectedLine("状态", this.planActionIndex === 0, width, theme));
        lines.push(selectedLine("焦点", this.planActionIndex === 1, width, theme));
        lines.push(selectedLine("下一步", this.planActionIndex === 2, width, theme));
      }
      if (this.planNextActionEditing) {
        lines.push(theme.focus(padLine(`下一步  ${this.planNextActionInput}${theme.inverse(" ")}`, width)));
      }
    }
    return lines;
  }

  private renderWorkflowPlan(width: number, theme: VspiTheme, focused: boolean): string[] {
    const snapshot = this.workflowSnapshot;
    if (!snapshot) return [theme.muted(padLine("Workflow Plan 未加载", width))];
    if (snapshot.status !== "ready" || !snapshot.delivery) {
      return [
        alignRight(theme.bold("Workflow Plan"), theme.warning(snapshot.status), width),
        theme.muted(padLine(snapshot.diagnostic, width)),
      ];
    }
    const delivery = snapshot.delivery;
    const identity = snapshot.identity;
    const lines = [
      alignRight(theme.bold(delivery.id), theme.muted(`r${delivery.revision} · ${delivery.status}`), width),
      padLine(
        `Workflow  Host Contract v${identity?.contractVersion ?? "?"} · ${identity?.version ?? "unknown"}`,
        width,
      ),
      padLine(`Plan  ${delivery.planHash.slice(0, 12)} · ${delivery.kind}`, width),
    ];
    this.visiblePlanItems().forEach((item, index) => {
      const milestone = delivery.milestones.find((candidate) => candidate.id === item.id);
      const symbol =
        item.status === "done" ? theme.success("✓") : item.status === "current" ? theme.focus("●") : theme.muted("○");
      lines.push(
        selectedLine(
          `${symbol} ${item.label} · ${milestone?.status ?? "unknown"}`,
          focused && index === this.state.selected,
          width,
          theme,
        ),
      );
    });
    if (delivery.currentMilestoneId) lines.push(theme.blue(padLine(`当前  ${delivery.currentMilestoneId}`, width)));
    lines.push(theme.muted(padLine(`Core  ${identity?.sourceCommit.slice(0, 12) ?? "unknown"}`, width)));
    return lines;
  }

  private renderPrompt(width: number, theme: VspiTheme): string[] {
    const snapshot = this.promptSnapshot;
    const lines = [
      alignRight(
        theme.bold("Prompt Profile"),
        snapshot.resolved.disabled
          ? theme.warning("Off")
          : theme.muted(`${snapshot.resolved.scope}${snapshot.resolved.pinned ? " · pinned" : ""}`),
        width,
      ),
    ];
    snapshot.profiles.forEach((profile, index) => {
      const active = profile.active || profile.id === snapshot.resolved.profileId;
      const evaluation =
        profile.evaluationStatus === "unreviewed"
          ? "未评测"
          : profile.evaluationStatus === "verified"
            ? "已验证"
            : "已评审";
      lines.push(
        selectedLine(
          `${active ? theme.success("✓ ") : "  "}${profile.name} · ${profile.sourceType === "factory" ? "Factory" : profile.sourceType} · ${evaluation}`,
          index === this.state.selected,
          width,
          theme,
        ),
      );
    });
    for (const rule of snapshot.rules) {
      lines.push(padLine(`规则  ${rule.enabled ? "✓" : "○"} ${rule.label}`, width));
    }
    const labels: Record<PromptPanelSnapshot["effectiveSegments"][number]["source"], string> = {
      "pi-base": "Pi base",
      system: "SYSTEM",
      append: "APPEND",
      context: "context",
      profile: "Profile",
      plan: "Plan",
    };
    for (const segment of snapshot.effectiveSegments) {
      lines.push(padLine(`${labels[segment.source]}  ${redactPrompt(segment.content)}`, width));
    }
    if (this.promptImportEditing) lines.push(selectedLine(`导入路径  ${this.promptImportPath}`, true, width, theme));
    return lines;
  }

  private renderQuestion(width: number, theme: VspiTheme): string[] {
    const answered = this.questions.filter((question) => question.answer !== undefined).length;
    const skipped = this.questions.filter((question) => question.skipped).length;
    const status = theme.muted(`已答 ${answered} · 跳过 ${skipped}`);
    if (this.questionReview) {
      const lines = [alignRight(theme.bold("最终检查"), status, width)];
      for (const question of this.questions) {
        const answer = question.skipped
          ? "已跳过"
          : Array.isArray(question.answer)
            ? question.answer.join(" → ")
            : question.answer || "未回答";
        lines.push(padLine(`${question.title}  ${theme.blue(answer)}`, width));
      }
      lines.push(theme.selected(padLine(" 提交答案 ", width)));
      return lines;
    }
    const question = this.questions[this.questionIndex];
    if (!question) return [];
    const lines = [
      alignRight(
        theme.bold(`第 ${this.questionIndex + 1}/${this.questions.length} · ${question.title}`),
        status,
        width,
      ),
      ...wrapTextWithAnsi(question.prompt, width),
    ];
    if (this.questionDirectAnswer || question.kind === "freeText") {
      lines.push(theme.selected(padLine(` ${this.questionInput}${this._cursor(theme)} `, width)));
      return lines;
    }
    const options = [...(question.options ?? []), { id: "other", label: "其他" }];
    options.forEach((option, index) => {
      const answer = Array.isArray(question.answer) ? question.answer : [];
      const checked = question.kind === "multiChoice" && answer.includes(option.id) ? theme.success("✓ ") : "";
      const rank = question.kind === "ranking" && option.id !== "other" ? `${index + 1}. ` : "";
      lines.push(
        selectedLine(
          `${checked}${rank}${option.label}${"description" in option && option.description ? theme.muted(`  ${option.description}`) : ""}`,
          index === this.state.selected,
          width,
          theme,
        ),
      );
    });
    lines.push(theme.muted(padLine("  直接回答    跳过", width)));
    return lines;
  }

  private _cursor(theme: VspiTheme): string {
    return theme.inverse(" ");
  }
}

function modelKey(model: { provider?: string; id: string } | undefined): string {
  return model ? `${model.provider ?? ""}\u0000${model.id}` : "";
}

function flattenPlanItems(plan: StoredPlan): PlanItem[] {
  const result: PlanItem[] = [];
  const visit = (items: StoredPlan["items"], depth: number): void => {
    for (const item of items) {
      result.push({
        id: item.id,
        label: `${item.title}${item.id === plan.focusItemId ? "  [焦点]" : ""}${item.blocker ? `  · ${item.blocker}` : ""}`,
        status: item.status === "done" ? "done" : item.id === plan.focusItemId ? "current" : "pending",
        depth,
      });
      if (item.children) visit(item.children, depth + 1);
    }
  };
  visit(plan.items, 0);
  return result;
}

function nextPlanStatus(itemId: string, plan: StoredPlan): PlanStatus {
  const stack = [...plan.items];
  while (stack.length > 0) {
    const item = stack.shift();
    if (!item) break;
    if (item.id === itemId) {
      if (item.status === "pending") return "in_progress";
      if (item.status === "in_progress" || item.status === "blocked") return "done";
      return "pending";
    }
    if (item.children) stack.unshift(...item.children);
  }
  return "pending";
}
