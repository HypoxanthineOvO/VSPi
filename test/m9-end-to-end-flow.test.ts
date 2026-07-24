import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type {
  ChatBackend,
  ChatBackendEvents,
  NewSessionOptions,
  RuntimeModelOption,
  SendOptions,
} from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Attachment, ModelGroup, Question, SessionOption, TranscriptMessage } from "../src/domain/types.js";
import type { PlanInput, StoredPlan } from "../src/plans/types.js";
import type { PromptProfileConfig, PromptProfileSnapshot } from "../src/prompts/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

class TestTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(value: string): void {
    this.writes.push(value);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const PLAN_A: StoredPlan = {
  id: "plan-a",
  revision: 1,
  semanticHash: "a".repeat(64),
  archived: false,
  title: "Release A",
  goal: "Ship C1",
  challenges: [],
  items: [{ id: "integration", title: "Integration", status: "in_progress" }],
  focusItemId: "integration",
  blockers: [],
  nextAction: "Run final integration",
};

const PLAN_B: StoredPlan = {
  ...PLAN_A,
  id: "plan-b",
  semanticHash: "b".repeat(64),
  title: "Release B",
};

const EMPTY_PROFILE_CONFIG: PromptProfileConfig = {
  schemaVersion: 1,
  source: "vspi.prompt-profile",
  profiles: [],
  rules: [],
};

function promptSnapshot(): PromptProfileSnapshot {
  return {
    profiles: [
      {
        id: "factory.openai",
        name: "OpenAI Factory",
        family: "openai",
        sourceType: "factory",
        evaluationStatus: "verified",
        segments: { profile: "PROFILE_SENTINEL" },
        immutable: true,
      },
    ],
    rules: [],
    global: structuredClone(EMPTY_PROFILE_CONFIG),
    session: structuredClone(EMPTY_PROFILE_CONFIG),
    hashes: { global: "g".repeat(64), session: "s".repeat(64) },
    hash: "h".repeat(64),
    diagnostics: [],
  };
}

class StatefulPiBackend implements ChatBackend {
  readonly kind = "pi" as const;
  readonly modelLabel = "OpenAI / M9 Injected Pi";
  readonly modelId = "m9-injected";
  readonly modelProvider = "openai";
  readonly supportsVision = true;
  readonly sendCalls: Array<{ text: string; options: SendOptions }> = [];
  readonly compactCalls: unknown[] = [];
  readonly newCalls: NewSessionOptions[] = [];
  readonly switchCalls: string[] = [];
  readonly forkCalls: string[] = [];
  events: ChatBackendEvents | undefined;
  sessionId = "restored-session";
  planId = "plan-a";

  async start(events: ChatBackendEvents): Promise<void> {
    this.events = events;
    events.onSessionReset?.({ id: this.sessionId, reason: "startup" });
    events.onPlanBindingChange?.({ planId: this.planId });
    events.onEffectivePrompt?.([{ source: "profile", content: "PROFILE_SENTINEL" }]);
    events.onMessage({ id: "restored", role: "assistant", kind: "text", text: "RESTORED_SENTINEL" });
  }

  async send(text: string, options: SendOptions): Promise<void> {
    this.sendCalls.push({ text, options: structuredClone(options) });
    const questions: Question[] = [
      {
        id: "release",
        title: "Release",
        prompt: "Continue?",
        kind: "singleChoice",
        options: [{ id: "yes", label: "Yes" }],
      },
    ];
    const completed = await this.events?.onQuestion?.(questions);
    if (completed?.[0]?.answer !== "yes") throw new Error("M9 question answer was lost");
    this.events?.onMessage({ id: "answer", role: "assistant", kind: "text", text: "ANSWERED_SENTINEL" });
  }

