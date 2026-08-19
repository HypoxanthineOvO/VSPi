import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import type { AgentRunSnapshot, AgentSnapshot } from "../agents/types.js";
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
import { effortLabel } from "../domain/effort.js";
import type {
  AppSettings,
  EffortLevel,
  ModelGroup,
  ModelOption,
  PlanItem,
  ProviderOption,
  Question,
  SessionOption,
  UsageSnapshot,
} from "../domain/types.js";
import type { StoredGoal } from "../goals/types.js";
import type { PlanStatus, StoredPlan } from "../plans/types.js";
import {
  type ApprovalRequest,
  type ApprovalResponse,
  POLICY_LEVELS,
  type PolicyLevel,
  type PolicySnapshot,
} from "../policy/execution-policy.js";
import { redactPrompt } from "../prompts/effective-prompt.js";
import { BRAND_PRIORITY, providerPriorityIndex } from "../providers/builtins.js";
import type { ExternalSessionSource, ExternalSessionSummary } from "../sessions/external-history.js";
import type {
  SkillCatalogIssue,
  SkillCatalogItem,
  SkillCatalogSnapshot,
  SkillCatalogTab,
  SkillScope,
} from "../skills/types.js";
import { TOOL_CAPABILITIES, type ToolCapabilityStatus } from "../tools/capability-catalog.js";
import type { WorkflowSnapshot } from "../workflow/types.js";
import {
  alignRight,
  emphasizePrefix,
  frame,
  padLine,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./ansi.js";
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
  | "goal"
  | "prompt"
  | "commands"
  | "models"
  | "providers"
  | "sessions"
  | "externalImport"
  | "skills"
  | "settings"
  | "usage"
  | "theme"
  | "question"
  | "approval"
  | "effort"
  | "tools"
  | "agents"
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
  | { type: "externalImport"; session: ExternalSessionSummary }
  | { type: "skillInstall"; source: string; scope: SkillScope }
  | { type: "skillAgentSearch"; query: string }
  | { type: "skillToggle"; skill: SkillCatalogItem; enabled: boolean }
  | { type: "skillUpdate"; skill: SkillCatalogItem }
  | { type: "skillRemove"; skill: SkillCatalogItem }
  | { type: "settings"; settings: AppSettings }
  | { type: "effort"; effort: EffortLevel }
  | { type: "approval"; response: ApprovalResponse }
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

type SkillRow = { kind: "skill"; item: SkillCatalogItem } | { kind: "issue"; issue: SkillCatalogIssue };

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

type ModelListEntry =
  | { type: "provider"; key: string; label: string; count: number }
  | { type: "model"; model: ModelOption; modelIndex: number; providerKey: string };

const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  ready: "就绪",
  uninitialized: "未初始化",
  unavailable: "不可用",
  disabled: "已禁用",
  error: "错误",
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  waiting_for_stone: "等待锚定",
  executing: "执行中",
  pending: "待启动",
  completed: "已完成",
  verified: "已验证",
};

const DELIVERY_KIND_LABELS: Record<string, string> = {
  cycle: "周期",
  plan: "计划",
  goal: "目标",
};

const GOAL_STATE_LABELS: Record<StoredGoal["state"], string> = {
  executing: "执行中",
  paused: "已暂停",
  blocked: "已阻塞",
  stalled: "无进展停止",
  pending_acceptance: "等待验收",
  completed: "已完成",
  cancelled: "已取消",
};

function usesWideModelLayout(bodyWidth: number): boolean {
  return bodyWidth >= MODEL_WIDE_MIN_BODY_WIDTH;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase() + value.slice(1);
}

function formatAgentTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value / 1_000)}K`;
}

/** C19 P0-5：run 从 startedAt 起算的实际耗时；未开始或时间缺失时返回占位。 */
function agentElapsed(run: AgentRunSnapshot): string {
  if (!run.startedAt) return "—";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
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

function workingStyleLabel(style: AppSettings["workingStyle"]): string {
  if (style === 1) return "1 · 小方块";
  if (style === 2) return "2 · 大圆";
  return "3 · 大圆 + 思考格";
}

function thinkingDisplayLabel(mode: AppSettings["thinkingDisplay"]): string {
  if (mode === "hidden") return "隐藏";
  if (mode === "expanded") return "展开";
  return "折叠";
}

function fullscreenScrollbarLabel(mode: AppSettings["fullscreenScrollbar"]): string {
  if (mode === "always") return "常驻";
  if (mode === "hidden") return "隐藏";
  return "滚动时显示";
}

function mermaidRenderingLabel(mode: AppSettings["mermaidRendering"]): string {
  if (mode === "off") return "关闭";
  if (mode === "streaming") return "流式";
  return "完成后";
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

function centerText(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  const spacing = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(spacing / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(spacing - left)}`;
}

function formatExternalDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "--/--" : date.toISOString().slice(5, 10).replace("-", "/");
}

function formatExternalTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "未知" : date.toISOString().slice(0, 16).replace("T", " ");
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

function compareModelGeneration(left: ModelOption, right: ModelOption): number {
  if (left.releasedAt && right.releasedAt) {
    const release = right.releasedAt.localeCompare(left.releasedAt);
    if (release !== 0) return release;
  } else if (left.releasedAt) {
    return -1;
  } else if (right.releasedAt) {
    return 1;
  }

  const leftGeneration = modelGeneration(left);
  const rightGeneration = modelGeneration(right);
  const length = Math.max(leftGeneration.length, rightGeneration.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightGeneration[index] ?? -1) - (leftGeneration[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function modelGeneration(model: ModelOption): number[] {
  const identity = `${model.id} ${model.label}`
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}(?:[-_/]?(?:0[1-9]|1[0-2])(?:[-_/]?(?:0[1-9]|[12]\d|3[01]))?)?\b/gu, " ");
  const candidates = [...identity.matchAll(/\d+(?:[._-]\d+)*/gu)].map((match) =>
    (match[0] ?? "").split(/[._-]/u).map(Number).filter(Number.isFinite),
  );
  return candidates.sort((left, right) => right.length - left.length)[0] ?? [];
}

function modelCombinedPrice(model: ModelOption): number {
  const input = Number.isFinite(model.price.inputUsdPerMillion) ? model.price.inputUsdPerMillion : 0;
  const output = Number.isFinite(model.price.outputUsdPerMillion) ? model.price.outputUsdPerMillion : 0;
  return input + output;
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
  private filteredModelCache: { query: string; models: ModelOption[] } | undefined;
  private modelGroups: ModelGroup[] = [];
  private providers: ProviderOption[] = [];
  private sessions: SessionOption[] = [];
  private externalSessions: ExternalSessionSummary[] = [];
  private externalImportSource: ExternalSessionSource = "codex";
  private externalImportSearch = "";
  private skillSnapshot: SkillCatalogSnapshot = { items: [], issues: [], projectTrusted: false };
  private skillTab: SkillCatalogTab = "enabled";
  private skillSearch = "";
  private skillAdding = false;
  private skillViewing = false;
  private skillAddMode: "source" | "agent" = "source";
  private skillAddText = "";
  private skillScope: SkillScope = "user";
  private providerEditing = false;
  private providerActionMenu = false;
  private activeProviderId: string | undefined;
  private providerCostConfirmation = false;
  private providerActions: string[] = [];
  private providerField = 0;
  private providerDraft = { label: "", baseUrl: "https://", protocol: "OpenAI compatible" };
  private planItems: PlanItem[] = [];
  private planSnapshot: StoredPlan | undefined;
  private goalSnapshot: StoredGoal | undefined;
  private goalModelLabel = "Root Session model";
  private workflowSnapshot: WorkflowSnapshot | undefined;
  private planPanelCollapsed = false;
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
  private settingsLayers: { global: AppSettings; project?: AppSettings; projectInherited: boolean };
  private settingsDirty = false;
  private settingsTab = 1;
  private settingsEndpointEditing = false;
  private settingsEndpointInput = "";
  private effort: EffortLevel = "medium";
  private effortLevels: EffortLevel[] = ["medium"];
  private questionIndex = 0;
  private questionReview = false;
  private questionDirectAnswer = false;
  private readonly questionInput = new Input();
  private questionSelectionRange: [number, number] | undefined;
  private questionPinnedRows = 0;
  private readonly sharedTextFields = new Map<string, Input>();
  private questions: Question[] = [];
  private approvalRequest: ApprovalRequest | undefined;
  private approvalReasonEditing = false;
  private approvalReason = "";
  private lastBodyWidth = 78;
  private policySnapshot: PolicySnapshot = {
    policy: "Auto",
    boundary: "Host",
    sandboxed: false,
    recovery: false,
    sessionAllowlist: [],
  };
  private agentSnapshot: AgentSnapshot = {
    enabled: false,
    projectTrusted: false,
    recovery: false,
    limits: {
      maxDepth: 3,
      maxAgentsPerTree: 12,
      maxConcurrency: 16,
      maxRunTokens: 120_000,
      maxTreeTokens: 500_000,
      maxTreeCostUsd: 20,
      maxRunSeconds: 900,
    },
    pools: [],
    active: [],
    recent: [],
    teammates: [],
    authority: { pendingRequired: [], turnOverrides: [], sessionOverrides: [], taskEpoch: 0 },
    diagnostic: "Subagent runtime is not ready",
  };
  private agentTab: "map" | "timeline" | "tools" | "pools" = "map";
  private agentSelectedRunId: string | undefined;

  constructor(settings: AppSettings) {
    this.settings = { ...settings };
    this.questionInput.focused = false;
    this.settingsLayers = {
      global: { ...settings, scope: "global" },
      ...(settings.scope === "project" ? { project: { ...settings, scope: "project" } } : {}),
      projectInherited: false,
    };
    this.settingsTab = settings.scope === "global" ? 0 : 1;
  }

  private editSharedTextField(id: string, current: string, data: string, maxLength: number): string {
    let input = this.sharedTextFields.get(id);
    if (!input) {
      input = new Input();
      input.focused = true;
      this.sharedTextFields.set(id, input);
    }
    if (input.getValue() !== current) input.setValue(current);
    input.handleInput(data);
    if (Array.from(input.getValue()).length > maxLength) {
      input.setValue(Array.from(input.getValue()).slice(0, maxLength).join(""));
    }
    return input.getValue();
  }

  get kind(): PanelKind {
    return this.state.kind;
  }

  hasPlanContent(): boolean {
    return Boolean(this.planSnapshot || (this.workflowSnapshot?.status === "ready" && this.workflowSnapshot.delivery));
  }

  open(kind: PanelKind): void {
    this.state = { kind, selected: 0, scroll: 0 };
    if (kind === "commands") this.state.selected = 0;
    if (kind === "models") this.modelNarrowDetail = false;
    if (kind === "policy") this.state.selected = Math.max(0, POLICY_LEVELS.indexOf(this.policySnapshot.policy));
    if (kind === "effort") this.state.selected = Math.max(0, this.effortLevels.indexOf(this.effort));
    if (kind === "question") {
      this.questionIndex = 0;
      this.questionReview = false;
      this.questionDirectAnswer = false;
      this.questionInput.setValue("");
    }
    if (kind === "settings") {
      this.settingsEndpointEditing = false;
      this.settingsEndpointInput = "";
    }
  }

  openQuestions(questions: Question[]): void {
    if (questions.length === 0) throw new Error("Question panel requires at least one question");
    this.open("question");
    this.questions = structuredClone(questions);
  }

  openApproval(request: ApprovalRequest): void {
    this.approvalRequest = structuredClone(request);
    this.approvalReasonEditing = false;
    this.approvalReason = "";
    this.open("approval");
  }

  openEffort(effort: EffortLevel, levels: EffortLevel[]): void {
    this.effort = effort;
    this.effortLevels = levels.length > 0 ? [...levels] : ["off"];
    this.open("effort");
  }

  setSettingsLayers(layers: { global: AppSettings; project?: AppSettings; projectInherited: boolean }): void {
    this.settingsLayers = structuredClone(layers);
    const preferred = this.settingsTab === 1 && layers.project ? layers.project : layers.global;
    this.settingsTab = preferred.scope === "project" ? 1 : 0;
    this.settings = { ...preferred };
    this.settingsDirty = false;
    this.state.selected = 0;
  }

  confirmSettings(settings: AppSettings): void {
    if (settings.scope === "global") this.settingsLayers.global = { ...settings };
    else this.settingsLayers.project = { ...settings };
    this.settingsLayers.projectInherited = false;
    this.settings = { ...settings };
    this.settingsDirty = false;
    this.settingsEndpointEditing = false;
    this.settingsEndpointInput = "";
  }

  close(): void {
    this.open("plan");
  }

  setSessions(sessions: SessionOption[]): void {
    this.sessions = sessions.length > 0 ? [...sessions] : [];
    clampSelection(this.state, this.sessions.length);
  }

  setExternalSessions(sessions: ExternalSessionSummary[], source: ExternalSessionSource = "codex"): void {
    this.externalSessions = structuredClone(sessions);
    this.externalImportSource = source;
    this.externalImportSearch = "";
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setSkillCatalog(snapshot: SkillCatalogSnapshot): void {
    this.skillSnapshot = structuredClone(snapshot);
    this.skillAdding = false;
    this.skillViewing = false;
    this.skillAddText = "";
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setModels(
    models: ModelOption[],
    groups: ModelGroup[] = [],
    selectedModel?: string | { provider: string; id: string },
  ): void {
    this.models = structuredClone(models);
    this.filteredModelCache = undefined;
    this.modelGroups = structuredClone(groups);
    if (this.modelGroups.length === 0) this.modelTab = 0;
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

  selectProvider(providerId: string): ProviderOption | undefined {
    const index = this.providers.findIndex((provider) => provider.id === providerId);
    if (index < 0) return undefined;
    this.state.selected = index;
    return this.providers[index];
  }

  setPlanItems(items: PlanItem[]): void {
    this.planSnapshot = undefined;
    this.planItems = structuredClone(items);
    this.planPanelCollapsed = false;
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setPlanSnapshot(snapshot: StoredPlan | undefined): void {
    this.workflowSnapshot = undefined;
    this.planSnapshot = snapshot ? structuredClone(snapshot) : undefined;
    this.planItems = snapshot ? flattenPlanItems(snapshot) : [];
    this.planPanelCollapsed = false;
    this.planActionMenu = false;
    this.planNextActionEditing = false;
    this.state.selected = 0;
    this.state.scroll = 0;
  }

  setGoalSnapshot(snapshot: StoredGoal | undefined, modelLabel?: string): void {
    this.goalSnapshot = snapshot ? structuredClone(snapshot) : undefined;
    if (modelLabel) this.goalModelLabel = modelLabel;
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
            label: `${milestone.id} ${milestone.title}`,
            status:
              milestone.status === "verified"
                ? ("done" as const)
                : milestone.status === "executing"
                  ? ("in_progress" as const)
                  : ("pending" as const),
            depth: 0,
          }))
        : [];
    this.planPanelCollapsed = false;
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
    this.policySnapshot = { ...snapshot, sessionAllowlist: [...(snapshot.sessionAllowlist ?? [])] };
    if (this.kind === "policy") this.state.selected = Math.max(0, POLICY_LEVELS.indexOf(snapshot.policy));
  }

  setAgentSnapshot(snapshot: AgentSnapshot): void {
    const selected = this.selectedAgentRun()?.id ?? this.agentSelectedRunId;
    this.agentSnapshot = structuredClone(snapshot);
    const runs = this.agentRuns();
    const selectedIndex = selected ? runs.findIndex((run) => run.id === selected) : -1;
    this.state.selected =
      selectedIndex >= 0 ? selectedIndex : Math.min(this.state.selected, Math.max(0, runs.length - 1));
    this.agentSelectedRunId = runs[this.state.selected]?.id;
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
    if (this.kind === "settings" && this.settingsEndpointEditing) return this.handleSettings(data);
    if (this.kind === "agents") return this.handleAgents(data);
    const interactionState = this.interactionState();
    if (matchesInteraction("panel", this.kind, "closePanel", data, interactionState)) {
      if (this.kind === "approval" && this.approvalReasonEditing) {
        this.approvalReasonEditing = false;
        this.approvalReason = "";
        return;
      }
      if (this.kind === "question" && (this.questionDirectAnswer || this.questionReview)) {
        this.questionDirectAnswer = false;
        this.questionReview = false;
        this.questionInput.setValue("");
        this.state.scroll = 0;
        return;
      }
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
      if (this.kind === "settings") this.restoreSettingsDraft();
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
    if (this.kind === "externalImport") return this.handleExternalImport(data, interaction.handler);
    if (this.kind === "skills") return this.handleSkills(data, interaction.handler);
    if (this.kind === "settings") return this.handleSettings(data);
    if (this.kind === "theme") return this.handleTheme(data);
    if (this.kind === "question") return this.handleQuestion(data);
    if (this.kind === "approval") return this.handleApproval(data);
    if (this.kind === "effort") return this.handleEffort(data);
    if (this.kind === "tools") {
      if (interaction.handler === "moveSelection") this.move(data, TOOL_CAPABILITIES.length);
      return;
    }
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
    else if (this.kind === "goal") [title, body] = ["Goal", this.renderGoal(bodyWidth, theme)];
    else if (this.kind === "prompt") [title, body] = ["Prompt Profile", this.renderPrompt(bodyWidth, theme)];
    else if (this.kind === "models") [title, body] = ["Model", this.renderModels(bodyWidth, bodyRows, theme)];
    else if (this.kind === "providers") [title, body] = ["Provider", this.renderProviders(bodyWidth, bodyRows, theme)];
    else if (this.kind === "sessions") [title, body] = ["Sessions", this.renderSessions(bodyWidth, theme)];
    else if (this.kind === "externalImport")
      [title, body] = ["导入会话", this.renderExternalImport(bodyWidth, bodyRows, theme)];
    else if (this.kind === "skills") [title, body] = ["Skills", this.renderSkills(bodyWidth, bodyRows, theme)];
    else if (this.kind === "settings") [title, body] = ["Settings", this.renderSettings(bodyWidth, theme)];
    else if (this.kind === "usage") [title, body] = ["Usage", this.renderUsage(bodyWidth, usage)];
    else if (this.kind === "theme") [title, body] = ["Theme", this.renderTheme(bodyWidth, theme)];
    else if (this.kind === "question") [title, body] = ["Question", this.renderQuestion(bodyWidth, theme)];
    else if (this.kind === "approval") [title, body] = ["需要批准", this.renderApproval(bodyWidth, theme)];
    else if (this.kind === "effort") [title, body] = ["Effort", this.renderEffort(bodyWidth, theme)];
    else if (this.kind === "tools") [title, body] = ["Tools", this.renderTools(bodyWidth, theme)];
    else if (this.kind === "agents")
      [title, body] = [`Agents · ${capitalize(this.agentTab)}`, this.renderAgents(bodyWidth, theme)];
    else if (this.kind === "policy") [title, body] = ["Policy", this.renderPolicy(bodyWidth, theme)];
    else [title, body] = ["Plan", this.renderPlan(bodyWidth, theme, planFocused)];

    if (this.kind === "plan" && this.planPanelCollapsed && this.planItems.length > 0) {
      return [padLine(`${theme.focus("Plan")} · ${theme.blue(theme.bold(this.planDisplayTitle()))}`, width)];
    }

    let footer = this.kind === "question" ? this.renderQuestionFooter(theme) : undefined;
    let rightTitle: string | undefined;
    const questionFooterGap =
      this.kind === "question" && (this.questionSelectionRange !== undefined || this.questionReview);
    const visibleBodyRows = questionFooterGap ? Math.max(1, bodyRows - 1) : bodyRows;
    if (body.length > visibleBodyRows) {
      if (this.kind === "question" && this.questionReview) {
        this.state.scroll = Math.max(0, Math.min(this.state.scroll, body.length - visibleBodyRows));
        const total = body.length;
        body = body.slice(this.state.scroll, this.state.scroll + visibleBodyRows);
        rightTitle = `${this.state.scroll + 1}-${this.state.scroll + body.length} / ${total}`;
      } else if (this.kind === "question" && this.questionSelectionRange) {
        const pinnedRows = Math.min(this.questionPinnedRows, Math.max(0, visibleBodyRows - 2));
        const pinned = body.slice(0, pinnedRows);
        const scrollable = body.slice(pinnedRows);
        const scrollRows = Math.max(1, visibleBodyRows - pinned.length);
        const selectionStart = Math.max(0, this.questionSelectionRange[0] - pinnedRows);
        const selectionEnd = Math.max(selectionStart, this.questionSelectionRange[1] - pinnedRows);
        this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, scrollable.length - scrollRows)));
        if (selectionStart < this.state.scroll) this.state.scroll = selectionStart;
        if (selectionEnd - selectionStart < scrollRows && selectionEnd >= this.state.scroll + scrollRows) {
          this.state.scroll = selectionEnd - scrollRows + 1;
        }
        const visible = scrollable.slice(this.state.scroll, this.state.scroll + scrollRows);
        body = [...pinned, ...visible];
        rightTitle = `${this.state.scroll + 1}-${this.state.scroll + visible.length} / ${scrollable.length}`;
      } else {
        let selectionStart: number;
        let selectionEnd: number;
        // selectedLine may sit behind a panel gutter; only accept a leading marker after whitespace.
        const highlightedRows = body
          .map((line, index) => (/^\s*› /.test(stripAnsi(line)) ? index : -1))
          .filter((index) => index >= 0);
        selectionStart = Math.max(0, Math.min(highlightedRows[0] ?? this.state.selected, body.length - 1));
        selectionEnd = highlightedRows.at(-1) ?? selectionStart;
        if (this.kind === "tools") {
          selectionStart = Math.min(this.state.selected * 2, body.length - 1);
          selectionEnd = Math.min(selectionStart + 1, body.length - 1);
        }
        this.state.scroll = Math.max(0, Math.min(this.state.scroll, body.length - visibleBodyRows));
        if (selectionStart < this.state.scroll) this.state.scroll = selectionStart;
        // 块不高于视口时才对齐块底；超高块保持块顶可见，避免首尾互斥把内容推走。
        if (selectionEnd - selectionStart < visibleBodyRows && selectionEnd >= this.state.scroll + visibleBodyRows) {
          this.state.scroll = selectionEnd - visibleBodyRows + 1;
        }
        const total = body.length;
        body = body.slice(this.state.scroll, this.state.scroll + visibleBodyRows);
        footer = `${this.state.scroll + 1}-${this.state.scroll + body.length} / ${total}`;
      }
    }
    if (questionFooterGap) body.push("");
    return frame(body, width, theme, {
      title,
      ...(rightTitle ? { rightTitle } : {}),
      ...(footer ? { footer } : {}),
      ...(this.kind === "question" ? { footerPosition: "left" as const } : {}),
      focused: this.kind !== "plan" || planFocused,
      maxBodyLines: bodyRows,
    });
  }

  sessionsSurfaceHeight(maxRows: number): number {
    return Math.max(3, maxRows);
  }

  /** Actual rendered height of the Sessions surface (content rows + frame borders). */
  sessionsContentHeight(width: number, theme: VspiTheme): number {
    const bodyWidth = Math.max(1, width - 2);
    const body = this.renderSessions(bodyWidth, theme);
    return Math.max(3, 2 + body.length);
  }

  renderSessionsSurface(width: number, maxRows: number, theme: VspiTheme): string[] {
    const bodyWidth = Math.max(1, width - 2);
    const bodyRows = Math.max(1, maxRows - 2);
    this.lastBodyWidth = bodyWidth;
    let body = this.renderSessions(bodyWidth, theme);
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, body.length - bodyRows)));
    const selectedRow = this.state.selected * 2;
    if (selectedRow < this.state.scroll) this.state.scroll = selectedRow;
    if (selectedRow >= this.state.scroll + bodyRows) {
      this.state.scroll = selectedRow - bodyRows + 1;
      if (this.state.scroll % 2 !== 0) this.state.scroll += 1;
    }
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, body.length - bodyRows)));
    body = body.slice(this.state.scroll, this.state.scroll + bodyRows);
    while (body.length < bodyRows) body.push("");
    const hint = renderInteractionHint("panel", "sessions", this.interactionState());
    return frame(body, width, theme, {
      title: "Sessions",
      rightTitle: `${this.sessions.length} 个会话`,
      footer: hint,
      footerPosition: "left",
      focused: true,
      maxBodyLines: bodyRows,
    });
  }

  renderHint(width: number, theme: VspiTheme): string {
    this.lastBodyWidth = Math.max(1, width - 2);
    const hint = renderInteractionHint("panel", this.kind, this.interactionState());
    const contextualHint =
      this.kind === "settings" && this.settingsEndpointEditing
        ? "输入 IP:端口、域名或完整 URL  Enter 确认  Esc 取消"
        : this.kind === "question"
          ? this.questionHint(hint)
          : this.kind === "models" && this.modelGroups.length === 0
            ? hint.replace("Tab 切换视图  ", "")
            : hint;
    return theme.muted(padLine(contextualHint, width));
  }

  /** True when the panel carries its action hint in its fixed frame footer. */
  hintRenderedInline(): boolean {
    return this.kind === "question";
  }

  private questionHintText(): string {
    return this.questionHint(renderInteractionHint("panel", "question", this.interactionState()));
  }

  private renderQuestionFooter(theme: VspiTheme): string {
    const hint = this.questionHintText();
    const submitLabel = "Enter 提交";
    const submitIndex = hint.indexOf(submitLabel);
    if (submitIndex < 0) return theme.muted(hint);
    return [
      theme.muted(hint.slice(0, submitIndex)),
      theme.focus(theme.bold(submitLabel)),
      theme.muted(hint.slice(submitIndex + submitLabel.length)),
    ].join("");
  }

  // Registry 的 Question hint 按 questionMode 粗粒度生成，这里按真实题型补齐/剔除键位。
  private questionHint(hint: string): string {
    if (this.questionReview) return hint;
    const question = this.questions[this.questionIndex];
    if (!question) return hint;
    // 文本输入态下 Shift+S 是字面字符 "S"，跳过不可用，hint 不再宣告。
    if (this.questionDirectAnswer) {
      return hint.replace("  Shift+S 跳过", "").replace("Enter 确认", "Enter 确认  Esc 返回选项");
    }
    if (question.kind === "freeText") return hint.replace("  Shift+S 跳过", "");
    let adjusted = hint;
    if (question.kind === "ranking") adjusted = adjusted.replace("Enter 确认", "Tab 直接回答  Enter 确认");
    if (question.kind !== "multiChoice") adjusted = adjusted.replace("Space 多选  ", "");
    return adjusted;
  }

  acceptsInput(data: string): boolean {
    // 唯一候选的 Tab 补全由 composer 层完成；多候选时面板不拦截 Tab（Registry 宣告了 Tab 补全）。
    if (this.kind === "commands" && panelKey(data, Key.tab)) return false;
    if (
      this.kind === "agents" &&
      [Key.escape, Key.enter, Key.tab, Key.up, Key.down, Key.left, Key.right].some((key) => panelKey(data, key))
    )
      return true;
    return matchingInteraction("panel", this.kind, data, this.interactionState()) !== undefined;
  }

  private interactionState(): InteractionState {
    const state: InteractionState = { narrowModel: !usesWideModelLayout(this.lastBodyWidth) };
    if (this.kind === "plan") state.hasItems = this.visiblePlanItems().length > 0;
    else if (this.kind === "sessions") state.hasItems = this.sessions.length > 0;
    else if (this.kind === "externalImport") state.hasItems = this.filteredExternalSessions().length > 0;
    else if (this.kind === "skills") {
      const item = this.selectedSkill();
      state.hasItems = this.skillRows().length > 0;
      state.skillAdding = this.skillAdding;
      state.skillViewing = this.skillViewing;
      state.narrowSkill = this.lastBodyWidth < 58;
      state.skillAddHasText = this.skillAddText.trim().length > 0;
      state.skillCanEnable = item?.actions.includes("enable") ?? false;
      state.skillCanDisable = item?.actions.includes("disable") ?? false;
      state.skillCanUpdate = item?.actions.includes("update") ?? false;
      state.skillCanRemove = item?.actions.includes("remove") ?? false;
    } else if (this.kind === "commands") {
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
      state.policyYolo = false;
    } else if (this.kind === "question") {
      const question = this.questions[this.questionIndex];
      state.questionMode = this.questionReview
        ? "review"
        : this.questionDirectAnswer || question?.kind === "freeText"
          ? "freeText"
          : question?.kind === "ranking"
            ? "ranking"
            : "choice";
    } else if (this.kind === "approval") {
      state.approvalReasonEditing = this.approvalReasonEditing;
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
    if (matchesKey(data, Key.tab) && this.modelGroups.length > 0) {
      this.modelTab = this.modelTab === 0 ? 1 : 0;
      this.state.selected = 0;
      this.modelNarrowDetail = false;
      return;
    }
    const narrow = !usesWideModelLayout(this.lastBodyWidth);
    if (narrow && matchesKey(data, Key.right)) {
      this.modelNarrowDetail = true;
      return;
    }
    if (narrow && matchesKey(data, Key.left)) {
      this.modelNarrowDetail = false;
      return;
    }
    const models = this.filteredModels();
    const count = this.modelTab === 0 ? models.length : this.modelGroups.length;
    if (this.move(data, count)) return;
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
    if (this.modelTab === 0) {
      const next = this.editSharedTextField("model-search", this.modelSearch, data, 500);
      if (next !== this.modelSearch) {
        this.modelSearch = next;
        this.state.selected = 0;
      }
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
      if (key) {
        this.providerDraft[key] = this.editSharedTextField(`provider-${key}`, this.providerDraft[key], data, 2_000);
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
      this.providerActions = [
        ...(provider.authMethods ?? []).map((method) => `login:${method.type}`),
        ...(provider.storedCredential ? ["logout"] : []),
        "edit",
        "check-config",
        "test-connection",
        "minimal-generation",
      ];
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

  private handleExternalImport(data: string, handler: string): PanelEvent | undefined {
    if (handler === "switchImportSource") {
      this.externalImportSource = this.externalImportSource === "codex" ? "claude" : "codex";
      this.state.selected = 0;
      this.state.scroll = 0;
      return;
    }
    if (handler === "editImportSearch") {
      this.externalImportSearch = this.editSharedTextField(
        "external-import-search",
        this.externalImportSearch,
        data,
        500,
      );
      this.state.selected = 0;
      this.state.scroll = 0;
      return;
    }
    const sessions = this.filteredExternalSessions();
    if (handler === "moveSelection" && this.move(data, sessions.length)) return;
    if (handler === "importExternalSession") {
      const session = sessions[this.state.selected];
      return session ? { type: "externalImport", session } : undefined;
    }
    return undefined;
  }

  private handleSkills(data: string, handler: string): PanelEvent | undefined {
    if (handler === "openSkillAdd") {
      this.skillAdding = true;
      this.skillViewing = false;
      this.skillAddText = "";
      this.skillScope = "user";
      this.state.selected = 0;
      return;
    }
    if (handler === "closeSkillPanel") {
      if (this.skillAdding) {
        this.skillAdding = false;
        this.skillAddText = "";
        return;
      }
      if (this.skillViewing) {
        this.skillViewing = false;
        return;
      }
      this.close();
      return { type: "close" };
    }
    if (handler === "switchSkillAddMode") {
      this.skillAddMode = this.skillAddMode === "source" ? "agent" : "source";
      this.skillAddText = "";
      return;
    }
    if (handler === "switchSkillScope") {
      if (this.skillSnapshot.projectTrusted) this.skillScope = this.skillScope === "user" ? "project" : "user";
      return;
    }
    if (handler === "editSkillText") {
      const current = this.skillAdding ? this.skillAddText : this.skillSearch;
      const next = this.editSharedTextField(this.skillAdding ? "skill-add" : "skill-search", current, data, 2_000);
      if (this.skillAdding) this.skillAddText = next;
      else {
        this.skillSearch = next;
        this.state.selected = 0;
      }
      return;
    }
    if (handler === "submitSkillAdd") {
      const value = this.skillAddText.trim();
      if (!value) return;
      return this.skillAddMode === "source"
        ? { type: "skillInstall", source: value, scope: this.skillScope }
        : { type: "skillAgentSearch", query: value };
    }
    if (handler === "switchSkillTab") {
      const tabs: SkillCatalogTab[] = ["enabled", "available", "issues"];
      this.skillTab = tabs[(tabs.indexOf(this.skillTab) + 1) % tabs.length] ?? "enabled";
      this.state.selected = 0;
      this.state.scroll = 0;
      this.skillViewing = false;
      return;
    }
    const rows = this.skillRows();
    if (handler === "moveSelection" && this.move(data, rows.length)) return;
    const row = rows[this.state.selected];
    if (row?.kind !== "skill") return;
    if (handler === "viewSkill") {
      this.skillViewing = true;
      return;
    }
    if (handler === "toggleSkill") return { type: "skillToggle", skill: row.item, enabled: !row.item.enabled };
    if (handler === "updateSkill") return { type: "skillUpdate", skill: row.item };
    if (handler === "removeSkill") return { type: "skillRemove", skill: row.item };
    return undefined;
  }

  private handleSettings(data: string): PanelEvent | undefined {
    if (this.settingsEndpointEditing) {
      if (panelKey(data, Key.escape)) {
        this.settingsEndpointEditing = false;
        this.settingsEndpointInput = "";
        return;
      }
      if (panelKey(data, Key.enter)) {
        const endpoint = this.settingsEndpointInput.trim();
        this.settingsDirty ||= endpoint !== this.settings.thinkingTranslationEndpoint;
        this.settings.thinkingTranslationEndpoint = endpoint;
        this.settingsEndpointEditing = false;
        this.settingsEndpointInput = "";
        return;
      }
      this.settingsEndpointInput = this.editSharedTextField("settings-endpoint", this.settingsEndpointInput, data, 500);
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      const nextTab = this.settingsTab === 0 ? 1 : 0;
      const next = nextTab === 0 ? this.settingsLayers.global : this.settingsLayers.project;
      if (!next) return { type: "notice", text: "项目未授予 trust，无法编辑项目设置", tone: "warning" };
      this.settingsTab = nextTab;
      this.settings = { ...next };
      this.settingsDirty = false;
      this.state.selected = 0;
      return;
    }
    const rows = this.settingRows();
    if (this.move(data, rows.length)) return;
    if (matchesKey(data, Key.ctrl("s"))) {
      if (!this.settingsDirty) return { type: "notice", text: "设置没有变化", tone: "info" };
      return { type: "settings", settings: { ...this.settings } };
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const row = rows[this.state.selected];
      if (!row) return;
      if (row.key === "theme") {
        const themes: AppSettings["theme"][] = ["VSPi Dark", "VSPi Light", "Terminal"];
        this.settings.theme = themes[(themes.indexOf(this.settings.theme) + 1) % themes.length] ?? "VSPi Dark";
        this.settingsDirty = true;
        return;
      }
      if (row.key === "tuiMode") {
        this.settings.tuiMode = this.settings.tuiMode === "fullscreen" ? "regular" : "fullscreen";
        this.settingsDirty = true;
        return;
      }
      if (row.key === "fullscreenScrollbar") {
        const scrollbars: AppSettings["fullscreenScrollbar"][] = ["auto", "always", "hidden"];
        this.settings.fullscreenScrollbar =
          scrollbars[(scrollbars.indexOf(this.settings.fullscreenScrollbar) + 1) % scrollbars.length] ?? "auto";
        this.settingsDirty = true;
        return;
      }
      if (row.key === "mermaidRendering") {
        const modes: AppSettings["mermaidRendering"][] = ["off", "final", "streaming"];
        this.settings.mermaidRendering =
          modes[(modes.indexOf(this.settings.mermaidRendering) + 1) % modes.length] ?? "final";
        this.settingsDirty = true;
        return;
      }
      if (row.key === "workingStyle") {
        const styles: AppSettings["workingStyle"][] = [1, 2, 3];
        this.settings.workingStyle = styles[(styles.indexOf(this.settings.workingStyle) + 1) % styles.length] ?? 3;
        this.settingsDirty = true;
        return;
      }
      if (row.key === "thinkingDisplay") {
        const modes: AppSettings["thinkingDisplay"][] = ["hidden", "collapsed", "expanded"];
        this.settings.thinkingDisplay =
          modes[(modes.indexOf(this.settings.thinkingDisplay) + 1) % modes.length] ?? "collapsed";
        this.settingsDirty = true;
        return;
      }
      if (row.key === "thinkingTranslationEndpoint") {
        this.settingsEndpointEditing = true;
        this.settingsEndpointInput = this.settings.thinkingTranslationEndpoint;
        return;
      }
      const key = row.key;
      this.settings[key] = !this.settings[key];
      this.settingsDirty = true;
      return;
    }
    return undefined;
  }

  private restoreSettingsDraft(): void {
    const source = this.settingsTab === 0 ? this.settingsLayers.global : this.settingsLayers.project;
    if (source) this.settings = { ...source };
    this.settingsDirty = false;
    this.settingsEndpointEditing = false;
    this.settingsEndpointInput = "";
  }

  private handleEffort(data: string): PanelEvent | undefined {
    if (this.move(data, this.effortLevels.length)) return;
    if (!matchesKey(data, Key.enter)) return;
    const effort = this.effortLevels[this.state.selected];
    return effort ? { type: "effort", effort } : undefined;
  }

  private handleApproval(data: string): PanelEvent | undefined {
    if (this.approvalReasonEditing) {
      if (matchesKey(data, Key.enter)) {
        const reason = this.approvalReason.trim();
        return { type: "approval", response: { type: "deny", ...(reason ? { reason } : {}) } };
      }
      this.approvalReason = this.editSharedTextField("approval-reason", this.approvalReason, data, 500);
      return;
    }
    const request = this.approvalRequest;
    const count = request?.requiredPolicy ? 5 : 4;
    if (this.move(data, count)) return;
    if (!matchesKey(data, Key.enter)) return;
    if (this.state.selected === 0) return { type: "approval", response: { type: "allow-once" } };
    if (this.state.selected === 1) {
      return {
        type: "approval",
        response: { type: "allow-session", ...(request?.category ? { category: request.category } : {}) },
      };
    }
    if (request?.requiredPolicy && this.state.selected === 2) {
      return { type: "approval", response: { type: "elevate", level: request.requiredPolicy } };
    }
    const denialIndex = request?.requiredPolicy ? 3 : 2;
    if (this.state.selected === denialIndex) return { type: "approval", response: { type: "deny" } };
    this.approvalReasonEditing = true;
    this.approvalReason = "";
    return;
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
    return { type: "policyChange", policy, requiresAcknowledgement: false };
  }

  private handlePlan(data: string, handler: string): PanelEvent | undefined {
    const visible = this.visiblePlanItems();
    if (this.planNextActionEditing) {
      if (panelKey(data, Key.ctrl("u"))) {
        this.planNextActionInput = "";
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
      this.planNextActionInput = this.editSharedTextField("plan-next-action", this.planNextActionInput, data, 4_000);
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
    if (panelKey(data, Key.left)) {
      this.planPanelCollapsed = true;
      return;
    }
    if (panelKey(data, Key.right)) {
      this.planPanelCollapsed = false;
      return;
    }
    if (this.planPanelCollapsed) return;
    if (handler === "moveSelection" && this.move(data, visible.length)) return;
    const item = visible[this.state.selected];
    if (!item) return;
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
      if (data === "\r" || data === Key.enter) {
        if (!this.promptImportPath) return;
        const event: PanelEvent = { type: "promptImport", path: this.promptImportPath, scope: "session" };
        this.promptImportEditing = false;
        this.promptImportPath = "";
        return event;
      }
      this.promptImportPath = this.editSharedTextField("prompt-import-path", this.promptImportPath, data, 4_096);
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
      if (panelKey(data, Key.left) || panelKey(data, Key.escape)) {
        this.questionReview = false;
        this.questionIndex = this.questions.length - 1;
        this.state.scroll = 0;
        return;
      }
      if (panelKey(data, Key.up)) this.state.scroll = Math.max(0, this.state.scroll - 1);
      else if (panelKey(data, Key.down)) this.state.scroll += 1;
      else if (panelKey(data, Key.pageUp)) this.state.scroll = Math.max(0, this.state.scroll - 8);
      else if (panelKey(data, Key.pageDown)) this.state.scroll += 8;
      return;
    }
    const question = this.questions[this.questionIndex];
    if (!question) return;
    if (this.questionDirectAnswer || question.kind === "freeText") {
      if (panelKey(data, Key.enter)) {
        question.answer = this.questionInput.getValue();
        this.advanceQuestion();
        return;
      }
      const previous = this.questionInput.getValue();
      this.questionInput.handleInput(data);
      if (Array.from(this.questionInput.getValue()).length > 2_000) this.questionInput.setValue(previous);
      return;
    }
    if (panelKey(data, Key.left) || panelKey(data, Key.right)) {
      const offset = panelKey(data, Key.left) ? -1 : 1;
      this.questionIndex = Math.max(0, Math.min(this.questions.length - 1, this.questionIndex + offset));
      this.questionDirectAnswer = false;
      this.questionInput.setValue("");
      this.state.selected = 0;
      this.state.scroll = 0;
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
      this.questionInput.setValue("");
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
        this.questionInput.setValue("");
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
    this.questionInput.setValue("");
    this.state.selected = 0;
    this.state.scroll = 0;
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
        ? `${matchedToken}${theme.muted(`  (${match.canonicalToken})`)}`
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
    if (this.filteredModelCache?.query === query) return this.filteredModelCache.models;
    const brandIndex = (brand: string) => {
      const index = BRAND_PRIORITY.indexOf(brand);
      return index === -1 ? BRAND_PRIORITY.length : index;
    };
    const models = this.models
      .filter((model) => !query || `${model.brand} ${model.label} ${model.id}`.toLowerCase().includes(query))
      .sort((left, right) => {
        const priority = brandIndex(left.brand) - brandIndex(right.brand);
        if (priority !== 0) return priority;
        const brand = left.brand.localeCompare(right.brand);
        if (brand !== 0) return brand;
        const generation = compareModelGeneration(left, right);
        if (generation !== 0) return generation;
        const price = modelCombinedPrice(right) - modelCombinedPrice(left);
        if (price !== 0) return price;
        return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
      });
    this.filteredModelCache = { query, models };
    return models;
  }

  private renderModels(width: number, bodyRows: number, theme: VspiTheme): string[] {
    const modelTab = this.modelSearch ? `选择模型 · ${this.modelSearch}` : "选择模型";
    const tabs = tabLine(this.modelGroups.length > 0 ? [modelTab, "模型组"] : [modelTab], this.modelTab, width, theme);
    const listRows = Math.max(2, bodyRows - 1);
    const body = usesWideModelLayout(width)
      ? this.renderWideModels(width, listRows, theme)
      : this.renderNarrowModels(width, listRows, theme);
    return [tabs, ...body];
  }

  private renderWideModels(width: number, rowCount: number, theme: VspiTheme): string[] {
    const leftWidth = Math.max(18, Math.floor((width - 1) * 0.4));
    const rightWidth = width - leftWidth - 1;
    const left = this.modelListRows(rowCount, leftWidth, theme);
    const right =
      this.modelTab === 0
        ? this.modelDetailRows(rowCount, rightWidth, theme)
        : this.modelGroupDetailRows(rowCount, theme);
    return Array.from({ length: rowCount }, (_, index) => {
      const leftRow = left[index] ?? padLine("", leftWidth);
      const rightRow = padLine(right[index] ?? "", rightWidth);
      return `${leftRow}${theme.border("│")}${rightRow}`;
    });
  }

  private renderNarrowModels(width: number, rowCount: number, theme: VspiTheme): string[] {
    if (this.modelNarrowDetail) {
      const details =
        this.modelTab === 0 ? this.modelDetailRows(rowCount, width, theme) : this.modelGroupDetailRows(rowCount, theme);
      return Array.from({ length: rowCount }, (_, index) => padLine(details[index] ?? "", width));
    }
    return this.modelListRows(rowCount, width, theme);
  }

  private modelListRows(rowCount: number, width: number, theme: VspiTheme): string[] {
    if (this.modelTab === 1) {
      const start = Math.max(
        0,
        Math.min(this.state.selected - Math.floor(rowCount / 2), this.modelGroups.length - rowCount),
      );
      return Array.from({ length: rowCount }, (_, row) => {
        const index = start + row;
        const group = this.modelGroups[index];
        if (!group) return padLine("", width);
        const selected = index === this.state.selected;
        const marker = selected ? theme.focus("› ") : "  ";
        const check = group.id === this.selectedGroupId ? theme.success("✓ ") : "  ";
        const line = padLine(`${marker}${check}${group.label}`, width);
        return selected ? theme.selected(line) : line;
      });
    }

    const entries = this.modelListEntries();
    const selectedRow = Math.max(
      0,
      entries.findIndex((entry) => entry.type === "model" && entry.modelIndex === this.state.selected),
    );
    const start = Math.max(0, Math.min(selectedRow - Math.floor(rowCount / 2), entries.length - rowCount));
    let visible = entries.slice(start, start + rowCount);

    const first = visible[0];
    if (first?.type === "model") {
      const providerRow = entries.findLastIndex(
        (entry, index) => index < start && entry.type === "provider" && entry.key === first.providerKey,
      );
      if (providerRow >= 0)
        visible = [entries[providerRow] as ModelListEntry, ...entries.slice(start, start + rowCount - 1)];
    }

    return Array.from({ length: rowCount }, (_, row) => {
      const entry = visible[row];
      if (!entry) return padLine("", width);
      if (entry.type === "provider") {
        return alignRight(theme.bold(theme.muted(`  ${entry.label}`)), theme.muted(String(entry.count)), width);
      }
      const selected = entry.modelIndex === this.state.selected;
      const marker = selected ? theme.focus("› ") : "  ";
      const check = modelKey(entry.model) === this.selectedModelKey ? theme.success("✓ ") : "  ";
      const vision = entry.model.vision ? theme.blue(" ◉") : "";
      const line = padLine(`${marker}${check}${entry.model.label}${vision}`, width);
      return selected ? theme.selected(line) : line;
    });
  }

  private modelListEntries(): ModelListEntry[] {
    const models = this.filteredModels();
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.brand, (counts.get(model.brand) ?? 0) + 1);

    const entries: ModelListEntry[] = [];
    let providerKey: string | undefined;
    models.forEach((model, modelIndex) => {
      if (model.brand !== providerKey) {
        providerKey = model.brand;
        entries.push({ type: "provider", key: providerKey, label: providerKey, count: counts.get(providerKey) ?? 0 });
      }
      entries.push({ type: "model", model, modelIndex, providerKey });
    });
    return entries;
  }

  private modelDetailRows(rowCount: number, width: number, theme: VspiTheme): string[] {
    const model = this.filteredModels()[this.state.selected];
    if (!model) return [theme.muted("没有匹配的模型")];
    const input = model.price.inputUsdPerMillion * FX.fxRate;
    const output = model.price.outputUsdPerMillion * FX.fxRate;
    const provider = `${theme.muted("Provider  ")}${model.brand}`;
    const modelId = `${theme.muted("Model ID  ")}${model.id}`;
    const capability = `${theme.muted("能力      ")}${model.vision ? "文本 · 图片 · Tools" : "文本 · Tools"}`;
    const effort = `${theme.muted("Effort  ")}${model.efforts.map(effortLabel).join(" / ")}`;
    const release = model.releasedAt ? `${theme.muted("发布  ")}${model.releasedAt}` : "";
    const price = `${theme.warning("输入 ¥")}${input.toFixed(2)} / 百万  ${theme.warning("输出 ¥")}${output.toFixed(2)} / 百万`;
    const combinedIdentity = `${provider}  ${modelId}`;
    const capabilityRelease = [capability, release].filter(Boolean).join("  ");
    const effortRows = wrapTextWithAnsi(effort, width);
    const details = [theme.bold(theme.focus(model.label)), combinedIdentity, capabilityRelease, ...effortRows, price];
    return details.length <= rowCount ? details : [...details.slice(0, rowCount - 1), price];
  }

  private modelGroupDetailRows(rowCount: number, theme: VspiTheme): string[] {
    const group = this.modelGroups[this.state.selected];
    if (!group) return [theme.muted("没有匹配的模型组")];
    const rows = [theme.bold(theme.focus(group.label))];
    for (const role of group.roles) {
      const model = this.models.find((item) => item.id === role.modelId);
      rows.push(`${theme.muted(`${role.role}  `)}${model?.label ?? role.modelId} · Effort ${effortLabel(role.effort)}`);
    }
    return rows.slice(0, rowCount);
  }

  private renderProviders(width: number, bodyRows: number, theme: VspiTheme): string[] {
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
        "login:oauth": "登录订阅账号",
        "login:api_key": "配置 API Key",
        logout: "移除已保存的凭据",
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
      const rowCount = Math.max(1, bodyRows);
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
    return this.sessions.flatMap((session, index) => {
      const branch = session.branchDepth > 0 ? `${theme.muted("└─")} ` : "";
      const current = session.current ? theme.success("● ") : "";
      const status = session.owner ? theme.warning("使用中") : session.relativeTime;
      const selected = index === this.state.selected;
      const marker = selected ? theme.focus("› ") : "  ";
      const label = `${"  ".repeat(session.branchDepth)}${branch}${current}${session.label}`;
      const line = alignRight(`${marker}${selected ? theme.focus(theme.bold(label)) : label}`, status, width);
      return index < this.sessions.length - 1 ? [line, ""] : [line];
    });
  }

  private renderExternalImport(width: number, rows: number, theme: VspiTheme): string[] {
    const codexCount = this.externalSessions.filter((session) => session.source === "codex").length;
    const claudeCount = this.externalSessions.filter((session) => session.source === "claude").length;
    const tabs = tabLine(
      [`Codex  ${codexCount}`, `Claude Code  ${claudeCount}`],
      this.externalImportSource === "codex" ? 0 : 1,
      width,
      theme,
    );
    const query = this.externalImportSearch || theme.muted("输入标题或路径");
    const search = padLine(`  ${theme.muted("搜索  ")}${query}${theme.inverse(" ")}`, width);
    const contentRows = Math.max(1, rows - 2);
    const sessions = this.filteredExternalSessions();
    clampSelection(this.state, sessions.length);
    if (width < 58) return [tabs, search, ...this.externalImportList(sessions, width, contentRows, theme)];

    const listWidth = Math.max(28, Math.floor(width * 0.57));
    const detailWidth = Math.max(1, width - listWidth - 1);
    const list = this.externalImportList(sessions, listWidth, contentRows, theme);
    const detail = this.externalImportDetail(sessions[this.state.selected], detailWidth, contentRows, theme);
    return [
      tabs,
      search,
      ...Array.from({ length: contentRows }, (_, index) => {
        const left = list[index] ?? padLine("", listWidth);
        const right = detail[index] ?? padLine("", detailWidth);
        return `${left}${theme.muted("│")}${right}`;
      }),
    ];
  }

  private renderSkills(width: number, rows: number, theme: VspiTheme): string[] {
    if (this.skillAdding) return this.renderSkillAdd(width, rows, theme);
    if (this.skillViewing && width < 58) {
      return this.skillDetail(this.skillRows()[this.state.selected], width, rows, theme);
    }
    const enabledCount = this.skillSnapshot.items.filter((item) => item.enabled).length;
    const availableCount = this.skillSnapshot.items.length - enabledCount;
    const tabs: Array<[SkillCatalogTab, string]> = [
      ["enabled", `已启用  ${enabledCount}`],
      ["available", `可导入  ${availableCount}`],
      ["issues", `问题  ${this.skillSnapshot.issues.length}`],
    ];
    const tabText = tabs
      .map(([id, label]) => (id === this.skillTab ? theme.selected(` ${label} `) : theme.muted(` ${label} `)))
      .join(" ");
    const header = alignRight(tabText, theme.focus("＋ 添加"), width);
    const query = this.skillSearch || theme.muted("输入名称、描述或来源");
    const search = padLine(`  ${theme.muted("搜索  ")}${query}${theme.inverse(" ")}`, width);
    const contentRows = Math.max(1, rows - 2);
    const skillRows = this.skillRows();
    clampSelection(this.state, skillRows.length);
    if (width < 58) return [header, search, ...this.skillList(skillRows, width, contentRows, theme)];
    const listWidth = Math.max(30, Math.floor(width * 0.55));
    const detailWidth = Math.max(1, width - listWidth - 1);
    const list = this.skillList(skillRows, listWidth, contentRows, theme);
    const detail = this.skillDetail(skillRows[this.state.selected], detailWidth, contentRows, theme);
    return [
      header,
      search,
      ...Array.from({ length: contentRows }, (_, index) => {
        const left = list[index] ?? padLine("", listWidth);
        const right = detail[index] ?? padLine("", detailWidth);
        return `${left}${theme.muted("│")}${right}`;
      }),
    ];
  }

  private renderSkillAdd(width: number, rows: number, theme: VspiTheme): string[] {
    const tabs = [
      this.skillAddMode === "source" ? theme.selected(" URL / npm ") : theme.muted(" URL / npm "),
      this.skillAddMode === "agent" ? theme.selected(" 让 Agent 帮我找 ") : theme.muted(" 让 Agent 帮我找 "),
    ].join(" ");
    const label = this.skillAddMode === "source" ? "来源" : "你需要什么";
    const value =
      this.skillAddText || theme.muted(this.skillAddMode === "source" ? "Git URL 或 npm:package" : "描述 Skill 用途");
    const global = this.skillScope === "user" ? theme.selected(" Global ") : theme.muted(" Global ");
    const projectLabel = this.skillSnapshot.projectTrusted ? " Project " : " Project · Untrusted ";
    const project = this.skillScope === "project" ? theme.selected(projectLabel) : theme.muted(projectLabel);
    const body = [
      padLine(tabs, width),
      padLine("", width),
      padLine(`  ${theme.muted(label)}`, width),
      padLine(`  ${theme.focus("› ")}${value}${theme.inverse(" ")}`, width),
      padLine("", width),
      padLine(`  ${theme.muted("范围  ")}${global}  ${project}`, width),
    ];
    return Array.from({ length: rows }, (_, index) => body[index] ?? padLine("", width));
  }

  private skillList(rows: SkillRow[], width: number, count: number, theme: VspiTheme): string[] {
    if (rows.length === 0)
      return [theme.muted(padLine(this.skillTab === "issues" ? "没有 Skill 问题" : "没有匹配的 Skill", width))];
    const start = Math.max(0, Math.min(this.state.selected - Math.floor(count / 2), Math.max(0, rows.length - count)));
    return Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const row = rows[index];
      if (!row) return padLine("", width);
      if (row.kind === "issue") {
        return selectedLine(
          alignRight(`${theme.error("! ")}${row.issue.message}`, "Issue", Math.max(1, width - 2)),
          index === this.state.selected,
          width,
          theme,
        );
      }
      const status = row.item.enabled ? theme.success("● ") : theme.muted("○ ");
      const scope =
        row.item.scope === "project" ? "Project" : row.item.scope === "user" ? "Global" : row.item.sourceLabel;
      const source = row.item.scope === "external" ? scope : `${scope} · ${row.item.sourceLabel}`;
      return selectedLine(
        alignRight(`${status}${row.item.name}`, source, Math.max(1, width - 2)),
        index === this.state.selected,
        width,
        theme,
      );
    });
  }

  private skillDetail(row: SkillRow | undefined, width: number, rows: number, theme: VspiTheme): string[] {
    if (!row) return Array.from({ length: rows }, () => padLine("", width));
    const detail =
      row.kind === "issue"
        ? [
            theme.error(theme.bold(row.issue.message)),
            "",
            `${theme.muted("路径  ")}${truncateStart(row.issue.path ?? "未知", Math.max(1, width - 6))}`,
          ]
        : [
            theme.bold(truncateToWidth(row.item.name, width, "…")),
            wrapTextWithAnsi(row.item.description, width)[0] ?? "",
            "",
            `${theme.muted("状态  ")}${row.item.enabled ? theme.success("当前会话已启用") : theme.muted(row.item.installed ? "已安装 · 未启用" : "可导入")}`,
            `${theme.muted("来源  ")}${row.item.sourceLabel}${row.item.packageDisplaySource ? ` · ${truncateStart(row.item.packageDisplaySource, Math.max(1, width - 12))}` : ""}`,
            `${theme.muted("路径  ")}${truncateStart(row.item.filePath, Math.max(1, width - 6))}`,
            `${theme.muted("触发  ")}/skill:${row.item.name}`,
            `${theme.muted("Model ")}${row.item.disableModelInvocation ? "仅显式调用" : "可自动调用"}`,
          ];
    return Array.from({ length: rows }, (_, index) => padLine(detail[index] ?? "", width));
  }

  private skillRows(): SkillRow[] {
    const query = this.skillSearch.trim().toLocaleLowerCase();
    if (this.skillTab === "issues") {
      return this.skillSnapshot.issues
        .filter((issue) => !query || `${issue.message}\n${issue.path ?? ""}`.toLocaleLowerCase().includes(query))
        .map((issue) => ({ kind: "issue" as const, issue }));
    }
    return this.skillSnapshot.items
      .filter((item) => (this.skillTab === "enabled" ? item.enabled : !item.enabled))
      .filter(
        (item) =>
          !query ||
          `${item.name}\n${item.description}\n${item.sourceLabel}\n${item.filePath}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .map((item) => ({ kind: "skill" as const, item }));
  }

  private selectedSkill(): SkillCatalogItem | undefined {
    const row = this.skillRows()[this.state.selected];
    return row?.kind === "skill" ? row.item : undefined;
  }

  private externalImportList(
    sessions: ExternalSessionSummary[],
    width: number,
    rows: number,
    theme: VspiTheme,
  ): string[] {
    if (sessions.length === 0) return [theme.muted(padLine("没有匹配的历史会话", width))];
    const start = Math.max(
      0,
      Math.min(this.state.selected - Math.floor(rows / 2), Math.max(0, sessions.length - rows)),
    );
    return Array.from({ length: rows }, (_, row) => {
      const index = start + row;
      const session = sessions[index];
      if (!session) return padLine("", width);
      return selectedLine(
        alignRight(session.title, formatExternalDate(session.updatedAt), Math.max(1, width - 2)),
        index === this.state.selected,
        width,
        theme,
      );
    });
  }

  private externalImportDetail(
    session: ExternalSessionSummary | undefined,
    width: number,
    rows: number,
    theme: VspiTheme,
  ): string[] {
    if (!session) return Array.from({ length: rows }, () => padLine("", width));
    const source = session.source === "codex" ? "Codex" : "Claude Code";
    const detail = [
      theme.bold(truncateToWidth(session.title, width, "…")),
      `${theme.muted("来源  ")}${source}${session.archived ? theme.muted(" · 已归档") : ""}`,
      `${theme.muted("时间  ")}${formatExternalTimestamp(session.updatedAt)}`,
      `${theme.muted("路径  ")}${truncateStart(session.cwd ?? "将在预览时读取", Math.max(1, width - 6))}`,
      "",
      theme.muted("Enter 读取完整可见记录并确认"),
      theme.muted("原始历史始终保持不变"),
    ];
    return Array.from({ length: rows }, (_, index) => padLine(detail[index] ?? "", width));
  }

  private filteredExternalSessions(): ExternalSessionSummary[] {
    const query = this.externalImportSearch.trim().toLocaleLowerCase();
    return this.externalSessions.filter(
      (session) =>
        session.source === this.externalImportSource &&
        (!query || `${session.title}\n${session.cwd ?? ""}`.toLocaleLowerCase().includes(query)),
    );
  }

  private settingRows(): Array<{
    label: string;
    key:
      | "theme"
      | "tuiMode"
      | "fullscreenScrollbar"
      | "mermaidRendering"
      | "reducedMotion"
      | "workingStyle"
      | "thinkingDisplay"
      | "thinkingTranslationEndpoint"
      | "wrapCode"
      | "collapseTools";
    group: string;
  }> {
    return [
      { group: "外观", label: `主题  ${this.settings.theme}`, key: "theme" },
      { group: "外观", label: `减少动效  ${this.settings.reducedMotion ? "开" : "关"}`, key: "reducedMotion" },
      {
        group: "外观",
        label: `Working 样式  ${workingStyleLabel(this.settings.workingStyle)}`,
        key: "workingStyle",
      },
      {
        group: "Transcript",
        label: `thinking 显示模式  ${thinkingDisplayLabel(this.settings.thinkingDisplay)}`,
        key: "thinkingDisplay",
      },
      {
        group: "Transcript",
        label: `思考翻译服务  ${this.settings.thinkingTranslationEndpoint || "关"}`,
        key: "thinkingTranslationEndpoint",
      },
      { group: "Transcript", label: `代码自动换行  ${this.settings.wrapCode ? "开" : "关"}`, key: "wrapCode" },
      {
        group: "Transcript",
        label: `完成后收起工具  ${this.settings.collapseTools ? "开" : "关"}`,
        key: "collapseTools",
      },
      {
        group: "终端",
        label: `TUI 模式  ${this.settings.tuiMode === "fullscreen" ? "Fullscreen" : "Regular"}`,
        key: "tuiMode",
      },
      {
        group: "终端",
        label: `Fullscreen 滚动条  ${fullscreenScrollbarLabel(this.settings.fullscreenScrollbar)}`,
        key: "fullscreenScrollbar",
      },
      {
        group: "Markdown",
        label: `Mermaid 图表  ${mermaidRenderingLabel(this.settings.mermaidRendering)}`,
        key: "mermaidRendering",
      },
    ];
  }

  private renderSettings(width: number, theme: VspiTheme): string[] {
    const projectLabel = this.settingsLayers.project
      ? this.settingsLayers.projectInherited
        ? "项目（继承）"
        : "项目"
      : "项目（不可用）";
    const dirty = this.settingsDirty ? theme.warning("未应用") : theme.muted("已同步");
    const lines = [tabLine(["全局", projectLabel], this.settingsTab, width, theme), alignRight("", dirty, width)];
    let group: string | undefined;
    this.settingRows().forEach((row, index) => {
      if (row.group !== group) {
        group = row.group;
        lines.push(theme.muted(padLine(`  ${group}`, width)));
      }
      const label =
        row.key === "thinkingTranslationEndpoint" && this.settingsEndpointEditing
          ? `思考翻译服务  ${this.settingsEndpointInput}${theme.inverse(" ")}`
          : row.label;
      lines.push(selectedLine(label, index === this.state.selected, width, theme));
    });
    lines.push(theme.muted(padLine("  键位方案  VSPi 默认", width)));
    return lines;
  }

  private renderUsage(width: number, usage: UsageSnapshot): string[] {
    const tokens = (count: number | null) => (count === null ? "unknown" : count.toLocaleString("zh-CN"));
    const percent = (value: number | null) => (value === null ? "unknown" : `${value}%`);
    const missCost =
      usage.cacheMissCostUsd === null ? "unknown" : `约 ¥${(usage.cacheMissCostUsd * usage.fxRate).toFixed(2)}`;
    return [
      alignRight("上下文", formatContextUsage(usage), width),
      alignRight("最近 Cache Hit Rate", percent(usage.recentCacheHitPercent), width),
      alignRight("Session Cache Hit Rate", percent(usage.sessionCacheHitPercent), width),
      alignRight("Cached", tokens(usage.cacheReadTokens), width),
      alignRight("Uncached", usage.inputTokens.toLocaleString("zh-CN"), width),
      alignRight("Cache Write", tokens(usage.cacheWriteTokens), width),
      alignRight("Output", usage.outputTokens.toLocaleString("zh-CN"), width),
      alignRight("Cache miss 重复计费", `${tokens(usage.cacheMissTokens)} · ${missCost}`, width),
      alignRight("catalogEstimateUsd", `$${usage.costUsd.toFixed(4)} USD`, width),
      alignRight("catalogEstimateCny", `约 ¥${(usage.costUsd * usage.fxRate).toFixed(2)}`, width),
      alignRight(
        "officialCny",
        usage.officialCostCny === null ? "unknown" : `¥${usage.officialCostCny.toFixed(2)}`,
        width,
      ),
      alignRight(
        "providerBilledCny",
        usage.providerBilledCny === null ? "unknown" : `¥${usage.providerBilledCny.toFixed(2)}`,
        width,
      ),
      alignRight("汇率", `1 USD = ¥${usage.fxRate.toFixed(2)} · ${usage.asOf}`, width),
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
      return selectedLine(
        `${active ? theme.success("✓ ") : "  "}${policy} · Host`,
        index === this.state.selected,
        width,
        theme,
      );
    });
    const selected = POLICY_LEVELS[this.state.selected];
    if (selected === "Auto") {
      rows.push(theme.warning(padLine("Auto · Host：本会话所有工具调用都不再询问", width)));
    } else if (this.policySnapshot.recovery) {
      rows.push(theme.warning(padLine("Recovery 强制 Standard · Host，拒绝切换", width)));
    } else {
      rows.push(theme.muted(padLine("Safe 最严格 · Standard 日常开发 · YOLO 仅高风险询问 · Auto 不询问", width)));
    }
    if ((this.policySnapshot.sessionAllowlist?.length ?? 0) > 0) {
      rows.push(theme.muted(padLine(`本会话已允许  ${this.policySnapshot.sessionAllowlist.join("、")}`, width)));
    }
    return rows;
  }

  private renderTools(width: number, theme: VspiTheme): string[] {
    const statusLabel: Record<ToolCapabilityStatus, string> = {
      native: "Native",
      available: "Available",
      "not-connected": "Not connected",
      deferred: "Deferred",
    };
    return TOOL_CAPABILITIES.flatMap((capability, index) => {
      const selected = index === this.state.selected;
      const symbol =
        capability.status === "native" || capability.status === "available"
          ? theme.success("✓")
          : capability.status === "not-connected"
            ? theme.warning("○")
            : theme.muted("…");
      const header = alignRight(
        `${symbol} ${theme.bold(capability.label)}`,
        theme.muted(statusLabel[capability.status]),
        Math.max(1, width - 2),
      );
      const detail = padLine(`    ${capability.route} · ${capability.boundary}`, width);
      return [selectedLine(header, selected, width, theme), selected ? theme.selected(detail) : theme.muted(detail)];
    });
  }

  private agentRuns(): AgentRunSnapshot[] {
    const byId = new Map<string, AgentRunSnapshot>();
    for (const run of [...this.agentSnapshot.active, ...this.agentSnapshot.recent]) byId.set(run.id, run);
    const children = new Map<string | undefined, AgentRunSnapshot[]>();
    for (const run of byId.values()) children.set(run.parentId, [...(children.get(run.parentId) ?? []), run]);
    const ordered: AgentRunSnapshot[] = [];
    const visit = (parentId: string | undefined) => {
      for (const run of children.get(parentId) ?? []) {
        ordered.push(run);
        visit(run.id);
      }
    };
    visit(undefined);
    for (const run of byId.values()) if (!ordered.some((item) => item.id === run.id)) ordered.push(run);
    return ordered.slice(0, 64);
  }

  private selectedAgentRun(): AgentRunSnapshot | undefined {
    return this.agentRuns()[this.state.selected];
  }

  private handleAgents(data: string): PanelEvent | undefined {
    if (panelKey(data, Key.escape)) {
      if (this.agentTab !== "map") {
        this.agentTab = "map";
        this.state.scroll = 0;
        return;
      }
      this.close();
      return { type: "close" };
    }
    if (panelKey(data, Key.tab)) {
      const tabs = ["map", "timeline", "tools", "pools"] as const;
      this.agentTab = tabs[(tabs.indexOf(this.agentTab) + 1) % tabs.length] ?? "map";
      this.state.scroll = 0;
      return;
    }
    const runs = this.agentRuns();
    if (panelKey(data, Key.up) || panelKey(data, Key.down)) {
      this.move(data, runs.length);
      this.agentSelectedRunId = this.selectedAgentRun()?.id;
      return;
    }
    if (panelKey(data, Key.enter) && this.selectedAgentRun()) {
      this.agentTab = "timeline";
      this.state.scroll = 0;
      return;
    }
    if (panelKey(data, Key.left)) {
      const parentId = this.selectedAgentRun()?.parentId;
      const index = parentId ? runs.findIndex((run) => run.id === parentId) : -1;
      if (index >= 0) this.state.selected = index;
      this.agentSelectedRunId = this.selectedAgentRun()?.id;
      return;
    }
    if (panelKey(data, Key.right)) {
      const selectedId = this.selectedAgentRun()?.id;
      const index = selectedId ? runs.findIndex((run) => run.parentId === selectedId) : -1;
      if (index >= 0) this.state.selected = index;
      this.agentSelectedRunId = this.selectedAgentRun()?.id;
    }
    return;
  }

  private renderGoal(width: number, theme: VspiTheme): string[] {
    const goal = this.goalSnapshot;
    if (!goal) return [theme.muted(padLine("当前 Session 没有绑定 Goal", width))];
    const marker = goal.markers.at(-1);
    const state = GOAL_STATE_LABELS[goal.state];
    const progress = `${goal.autoRounds}/${goal.limits.maxAutoRounds} rounds · ${goal.noProgressRounds}/${goal.limits.maxNoProgressRounds} no-progress`;
    const tokenBudget = `${goal.consumedTokens}/${goal.limits.maxTokens} tokens`;
    const rows = [
      alignRight(theme.bold(theme.focus(state)), theme.muted(`r${goal.revision}`), width),
      ...wrapTextWithAnsi(theme.bold(goal.contract.objective), width),
      theme.muted(truncateToWidth(`Plan ${goal.planId}`, width)),
      alignRight(theme.muted(progress), theme.muted(tokenBudget), width),
      ...(marker?.currentItem ? [truncateToWidth(`当前  ${marker.currentItem}`, width)] : []),
      ...(marker?.nextItem ? [truncateToWidth(`下一步  ${marker.nextItem}`, width)] : []),
      ...(marker?.completedWork.length
        ? [theme.muted("最近完成"), ...marker.completedWork.flatMap((item) => wrapTextWithAnsi(`  ${item}`, width))]
        : []),
      ...(marker?.evidence.length
        ? [theme.muted("证据"), ...marker.evidence.flatMap((item) => wrapTextWithAnsi(`  ${item}`, width))]
        : []),
      ...(goal.blocker
        ? [
            theme.warning("阻塞"),
            ...wrapTextWithAnsi(`  ${goal.blocker.reason}`, width),
            ...wrapTextWithAnsi(`  需要：${goal.blocker.neededInput}`, width),
          ]
        : []),
      ...(goal.stateReason ? [theme.muted(truncateToWidth(`状态原因  ${goal.stateReason}`, width))] : []),
      theme.muted(truncateToWidth(`Model  ${this.goalModelLabel}`, width)),
    ];
    return rows.map((row) => padLine(row, width));
  }

  private renderAgents(width: number, theme: VspiTheme): string[] {
    const limits = this.agentSnapshot.limits;
    const headers = [
      theme.muted(padLine("Map  Timeline  Tools  Pools", width)),
      ...wrapTextWithAnsi(`depth ${limits.maxDepth} · token/cost/duration 为遥测警戒线，不拦截`, width).map((line) =>
        theme.muted(line),
      ),
    ];
    if (this.agentTab === "pools") {
      const lines = [...headers];
      for (const pool of this.agentSnapshot.pools) {
        lines.push(theme.bold(`${pool.provider} · ${pool.source}`));
        for (const role of ["orchestrator", "researcher", "analyst", "worker"] as const) {
          lines.push(...wrapTextWithAnsi(`  ${role.padEnd(12)} ${pool.roles[role]}`, width));
        }
      }
      if (this.agentSnapshot.pools.length === 0) lines.push(theme.muted("No available model pools"));
      return lines;
    }
    const selected = this.selectedAgentRun();
    if (this.agentTab === "timeline" || this.agentTab === "tools") {
      if (!selected) return [...headers, theme.muted("No Agent run selected")];
      const breadcrumb = this.agentBreadcrumb(selected);
      const lines = [...headers, theme.focus(`Root › ${breadcrumb.join(" › ")}`)];
      lines.push(
        ...wrapTextWithAnsi(
          `${selected.role} · ${selected.provider}/${selected.model.split("/").at(-1)} · ${selected.effort} · ${selected.status}`,
          width,
        ),
        ...wrapTextWithAnsi(
          `run ${selected.id} · tree ${selected.treeId}${selected.parentId ? ` · parent ${selected.parentId}` : ""}`,
          width,
        ).map((line) => theme.muted(line)),
        ...wrapTextWithAnsi(
          `${selected.modelReason} · context ${selected.contextMode}/${selected.contextChars} chars`,
          width,
        ).map((line) => theme.muted(line)),
        ...(selected.status === "running"
          ? wrapTextWithAnsi(
              `current ${selected.currentTool ?? "thinking"} · turn ${selected.usage.turns + 1} · elapsed ${agentElapsed(selected)}`,
              width,
            ).map((line) => theme.focus(line))
          : wrapTextWithAnsi(
              `elapsed ${agentElapsed(selected)} · finished ${selected.finishedAt?.slice(11, 19) ?? "—"}`,
              width,
            ).map((line) => theme.muted(line))),
      );
      if (this.agentTab === "tools") {
        lines.push(
          theme.bold("Tools"),
          ...(selected.tools.length ? selected.tools.map((tool) => `  ${tool}`) : ["  none"]),
        );
      } else {
        lines.push(theme.bold("Task"), ...wrapTextWithAnsi(selected.task, width));
        const usage = selected.usage;
        const budget = selected.budget;
        // C19 P0-2/P0-5：预算显示为已用量 + 警戒线标记，不再展示 "tokens left"。
        const runBudgetLine = `  run ${formatAgentTokens(budget.runTokensUsed)} / ${formatAgentTokens(budget.maxRunTokens)}${budget.warnRunTokens ? " ⚠" : ""}`;
        const treeBudgetLine = `  tree ${formatAgentTokens(budget.treeTokensUsed)} / ${formatAgentTokens(budget.maxTreeTokens)}${budget.warnTreeTokens ? " ⚠" : ""} · $${budget.treeCostUsd.toFixed(2)} / $${budget.maxTreeCostUsd}${budget.warnTreeCost ? " ⚠" : ""}`;
        lines.push(
          theme.bold("Usage"),
          ...wrapTextWithAnsi(runBudgetLine, width).map((line) =>
            budget.warnRunTokens ? theme.warning(line) : theme.muted(line),
          ),
          ...wrapTextWithAnsi(treeBudgetLine, width).map((line) =>
            budget.warnTreeTokens || budget.warnTreeCost ? theme.warning(line) : theme.muted(line),
          ),
          ...wrapTextWithAnsi(
            `  in ${formatAgentTokens(usage.input)} · out ${formatAgentTokens(usage.output)} · cache ${formatAgentTokens(usage.cacheRead + usage.cacheWrite)} · ${usage.turns} turns`,
            width,
          ).map((line) => theme.muted(line)),
          theme.bold("Timeline"),
          ...selected.timeline.flatMap((event) =>
            wrapTextWithAnsi(`  ${event.at.slice(11, 19)} ${event.kind} · ${event.summary}`, width),
          ),
        );
        lines.push(theme.bold("Run output preview"));
        lines.push(...wrapTextWithAnsi(selected.outputPreview ?? "Waiting for output...", width));
      }
      return lines.map((line) => padLine(line, width));
    }
    const runs = this.agentRuns();
    const lines = [...headers];
    if (this.agentSnapshot.diagnostic) lines.push(theme.warning(this.agentSnapshot.diagnostic));
    runs.forEach((run, index) => {
      const symbol =
        run.status === "success" ? theme.success("✓") : run.status === "error" ? theme.error("×") : theme.focus("●");
      const branch = `${"  ".repeat(Math.max(0, run.depth - 1))}${run.depth > 1 ? "└─ " : ""}`;
      const current = index === this.state.selected ? "› " : "  ";
      // C19 P0-5：运行中的 run 显示当前工具、轮次与最近活动时间。
      const activity =
        run.status === "running" || run.status === "queued"
          ? ` · ${run.currentTool ? `tool ${run.currentTool}` : "thinking"} · t${run.usage.turns + 1}${run.lastActivityAt ? ` · ${run.lastActivityAt.slice(11, 19)}` : ""}`
          : "";
      lines.push(
        ...wrapTextWithAnsi(
          `${current}${branch}${symbol} ${run.role} · ${run.model.split("/").at(-1)} · ${run.status}${activity} · ${run.task}`,
          width,
        ),
      );
    });
    if (runs.length === 0) lines.push(theme.muted("No recent Agent runs"));
    return lines;
  }

  private agentBreadcrumb(run: AgentRunSnapshot): string[] {
    const runs = this.agentRuns();
    const result = [`${run.role} ${run.id.slice(0, 8)}`];
    let parentId = run.parentId;
    while (parentId) {
      const parent = runs.find((candidate) => candidate.id === parentId);
      if (!parent) break;
      result.unshift(`${parent.role} ${parent.id.slice(0, 8)}`);
      parentId = parent.parentId;
    }
    return result;
  }

  private renderEffort(width: number, theme: VspiTheme): string[] {
    return this.effortLevels.map((level, index) =>
      selectedLine(
        `${level === this.effort ? theme.success("✓ ") : "  "}${effortLabel(level)}`,
        index === this.state.selected,
        width,
        theme,
      ),
    );
  }

  private renderApproval(width: number, theme: VspiTheme): string[] {
    const request = this.approvalRequest;
    if (!request) return [theme.error(padLine("审批请求已失效", width))];
    const gutter = width >= 12 ? 2 : width >= 6 ? 1 : 0;
    const contentWidth = Math.max(1, width - gutter * 2);
    const inset = (line: string) => padLine(`${" ".repeat(gutter)}${padLine(line, contentWidth)}`, width);
    const target = request.action.target ?? request.action.operation ?? request.category;
    const badgeWidth = Math.min(8, contentWidth);
    const policyBadge = theme.policyBadge(request.policy, centerText(request.policy, badgeWidth));
    const title = approvalCategoryLabel(request.category);
    const commandWidth = Math.max(1, contentWidth - 2);
    const commandRows = wrapTextWithAnsi(target, commandWidth);
    const lines = [inset(`${policyBadge}  ${theme.bold(title)}`)];
    for (const command of commandRows) {
      lines.push(inset(theme.codeBlock(centerText(theme.warning(theme.bold(command)), contentWidth))));
    }
    lines.push(padLine("", width));
    if (this.approvalReasonEditing) {
      lines.push(theme.error(inset("拒绝并说明")));
      lines.push(inset(theme.selected(padLine(` ${this.approvalReason}${this._cursor(theme)} `, contentWidth))));
      return lines;
    }
    const choices = [
      { label: "允许本次", description: "仅执行这一次命令" },
      { label: "本会话允许同类命令", description: "以后不再重复询问" },
      ...(request.requiredPolicy
        ? [{ label: `提升到 ${request.requiredPolicy} 并执行`, description: "调整到可执行该操作的等级" }]
        : []),
      { label: "拒绝", description: "不执行命令" },
      { label: "拒绝并说明...", description: "同时向 Agent 提供原因" },
    ];
    const optionIndent = contentWidth >= 8 ? 2 : 0;
    const optionWidth = Math.max(1, contentWidth - optionIndent);
    choices.forEach((choice, index) => {
      const numberedLabel = `${index + 1}. ${choice.label}`;
      const labelWidth = Math.min(30, Math.max(18, Math.floor(optionWidth * 0.45)));
      const row =
        optionWidth >= 52 ? `${padLine(numberedLabel, labelWidth)}${theme.muted(choice.description)}` : numberedLabel;
      lines.push(
        inset(`${" ".repeat(optionIndent)}${selectedLine(row, index === this.state.selected, optionWidth, theme)}`),
      );
      if (optionWidth < 52) lines.push(theme.muted(inset(`${" ".repeat(optionIndent + 4)}${choice.description}`)));
    });
    return lines;
  }

  private visiblePlanItems(): PlanItem[] {
    return this.planItems;
  }

  private planDisplayTitle(): string {
    if (this.workflowSnapshot?.status === "ready" && this.workflowSnapshot.delivery) {
      return humanizePlanId(this.workflowSnapshot.delivery.id);
    }
    return this.planSnapshot?.title ?? "Plan";
  }

  private renderPlan(width: number, theme: VspiTheme, focused: boolean): string[] {
    if (this.workflowSnapshot) return this.renderWorkflowPlan(width, theme, focused);
    const items = this.visiblePlanItems();
    if (items.length === 0) return [padLine("", width)];
    const snapshot = this.planSnapshot;
    const complete = this.planItems.filter((item) => item.status === "done").length;
    const lines = snapshot
      ? [
          alignRight(
            theme.blue(theme.bold(snapshot.title)),
            theme.muted(`r${snapshot.revision} · ${complete}/${this.planItems.length}`),
            width,
          ),
          padLine(`${theme.warning(theme.bold("目标"))}  ${snapshot.goal}`, width),
        ]
      : [alignRight("", theme.muted(`${complete} / ${this.planItems.length}`), width)];
    items.forEach((item, index) => {
      const symbol =
        item.status === "done"
          ? theme.success("✓")
          : item.status === "blocked"
            ? theme.error("✕")
            : item.status === "in_progress"
              ? theme.focus("●")
              : theme.muted("○");
      const label = item.focused ? theme.focus(theme.bold(item.label)) : item.label;
      const prefix = planTreePrefix(items, index, theme);
      lines.push(selectedLine(`${prefix}${symbol} ${label}`, focused && index === this.state.selected, width, theme));
      if (item.status === "blocked" && item.blocker) {
        const indent = " ".repeat(visibleWidth(stripAnsi(prefix)) + 2);
        lines.push(padLine(`${indent}${theme.warning("阻塞")} ${theme.muted(item.blocker)}`, width));
      }
    });
    if (snapshot) {
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
        alignRight(
          theme.bold("Workflow Plan"),
          theme.warning(WORKFLOW_STATUS_LABELS[snapshot.status] ?? snapshot.status),
          width,
        ),
        theme.muted(padLine(snapshot.diagnostic, width)),
      ];
    }
    const delivery = snapshot.delivery;
    const identity = snapshot.identity;
    const version = identity?.version?.split("+")[0] ?? "unknown";
    const lines = [
      alignRight(
        theme.bold(theme.focus(humanizePlanId(delivery.id))),
        theme.muted(`${DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status} · 修订 ${delivery.revision}`),
        width,
      ),
      theme.muted(
        padLine(
          `Workflow · ${DELIVERY_KIND_LABELS[delivery.kind] ?? delivery.kind} · Workspace Read-only · 契约 v${identity?.contractVersion ?? "?"} · ${version}`,
          width,
        ),
      ),
      theme.border(padLine((theme.capabilities.unicode ? "─" : "-").repeat(width), width)),
    ];
    const idWidth = Math.max(...delivery.milestones.map((milestone) => milestone.id.length));
    this.visiblePlanItems().forEach((item, index) => {
      const milestone = delivery.milestones.find((candidate) => candidate.id === item.id);
      const symbol =
        item.status === "done"
          ? theme.success("✓")
          : item.status === "blocked"
            ? theme.error("✕")
            : item.status === "in_progress"
              ? theme.focus("●")
              : theme.muted("○");
      // 标记已承载 done/in_progress/pending 语义，只有"待锚定"这类附加信息才补文字
      const statusText = milestone?.status === "pending_stone" ? " · 待锚定" : "";
      const id = (milestone?.id ?? item.id).padEnd(idWidth);
      lines.push(
        selectedLine(
          `${symbol} ${id} ${milestone?.title ?? item.label}${statusText}`,
          focused && index === this.state.selected,
          width,
          theme,
        ),
      );
    });
    if (delivery.currentMilestoneId)
      lines.push(theme.blue(padLine(`当前里程碑  ${delivery.currentMilestoneId}`, width)));
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
    this.questionSelectionRange = undefined;
    this.questionPinnedRows = 0;
    const answered = this.questions.filter((question) => question.answer !== undefined).length;
    const skipped = this.questions.filter((question) => question.skipped).length;
    const status = theme.muted(`已答 ${answered} · 跳过 ${skipped}`);
    if (this.questionReview) {
      const lines = [
        alignRight(theme.muted("Question · Review"), status, width),
        "",
        theme.bold(padLine("最终检查", width)),
        "",
        theme.border(padLine((theme.capabilities.unicode ? "─" : "-").repeat(width), width)),
        "",
      ];
      for (const question of this.questions) {
        const answer = question.skipped
          ? "已跳过"
          : Array.isArray(question.answer)
            ? question.answer.join(" → ")
            : question.answer || "未回答";
        lines.push(padLine(theme.bold(question.title), width));
        lines.push(theme.text(padLine(`  ${answer}`, width)));
      }
      return lines;
    }
    const question = this.questions[this.questionIndex];
    if (!question) return [];
    const gutter = width >= 10 ? 2 : width >= 6 ? 1 : 0;
    const contentWidth = Math.max(1, width - gutter);
    const inset = (line: string) => padLine(`${" ".repeat(gutter)}${padLine(line, contentWidth)}`, width);
    const lines = [
      inset(
        alignRight(theme.muted(`Question ${this.questionIndex + 1} / ${this.questions.length}`), status, contentWidth),
      ),
      "",
      inset(theme.bold(question.title)),
      ...wrapTextWithAnsi(question.prompt, contentWidth).map(inset),
      "",
      inset(theme.border((theme.capabilities.unicode ? "─" : "-").repeat(contentWidth))),
      "",
    ];
    if (this.questionDirectAnswer || question.kind === "freeText") {
      this.questionInput.focused = true;
      const input = (this.questionInput.render(Math.max(1, contentWidth - 2))[0] ?? "").replace(/^> /, "");
      lines.push(theme.muted(inset("你的回答")));
      lines.push("");
      lines.push(inset(`${theme.focus("›")} ${input}`));
      lines.push(inset(theme.border((theme.capabilities.unicode ? "─" : "-").repeat(contentWidth))));
      return lines;
    }
    this.questionInput.focused = false;
    this.questionPinnedRows = 3;
    const options = [...(question.options ?? []), { id: "other", label: "其他" }];
    const answer = Array.isArray(question.answer) ? question.answer : [];
    const decorated = options.map((option, index) => {
      const selected = index === this.state.selected;
      const symbol =
        question.kind === "multiChoice"
          ? answer.includes(option.id)
            ? theme.capabilities.unicode
              ? "[✓]"
              : "[x]"
            : "[ ]"
          : question.kind === "ranking"
            ? option.id === "other"
              ? theme.capabilities.unicode
                ? "·"
                : "+"
              : `${index + 1}.`
            : selected
              ? theme.capabilities.unicode
                ? "(●)"
                : "(*)"
              : "( )";
      return { option, selected, label: `${symbol} ${option.label}` };
    });
    const itemContentWidth = Math.max(1, contentWidth - 2);
    const labelWidth = Math.min(24, Math.max(...decorated.map(({ label }) => visibleWidth(label))));
    const inlineDescriptions = decorated.every(({ option }) => {
      const description = "description" in option ? option.description : undefined;
      return !description || labelWidth + 2 + visibleWidth(description) <= itemContentWidth;
    });
    const itemLine = (value: string, selected: boolean, continuation = false) => {
      const marker = !continuation && selected ? theme.focus("› ") : "  ";
      const content = padLine(`${marker}${value}`, contentWidth);
      return selected ? theme.focus(theme.bold(content)) : content;
    };
    decorated.forEach(({ option, selected, label }) => {
      const itemStart = lines.length;
      const description = "description" in option && option.description ? option.description : undefined;
      if (description && inlineDescriptions) {
        lines.push(inset(itemLine(`${padLine(label, labelWidth + 2)}${theme.muted(description)}`, selected)));
      } else {
        const labelLines = wrapTextWithAnsi(label, itemContentWidth);
        for (const [lineIndex, labelLine] of labelLines.entries()) {
          lines.push(inset(itemLine(labelLine, selected, lineIndex > 0)));
        }
        if (description) {
          for (const descriptionLine of wrapTextWithAnsi(description, Math.max(1, itemContentWidth - 2))) {
            lines.push(inset(itemLine(`  ${theme.muted(descriptionLine)}`, selected, true)));
          }
        }
      }
      if (selected) this.questionSelectionRange = [itemStart, lines.length - 1];
    });
    return lines;
  }

  private _cursor(theme: VspiTheme): string {
    return theme.inverse(" ");
  }
}

export function humanizePlanId(id: string): string {
  const normalized = id.replace(/\bv(\d+)-(\d+)-(\d+)\b/gi, "v$1.$2.$3");
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.toLowerCase() === "vspi") return "VSPi";
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function approvalCategoryLabel(category: ApprovalRequest["category"]): string {
  const labels: Record<ApprovalRequest["category"], string> = {
    "file-read": "读取文件",
    "file-write": "修改文件",
    "bash-read": "执行只读命令",
    process: "执行进程",
    network: "访问网络",
    ssh: "SSH 连接",
    "git-write": "修改 Git",
    destructive: "删除或覆盖文件",
    container: "容器操作",
    system: "系统操作",
    shared: "共享操作",
  };
  return labels[category];
}

function hasLaterPlanSibling(items: PlanItem[], index: number): boolean {
  const item = items[index];
  if (!item) return false;
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    const candidate = items[cursor];
    if (!candidate || candidate.depth < item.depth) return false;
    if (candidate.depth === item.depth) return true;
  }
  return false;
}

function planTreePrefix(items: PlanItem[], index: number, theme: VspiTheme): string {
  const item = items[index];
  if (!item || item.depth === 0) return "";
  let prefix = "";
  for (let depth = 0; depth < item.depth - 1; depth += 1) {
    let ancestorIndex = index - 1;
    while (ancestorIndex >= 0 && (items[ancestorIndex]?.depth ?? -1) > depth) ancestorIndex -= 1;
    prefix += ancestorIndex >= 0 && hasLaterPlanSibling(items, ancestorIndex) ? "│  " : "   ";
  }
  return theme.muted(`${prefix}${hasLaterPlanSibling(items, index) ? "├─ " : "╰─ "}`);
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
        label: item.title,
        status: item.status,
        depth,
        ...(item.id === plan.focusItemId ? { focused: true } : {}),
        ...(item.status === "blocked" && item.blocker ? { blocker: item.blocker } : {}),
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
      if (item.status === "in_progress") return "blocked";
      if (item.status === "blocked") return "done";
      return "pending";
    }
    if (item.children) stack.unshift(...item.children);
  }
  return "pending";
}