  async cancel(): Promise<void> {}
  async compact(options?: unknown): Promise<void> {
    this.compactCalls.push(options);
  }
  async newSession(options: NewSessionOptions = { defaults: false, continuePlan: false }): Promise<void> {
    this.newCalls.push(options);
    this.events?.onSessionInvalidating?.();
    this.sessionId = "new-session";
    if (!options.continuePlan) this.planId = "";
    this.events?.onSessionReset?.({ id: this.sessionId, reason: "new", continuePlan: options.continuePlan });
    this.events?.onPlanBindingChange?.(this.planId ? { planId: this.planId } : undefined);
  }
  async listSessions(): Promise<SessionOption[]> {
    return [
      { id: "switch-target", label: "Switch target", relativeTime: "now", branchDepth: 0 },
      { id: "fork-target", label: "Fork target", relativeTime: "now", branchDepth: 0 },
    ];
  }
  async switchSession(id: string): Promise<void> {
    this.switchCalls.push(id);
    this.events?.onSessionInvalidating?.();
    this.sessionId = id;
    this.planId = "plan-b";
    this.events?.onSessionReset?.({ id, reason: "resume" });
    this.events?.onPlanBindingChange?.({ planId: this.planId });
    this.events?.onMessage({ id: `restored-${id}`, role: "assistant", kind: "text", text: `RESTORED_${id}` });
  }
  async forkSession(id: string): Promise<void> {
    this.forkCalls.push(id);
    this.events?.onSessionInvalidating?.();
    this.sessionId = `fork-${id}`;
    this.events?.onSessionReset?.({ id: this.sessionId, reason: "fork" });
    this.events?.onPlanBindingChange?.({ planId: this.planId });
  }
  getPlanBinding() {
    return this.planId ? { planId: this.planId } : undefined;
  }
  getEffectivePromptSegments() {
    return [{ source: "profile" as const, content: "PROFILE_SENTINEL" }];
  }
  async getModelOptions() {
    return [];
  }
  async getModelGroups() {
    return [];
  }
  async getProviderOptions() {
    return [];
  }
  isProjectTrusted(): boolean {
    return false;
  }
  async dispose(): Promise<void> {}
}

class StatefulAttachments {
  readonly switches: string[] = [];
  sessionGeneration = 0;
  sessionId = "";
  async start(): Promise<void> {}
  async switchSession(sessionId: string): Promise<Attachment[]> {
    this.sessionId = sessionId;
    this.sessionGeneration += 1;
    this.switches.push(sessionId);
    return [];
  }
  async dispose(): Promise<void> {}
}

interface TestableApp {
  messages: TranscriptMessage[];
  planSnapshot?: StoredPlan;
  effectivePromptSegments: Array<{ content: string }>;
  submit(raw: string): Promise<void>;
  applyPanelEvent(event: unknown): Promise<void>;
  modelLabel: string;
  effort: string;
  notice?: { text: string; tone: string };
  currentModelIdentity?: { provider: string; id: string };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M9 injected Pi end-to-end state flow", () => {
  it("preserves restore, question, attachment, plan, profile, compact, replacement, fork and restart state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m9-e2e-"));
    const terminal = new TestTerminal();
    const tui = new TUI(terminal);
    const backend = new StatefulPiBackend();
    const attachments = new StatefulAttachments();
    const plans = new Map([
      [PLAN_A.id, structuredClone(PLAN_A)],
      [PLAN_B.id, structuredClone(PLAN_B)],
    ]);
    const readPlan = vi.fn(async (id: string) => plans.get(id));
    const updatePlan = vi.fn(async (id: string, input: { expectedRevision: number; plan: PlanInput }) => {
      const current = plans.get(id);
      if (!current || current.revision !== input.expectedRevision) throw new Error("revision conflict");
      const updated: StoredPlan = {
        ...input.plan,
        id,
        revision: current.revision + 1,
        semanticHash: "c".repeat(64),
        archived: false,
      };
      plans.set(id, updated);
      return updated;
    });
    let profiles = promptSnapshot();
    const saveProfile = vi.fn(async (_scope: string, config: PromptProfileConfig) => {
      profiles = { ...profiles, session: structuredClone(config), hash: "i".repeat(64) };
      return profiles;
    });
    const profileService = {
      load: vi.fn(async () => profiles),
      resolve: vi.fn(() => ({
        profile: profiles.profiles[0],
        profileId: "factory.openai",
        scope: "factory",
        pinned: false,
        disabled: false,
      })),
      save: saveProfile,
      fork: vi.fn(async () => undefined),
      export: vi.fn(() => "{}"),
      importFile: vi.fn(async () => undefined),
      writeExport: vi.fn(async () => "/tmp/profile.json"),
    };
    const app = new VspiApp(tui, plainTheme(), backend, {
      cwd,
      settings: { ...DEFAULT_SETTINGS, scope: "global", bridgeEnabled: false },
      attachments: attachments as never,
      renderOnce: true,
      planBackend: { read: readPlan, update: updatePlan },
      planTaskRouter: { route: vi.fn(async () => ({ kind: "current-plan" as const })) },
      promptProfiles: profileService as never,
      onExit: vi.fn(),
    });
    const api = app as unknown as TestableApp;

    await app.start();
    await flush();
    expect(api.messages).toEqual([expect.objectContaining({ text: "RESTORED_SENTINEL" })]);
    expect(api.planSnapshot).toMatchObject({ id: "plan-a", revision: 1 });
    expect(api.effectivePromptSegments).toEqual([expect.objectContaining({ content: "PROFILE_SENTINEL" })]);
    expect(attachments.switches).toContain("restored-session");

    const attachment: Attachment = {
      id: "m9-image",
      alias: "M9 image",
      mimeType: "image/png",
      width: 1,
      height: 1,
      size: 68,
      path: "/tmp/m9-image.png",
      status: "ready",
    };
    app.composer.addAttachment(attachment);
    const submission = api.submit("INTEGRATION_PROMPT");
    await flush();
    await api.applyPanelEvent({
      type: "questions",
      questions: [
        {
          id: "release",
          title: "Release",
          prompt: "Continue?",
          kind: "singleChoice",
          options: [{ id: "yes", label: "Yes" }],
          answer: "yes",
        },
      ],
    });
    await submission;
    expect(backend.sendCalls).toEqual([
      expect.objectContaining({
        text: "INTEGRATION_PROMPT",
        options: expect.objectContaining({ attachments: [attachment] }),
      }),
    ]);
    expect(api.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "ANSWERED_SENTINEL" })]));

    await api.applyPanelEvent({
      type: "planEdit",
      planId: "plan-a",
      expectedRevision: 1,
      operation: { kind: "nextAction", value: "Proceed to acceptance" },
    });
    expect(api.planSnapshot).toMatchObject({ id: "plan-a", revision: 2, nextAction: "Proceed to acceptance" });
    await api.applyPanelEvent({ type: "promptPin", profileId: "factory.openai" });
    expect(saveProfile).toHaveBeenCalled();

    await api.submit("/compact continuity");
    expect(backend.compactCalls).toHaveLength(1);
    await api.submit("/new --continue");
    await flush();
    expect(backend.newCalls).toEqual([{ defaults: false, continuePlan: true }]);
    expect(backend.getPlanBinding()).toEqual({ planId: "plan-a" });
    expect(attachments.switches).toContain("new-session");

    await api.applyPanelEvent({
      type: "session",
      session: { id: "switch-target", label: "Switch", relativeTime: "now", branchDepth: 0 },
    });
    await flush();
    expect(backend.switchCalls).toEqual(["switch-target"]);
    expect(api.planSnapshot).toMatchObject({ id: "plan-b" });
    expect(api.messages).toEqual([expect.objectContaining({ text: "RESTORED_switch-target" })]);

    await api.applyPanelEvent({
      type: "fork",
      session: { id: "fork-target", label: "Fork", relativeTime: "now", branchDepth: 0 },
    });
    await flush();
    expect(backend.forkCalls).toEqual(["fork-target"]);
    expect(backend.getPlanBinding()).toEqual({ planId: "plan-b" });
    expect(attachments.switches).toContain("fork-fork-target");
    expect(profiles.session?.pin).toBe("factory.openai");

    await app.dispose();

    const restarted = new VspiApp(new TUI(new TestTerminal()), plainTheme(), backend, {
      cwd,
      settings: { ...DEFAULT_SETTINGS, scope: "global", bridgeEnabled: false },
      attachments: attachments as never,
      renderOnce: true,
      planBackend: { read: readPlan, update: updatePlan },
      promptProfiles: profileService as never,
      onExit: vi.fn(),
    });
    const restartedApi = restarted as unknown as TestableApp;
    await restarted.start();
    await flush();
    expect(restartedApi.planSnapshot).toMatchObject({ id: "plan-b" });
    expect(restartedApi.effectivePromptSegments).toEqual([expect.objectContaining({ content: "PROFILE_SENTINEL" })]);
    expect(attachments.sessionId).toBe("fork-fork-target");
    await restarted.dispose();
  });
});

const GROUP: ModelGroup = {
  id: "release-group",
  label: "Release Group",
  roles: [
    { role: "默认", modelId: "group-model", effort: "高" },
    { role: "总结", modelId: "summary-model", effort: "低" },
  ],
};

function runtimeModel(provider: string, id = "group-model"): RuntimeModelOption {
  return {
    provider,
    id,
    brand: provider,
    label: id === "group-model" ? "Group Model" : "Summary Model",
    vision: false,
    efforts: ["低", "中", "高"],
    price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    contextWindow: 128_000,
  };
}

async function modelGroupHarness(models: RuntimeModelOption[]) {
  let label = "OpenAI / Initial Model";
  const selectModel = vi.fn(async (provider: string, id: string) => {
    const selected = models.find((model) => model.provider === provider && model.id === id);
    if (!selected) throw new Error("selected model missing");
    label = `${provider === "openai" ? "OpenAI" : provider} / ${selected.label}`;
    return {
      modelId: id,
      vision: selected.vision,
      contextWindow: selected.contextWindow,
      profileModelId: id,
      effort: "中" as const,
    };
  });
  const setEffort = vi.fn(async () => {});
  const backend: ChatBackend = {
    kind: "pi",
    get modelLabel() {
      return label;
    },
    modelId: "initial-model",
    modelProvider: "openai",
    supportsVision: false,
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    getModelOptions: vi.fn(async () => models),
    getModelGroups: vi.fn(async () => [GROUP]),
    getProviderOptions: vi.fn(async () => []),
    selectModel,
    setEffort,
    isProjectTrusted: () => false,
    dispose: vi.fn(async () => {}),
  };
  const app = new VspiApp(new TUI(new TestTerminal()), plainTheme(), backend, {
    cwd: await mkdtemp(join(tmpdir(), "vspi-m9-model-group-")),
    settings: { ...DEFAULT_SETTINGS, scope: "global", bridgeEnabled: false },
    attachments: new StatefulAttachments() as never,
    renderOnce: true,
    onExit: vi.fn(),
  });
  await app.start();
  return { app, api: app as unknown as TestableApp, selectModel, setEffort };
}

describe("M9 Model Group availability", () => {
  it("does not mark a loaded group active until selection is explicitly confirmed", () => {
    const models = [runtimeModel("openai"), runtimeModel("openai", "summary-model")];
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(models, [GROUP], { provider: "openai", id: "initial-model" });
    panel.open("models");
    panel.handleInput("\t");

    const before = panel.render(80, 12, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(before).toContain(GROUP.label);
    expect(before).not.toMatch(/✓\s+Release Group/);

    panel.confirmModelGroupSelection(GROUP.id);
    const confirmed = panel.render(80, 12, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(confirmed).toMatch(/✓\s+Release Group/);
  });

  it("dispatches the Panel Enter event through the unique runtime provider and applies the default role effort", async () => {
    const models = [runtimeModel("openai"), runtimeModel("openai", "summary-model")];
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setModels(models, [GROUP], { provider: "openai", id: "initial-model" });
    panel.open("models");
    panel.handleInput("\t");
    const event = panel.handleInput("\r");
    expect(event).toMatchObject({ type: "modelGroup", group: { id: GROUP.id } });

    const h = await modelGroupHarness(models);
    try {
      await h.api.applyPanelEvent(event);
      expect(h.selectModel).toHaveBeenCalledWith("openai", "group-model");
      expect(h.setEffort).toHaveBeenCalledWith("高");
      expect(h.api.modelLabel).toBe("OpenAI / Group Model");
      expect(h.api.effort).toBe("高");
      expect(h.app.render(120).map(stripAnsi).join("\n")).not.toMatch(/尚未接入|不可用|歧义/);
    } finally {
      await h.app.dispose();
    }
  });

  it.each([
    ["ambiguous", [runtimeModel("openai"), runtimeModel("anthropic")], /歧义|多个|唯一/i],
    ["missing", [runtimeModel("openai", "other-model")], /缺失|不存在|找不到|不可用/i],
  ] as const)("fails closed when the default role model is %s", async (_case, models, diagnostic) => {
    const h = await modelGroupHarness([...models]);
    try {
      await h.api.applyPanelEvent({ type: "modelGroup", group: GROUP });
      expect(h.selectModel).not.toHaveBeenCalled();
      expect(h.setEffort).not.toHaveBeenCalled();
      expect(h.api.modelLabel).toBe("OpenAI / Initial Model");
      expect(h.api.effort).toBe("中");
      expect(h.api.notice).toMatchObject({ tone: "error", text: expect.stringMatching(diagnostic) });
    } finally {
      await h.app.dispose();
    }
  });

  it("does not select a model or change UI identity when the role Effort update fails", async () => {
    const h = await modelGroupHarness([runtimeModel("openai"), runtimeModel("openai", "summary-model")]);
    h.setEffort.mockRejectedValueOnce(new Error("effort write failed"));
    try {
      expect(h.api.currentModelIdentity).toEqual({ provider: "openai", id: "initial-model" });
      await h.api.applyPanelEvent({ type: "modelGroup", group: GROUP });

      expect(h.setEffort).toHaveBeenCalledWith("高");
      expect(h.selectModel).not.toHaveBeenCalled();
      expect(h.api.modelLabel).toBe("OpenAI / Initial Model");
      expect(h.api.effort).toBe("中");
      expect(h.api.currentModelIdentity).toEqual({ provider: "openai", id: "initial-model" });
      expect(h.api.notice).toMatchObject({ tone: "error", text: expect.stringContaining("effort write failed") });
      expect(h.app.render(120).map(stripAnsi).join("\n")).toContain("OpenAI / Initial Model");
    } finally {
      await h.app.dispose();
    }
  });
});
