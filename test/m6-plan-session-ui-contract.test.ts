import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, type CustomEntry, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { Question } from "../src/domain/types.js";
import { createLocalPlanBackend } from "../src/plans/local-plan-backend.js";
import { createDefaultPlanTaskRouter } from "../src/plans/task-router.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController, type PanelEvent } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

const PLAN_BINDING_CUSTOM_TYPE = "vspi.plan-binding";

type PlanStatus = "pending" | "in_progress" | "blocked" | "done";

interface PlanItemSnapshot {
  id: string;
  title: string;
  status: PlanStatus;
  children?: PlanItemSnapshot[];
  blocker?: string;
}

interface LocalPlanSnapshot {
  id: string;
  title: string;
  goal: string;
  background?: string;
  challenges: string[];
  items: PlanItemSnapshot[];
  focusItemId?: string;
  blockers: string[];
  nextAction?: string;
  revision: number;
  semanticHash: string;
  archived: boolean;
}

interface PlanBinding {
  planId: string;
}

interface PlanAwareBackend {
  getPlanBinding(): PlanBinding | undefined;
  bindPlan(planId: string | undefined): Promise<void>;
}

interface PlanBackendView {
  read(planId: string): Promise<LocalPlanSnapshot | undefined>;
  update(
    planId: string,
    input: {
      expectedRevision: number;
      plan: Omit<LocalPlanSnapshot, "id" | "revision" | "semanticHash">;
    },
  ): Promise<LocalPlanSnapshot>;
}

interface PlanTaskRouteInput {
  text: string;
  binding: PlanBinding;
  plan: LocalPlanSnapshot;
}

type PlanTaskRoute =
  | { kind: "current-plan" }
  | {
      kind: "question";
      questions: Question[];
    };

interface PlanTaskRouter {
  route(input: PlanTaskRouteInput): Promise<PlanTaskRoute>;
}

interface TestablePanel {
  setPlanSnapshot?(snapshot: LocalPlanSnapshot | undefined): void;
}

interface PlanEditEvent {
  type: "planEdit";
  planId: string;
  expectedRevision: number;
  operation:
    | { kind: "status"; itemId: string; status: PlanStatus }
    | { kind: "focus"; itemId: string }
    | { kind: "nextAction"; value: string };
}

interface TestableApp {
  submit(raw: string): Promise<void>;
  applyPanelEvent(event: PanelEvent | PlanEditEvent): Promise<void>;
  panels: PanelController;
}

const PLAN: LocalPlanSnapshot = {
  id: "plan-release",
  title: "Release readiness",
  goal: "Ship the reliable release",
  background: "The release must preserve existing sessions",
  challenges: ["Cross-session ownership", "Narrow terminal layout"],
  items: [
    {
      id: "runtime",
      title: "Runtime integration",
      status: "in_progress",
      children: [
        {
          id: "binding",
          title: "Persist session binding",
          status: "in_progress",
          children: [{ id: "reload", title: "Restore after reload", status: "pending" }],
        },
      ],
    },
    { id: "panel", title: "Plan workspace", status: "in_progress" },
    { id: "docs", title: "Document the contract", status: "blocked", blocker: "Awaiting API review" },
  ],
  focusItemId: "binding",
  blockers: ["API review is pending"],
  nextAction: "Run focused contract tests",
  revision: 7,
  semanticHash: "sha256:plan-release-r7",
  archived: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function planApi(backend: PiBackend): PlanAwareBackend {
  const candidate = backend as unknown as Partial<PlanAwareBackend>;
  expect(candidate.getPlanBinding, "PiBackend must expose the active session Plan binding").toBeTypeOf("function");
  expect(candidate.bindPlan, "PiBackend must persist bind/unbind operations in the active Pi session").toBeTypeOf(
    "function",
  );
  return candidate as PlanAwareBackend;
}

function fakePiSession(manager: SessionManager): AgentSession {
  return {
    model: {
      id: "m6-model",
      name: "M6 Model",
      provider: "test",
      input: ["text"],
      contextWindow: 32_000,
    },
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    messages: manager.buildSessionContext().messages,
    thinkingLevel: "medium",
    isStreaming: false,
    subscribe: vi.fn(() => () => {}),
    setThinkingLevel: vi.fn(),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    compact: vi.fn(async () => ({})),
    getContextUsage: vi.fn(() => ({ tokens: 0, contextWindow: 32_000, percent: 0 })),
    getSessionStats: vi.fn(() => ({
      sessionFile: manager.getSessionFile(),
      sessionId: manager.getSessionId(),
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    })),
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

async function piHarness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `vspi-m6-${label}-`));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const managers: SessionManager[] = [];
  const backend = new PiBackend({
    cwd,
    planBackend: createLocalPlanBackend({ rootDir: join(root, "compatibility-plans") }),
    sessionFactory: async (manager) => {
      managers.push(manager);
      return { session: fakePiSession(manager) };
    },
  });
  await backend.start({
    onMessage: vi.fn(),
    onMessageUpdate: vi.fn(),
    onBusy: vi.fn(),
    onUsage: vi.fn(),
    onNotice: vi.fn(),
  });
  return { root, cwd, agentDir, backend, managers };
}

function bindingEntries(manager: SessionManager): CustomEntry[] {
  return manager
    .getEntries()
    .filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === PLAN_BINDING_CUSTOM_TYPE);
}

function sessionInfo(manager: SessionManager): SessionInfo {
  const path = manager.getSessionFile();
  if (!path) throw new Error("M6 session fixture was not persisted");
  return {
    id: manager.getSessionId(),
    path,
    cwd: manager.getCwd(),
    created: new Date(),
    modified: new Date(),
    messageCount: manager.buildSessionContext().messages.length,
    firstMessage: "M6 session",
    allMessagesText: "M6 session",
  };
}

describe("M6 Pi Session Plan binding", () => {
  it("persists one effective binding as a real Pi custom entry and never as a transcript/context message", async () => {
    const harness = await piHarness("binding-entry");
    try {
      const api = planApi(harness.backend);
      expect(api.getPlanBinding()).toBeUndefined();

      await api.bindPlan("plan-alpha");

      expect(api.getPlanBinding()).toEqual({ planId: "plan-alpha" });
      const active = harness.managers.at(-1);
      if (!active) throw new Error("active SessionManager missing");
      expect(bindingEntries(active)).toHaveLength(1);
      expect(bindingEntries(active)[0]).toMatchObject({
        type: "custom",
        customType: PLAN_BINDING_CUSTOM_TYPE,
        data: { planId: "plan-alpha" },
      });
      expect(active.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
      expect(active.buildSessionContext().messages).toEqual([]);

      const persisted = SessionManager.open(active.getSessionFile() ?? "");
      expect(bindingEntries(persisted)).toHaveLength(1);
      expect(persisted.buildSessionContext().messages).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });

  it("unbinds ordinary /new and inherits exactly the previous binding for /new --continue", async () => {
    const harness = await piHarness("new-semantics");
    try {
      const api = planApi(harness.backend);
      await api.bindPlan("plan-alpha");
      await harness.backend.newSession({ defaults: false, continuePlan: false });
      expect(api.getPlanBinding()).toBeUndefined();
      expect(bindingEntries(harness.managers.at(-1) ?? (harness.managers[0] as SessionManager))).toEqual([]);

      await api.bindPlan("plan-beta");
      await harness.backend.newSession({ defaults: false, continuePlan: true });
      expect(api.getPlanBinding()).toEqual({ planId: "plan-beta" });
      const continued = harness.managers.at(-1);
      if (!continued) throw new Error("continued SessionManager missing");
      expect(bindingEntries(continued)).toHaveLength(1);
      expect(bindingEntries(continued)[0]?.data).toMatchObject({ planId: "plan-beta" });
      expect(continued.buildSessionContext().messages).toEqual([]);
    } finally {
      await harness.backend.dispose();
    }
  });

  it("restores each switched session binding and carries only the source binding into a fork", async () => {
    const harness = await piHarness("switch-fork");
    try {
      const alpha = SessionManager.create(harness.cwd);
      alpha.appendCustomEntry(PLAN_BINDING_CUSTOM_TYPE, { planId: "plan-alpha" });
      alpha.appendMessage({ role: "user", content: "alpha branch point", timestamp: 1 });
      alpha.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "alpha ready" }],
        api: "openai-completions",
        provider: "test",
        model: "m6-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const beta = SessionManager.create(harness.cwd);
      beta.appendCustomEntry(PLAN_BINDING_CUSTOM_TYPE, { planId: "plan-beta" });
      beta.appendMessage({ role: "user", content: "beta branch point", timestamp: 3 });
      beta.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "beta ready" }],
        api: "openai-completions",
        provider: "test",
        model: "m6-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      });
      vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo(alpha), sessionInfo(beta)]);
      const api = planApi(harness.backend);

      await harness.backend.switchSession(alpha.getSessionId());
      expect(api.getPlanBinding()).toEqual({ planId: "plan-alpha" });
      await harness.backend.switchSession(beta.getSessionId());
      expect(api.getPlanBinding()).toEqual({ planId: "plan-beta" });
      await harness.backend.forkSession?.(alpha.getSessionId());
      expect(api.getPlanBinding()).toEqual({ planId: "plan-alpha" });

      const fork = harness.managers.at(-1);
      if (!fork) throw new Error("fork SessionManager missing");
      expect(bindingEntries(fork).at(-1)?.data).toMatchObject({ planId: "plan-alpha" });
      expect(bindingEntries(fork).some((entry) => JSON.stringify(entry.data).includes("plan-beta"))).toBe(false);
    } finally {
      await harness.backend.dispose();
    }
  });

  it("keeps the previous effective binding when persistence fails, then remains usable", async () => {
    const harness = await piHarness("atomic-failure");
    try {
      const api = planApi(harness.backend);
      await api.bindPlan("plan-alpha");
      const active = harness.managers.at(-1);
      if (!active) throw new Error("active SessionManager missing");
      const append = vi.spyOn(active, "appendCustomEntry").mockImplementationOnce(() => {
        throw new Error("PLAN_BIND_APPEND_FAILED");
      });

      await expect(api.bindPlan("plan-beta")).rejects.toThrow("PLAN_BIND_APPEND_FAILED");
      expect(api.getPlanBinding()).toEqual({ planId: "plan-alpha" });
      expect(bindingEntries(active)).toHaveLength(1);
      append.mockRestore();

      await api.bindPlan("plan-beta");
      expect(api.getPlanBinding()).toEqual({ planId: "plan-beta" });
      expect(bindingEntries(active).at(-1)?.data).toMatchObject({ planId: "plan-beta" });
    } finally {
      await harness.backend.dispose();
    }
  });
});

function setSnapshot(panel: PanelController, snapshot: LocalPlanSnapshot | undefined): void {
  const testable = panel as unknown as TestablePanel;
  expect(
    testable.setPlanSnapshot,
    "PanelController must read a LocalPlan snapshot rather than fixture items",
  ).toBeTypeOf("function");
  testable.setPlanSnapshot?.(structuredClone(snapshot));
  panel.open("plan");
}

function planRender(panel: PanelController, width: number, rows = 30, focused = true): string {
  const lines = panel.render(width, rows, plainTheme(), DEFAULT_USAGE, focused);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  return lines.map(stripAnsi).join("\n");
}

describe("M6 Local Plan workspace projection", () => {
  it("keeps the unbound/missing snapshot empty state exact", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    setSnapshot(panel, undefined);
    const rendered = planRender(panel, 80);
    expect(rendered).toContain("Plan");
    expect(rendered).not.toMatch(/Workflow|当前计划为空/);
    expect(rendered).not.toContain(PLAN.title);
    expect(rendered).not.toContain("更新计划");
  });

  it("renders the complete wide snapshot with one focus, multiple in-progress items and at most three levels", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    setSnapshot(panel, PLAN);
    const rendered = planRender(panel, 120, 40);

    for (const text of [
      PLAN.title,
      PLAN.goal,
      PLAN.background ?? "",
      ...PLAN.challenges,
      "Runtime integration",
      "Persist session binding",
      "Restore after reload",
      "Plan workspace",
      "API review is pending",
      PLAN.nextAction ?? "",
    ]) {
      expect(rendered).toContain(text);
    }
    expect(rendered).toMatch(/(focus|焦点)[^\n]*Persist session binding|Persist session binding[^\n]*(focus|焦点)/i);
    expect(rendered.indexOf("Runtime integration")).toBeLessThan(rendered.indexOf("Persist session binding"));
    expect(rendered.indexOf("Persist session binding")).toBeLessThan(rendered.indexOf("Restore after reload"));
  });

  it("uses an ordered, non-overflowing compact projection at 40 columns", () => {
    const compactPlan: LocalPlanSnapshot = {
      ...PLAN,
      title: "Plan R7",
      goal: "Ship safely",
      background: "Keep sessions",
      challenges: ["Branches"],
      blockers: ["Review"],
      nextAction: "Run tests",
      items: [
        {
          id: "one",
          title: "Runtime",
          status: "in_progress",
          children: [
            {
              id: "two",
              title: "Binding",
              status: "in_progress",
              children: [{ id: "three", title: "Reload", status: "pending" }],
            },
          ],
        },
      ],
      focusItemId: "two",
    };
    const panel = new PanelController(DEFAULT_SETTINGS);
    setSnapshot(panel, compactPlan);
    const rendered = planRender(panel, 40, 32);

    for (const text of [
      "Ship safely",
      "Keep sessions",
      "Branches",
      "Runtime",
      "Binding",
      "Reload",
      "Review",
      "Run tests",
    ])
      expect(rendered).toContain(text);
    const ordered = [
      "Ship safely",
      "Keep sessions",
      "Branches",
      "Runtime",
      "Binding",
      "Reload",
      "Review",
      "Run tests",
    ].map((text) => rendered.indexOf(text));
    expect(ordered.every((position, index) => index === 0 || position > (ordered[index - 1] ?? -1))).toBe(true);
  });
});

function freshPlanPanel(): PanelController {
  const panel = new PanelController(DEFAULT_SETTINGS);
  setSnapshot(panel, PLAN);
  planRender(panel, 100, 32, true);
  return panel;
}

describe("M6 contextual Plan edits", () => {
  it("opens an Enter action menu limited to status, focus and next-action edits", () => {
    const panel = freshPlanPanel();
    expect(panel.handleInput(Key.enter)).toBeUndefined();
    const menu = planRender(panel, 100, 32, true);
    expect(menu).toContain("状态");
    expect(menu).toContain("焦点");
    expect(menu).toContain("下一步");
    expect(menu).not.toMatch(/新增|删除|移动|重排|子项/);
  });

  it("emits revision-guarded status and focus operations from the contextual menu", () => {
    const statusPanel = freshPlanPanel();
    statusPanel.handleInput(Key.enter);
    const statusEvent = statusPanel.handleInput(Key.enter) as unknown as PlanEditEvent | undefined;
    expect(statusEvent).toMatchObject({
      type: "planEdit",
      planId: PLAN.id,
      expectedRevision: PLAN.revision,
      operation: { kind: "status", itemId: "runtime" },
    });

    const focusPanel = freshPlanPanel();
    focusPanel.handleInput(Key.enter);
    focusPanel.handleInput(Key.down);
    const focusEvent = focusPanel.handleInput(Key.enter) as unknown as PlanEditEvent | undefined;
    expect(focusEvent).toEqual({
      type: "planEdit",
      planId: PLAN.id,
      expectedRevision: PLAN.revision,
      operation: { kind: "focus", itemId: "runtime" },
    });
  });

  it("edits next action as text and keeps expectedRevision on the emitted operation", () => {
    const panel = freshPlanPanel();
    panel.handleInput(Key.enter);
    panel.handleInput(Key.down);
    panel.handleInput(Key.down);
    expect(panel.handleInput(Key.enter)).toBeUndefined();
    panel.handleInput(Key.ctrl("u"));
    panel.handleInput("Inspect failed binding");
    const event = panel.handleInput(Key.enter) as unknown as PlanEditEvent | undefined;
    expect(event).toEqual({
      type: "planEdit",
      planId: PLAN.id,
      expectedRevision: PLAN.revision,
      operation: { kind: "nextAction", value: "Inspect failed binding" },
    });
  });
});

function fakeTui(): TUI {
  return {
    terminal: { rows: 40, columns: 100, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } as unknown as AttachmentService;
}

function appBackend(binding: PlanBinding | undefined) {
  let events: ChatBackendEvents | undefined;
  let currentBinding = binding;
  const bindPlan = vi.fn(async (planId: string | undefined) => {
    currentBinding = planId ? { planId } : undefined;
    events?.onPlanBindingChange?.(currentBinding);
  });
  const backend = {
    kind: "pi",
    modelLabel: "Test / M6",
    modelId: "m6",
    supportsVision: false,
    start: vi.fn(async (captured: ChatBackendEvents) => {
      events = captured;
      captured.onSessionReset?.({ id: "session-m6", reason: "startup" });
    }),
    send: vi.fn(async () => ({ status: "completed" as const })),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    getPlanBinding: vi.fn(() => currentBinding),
    bindPlan,
    dispose: vi.fn(async () => {}),
  } as unknown as ChatBackend & PlanAwareBackend;
  return {
    backend,
    send: backend.send,
    bindPlan,
    events: () => events,
    resetSession(id: string, nextBinding: PlanBinding | undefined) {
      currentBinding = nextBinding;
      events?.onSessionReset?.({ id, reason: "resume" });
    },
  };
}

async function planApp(
  backend: ChatBackend & PlanAwareBackend,
  planBackend: PlanBackendView,
  planTaskRouter?: PlanTaskRouter,
): Promise<VspiApp> {
  const app = new VspiApp(fakeTui(), plainTheme(), backend, {
    cwd: "/workspace/m6-plan-app",
    settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
    attachments: fakeAttachments(),
    renderOnce: true,
    planBackend,
    ...(planTaskRouter ? { planTaskRouter } : {}),
    onExit: vi.fn(),
  } as never);
  await app.start();
  return app;
}

describe("M6 VspiApp Plan integration and intent routing", () => {
  it("uses the default router to question an obviously separate multi-step task", async () => {
    const route = await createDefaultPlanTaskRouter().route({
      text: "Design a billing system, implement its migration, and deploy it",
      binding: { planId: PLAN.id },
      plan: structuredClone(PLAN),
    });

    expect(route.kind).toBe("question");
    if (route.kind !== "question") return;
    expect(route.questions).toEqual([
      expect.objectContaining({
        title: "任务归属",
        kind: "singleChoice",
        options: expect.arrayContaining([
          expect.objectContaining({ id: "new-plan" }),
          expect.objectContaining({ id: "chat-only" }),
          expect.objectContaining({ id: "current-plan" }),
        ]),
      }),
    ]);
  });

  it("does not treat shared generic action and engineering terms as Plan domain relevance", async () => {
    const genericEngineeringPlan: LocalPlanSnapshot = {
      ...PLAN,
      title: "Implement Local Plan storage",
      goal: "Implement reliable Plan storage",
      background: "Store revisions safely",
    };

    const route = await createDefaultPlanTaskRouter().route({
      text: "Design a billing system, implement its migration, and deploy billing",
      binding: { planId: genericEngineeringPlan.id },
      plan: genericEngineeringPlan,
    });

    expect(route.kind).toBe("question");
  });

  it("reads the bound LocalPlan snapshot into PanelController and CAS-updates a full new document", async () => {
    const controlled = appBackend({ planId: PLAN.id });
    const updated = { ...PLAN, revision: 8, semanticHash: "sha256:plan-release-r8" };
    const planBackend: PlanBackendView = {
      read: vi.fn(async () => structuredClone(PLAN)),
      update: vi.fn(async () => structuredClone(updated)),
    };
    const app = await planApp(controlled.backend, planBackend);
    try {
      const testable = app as unknown as TestableApp;
      await vi.waitFor(() => expect(planBackend.read).toHaveBeenCalledWith(PLAN.id));
      testable.panels.open("plan");
      expect(planRender(testable.panels, 100, 32)).toContain(PLAN.goal);

      await testable.applyPanelEvent({
        type: "planEdit",
        planId: PLAN.id,
        expectedRevision: PLAN.revision,
        operation: { kind: "status", itemId: "runtime", status: "done" },
      });
      expect(planBackend.update).toHaveBeenCalledOnce();
      expect(planBackend.update).toHaveBeenCalledWith(
        PLAN.id,
        expect.objectContaining({
          expectedRevision: PLAN.revision,
          plan: expect.objectContaining({
            title: PLAN.title,
            goal: PLAN.goal,
            items: expect.arrayContaining([expect.objectContaining({ id: "runtime", status: "done" })]),
          }),
        }),
      );
      const updateInput = vi.mocked(planBackend.update).mock.calls[0]?.[1];
      expect(updateInput?.plan).not.toHaveProperty("revision");
      expect(updateInput?.plan).not.toHaveProperty("semanticHash");
    } finally {
      await app.dispose();
    }
  });

  it("refreshes the snapshot in the same Session after a successful plan_bind event", async () => {
    const controlled = appBackend({ planId: PLAN.id });
    const rebound: LocalPlanSnapshot = {
      ...PLAN,
      id: "plan-rebound",
      title: "Rebound plan",
      goal: "Show the newly bound snapshot",
      revision: 3,
      semanticHash: "sha256:plan-rebound-r3",
    };
    const planBackend: PlanBackendView = {
      read: vi.fn(async (planId) => structuredClone(planId === rebound.id ? rebound : PLAN)),
      update: vi.fn(async () => structuredClone(PLAN)),
    };
    const app = await planApp(controlled.backend, planBackend);
    try {
      const testable = app as unknown as TestableApp;
      await vi.waitFor(() => expect(planBackend.read).toHaveBeenCalledWith(PLAN.id));

      await controlled.bindPlan(rebound.id);

      await vi.waitFor(() => expect(planBackend.read).toHaveBeenCalledWith(rebound.id));
      testable.panels.open("plan");
      const rendered = planRender(testable.panels, 100, 32);
      expect(rendered).toContain(rebound.goal);
      expect(rendered).not.toContain(PLAN.goal);
    } finally {
      await app.dispose();
    }
  });

  it("does not let a delayed CAS result overwrite the snapshot after Session reset and binding change", async () => {
    const controlled = appBackend({ planId: PLAN.id });
    const replacement: LocalPlanSnapshot = {
      ...PLAN,
      id: "plan-after-reset",
      title: "Post-reset plan",
      goal: "Keep the replacement binding visible",
      revision: 2,
      semanticHash: "sha256:post-reset-r2",
    };
    const staleUpdate: LocalPlanSnapshot = {
      ...PLAN,
      title: "STALE CAS RESULT",
      goal: "This result belongs to the old Session",
      revision: 8,
      semanticHash: "sha256:stale-r8",
    };
    let resolveUpdate: ((plan: LocalPlanSnapshot) => void) | undefined;
    const planBackend: PlanBackendView = {
      read: vi.fn(async (planId) => structuredClone(planId === replacement.id ? replacement : PLAN)),
      update: vi.fn(
        async () =>
          new Promise<LocalPlanSnapshot>((resolve) => {
            resolveUpdate = resolve;
          }),
      ),
    };
    const app = await planApp(controlled.backend, planBackend);
    try {
      const testable = app as unknown as TestableApp;
      await vi.waitFor(() => expect(planBackend.read).toHaveBeenCalledWith(PLAN.id));
      const pendingEdit = testable.applyPanelEvent({
        type: "planEdit",
        planId: PLAN.id,
        expectedRevision: PLAN.revision,
        operation: { kind: "status", itemId: "runtime", status: "done" },
      });
      await vi.waitFor(() => expect(planBackend.update).toHaveBeenCalledOnce());

      controlled.resetSession("session-after-reset", { planId: replacement.id });
      await vi.waitFor(() => expect(planBackend.read).toHaveBeenCalledWith(replacement.id));
      resolveUpdate?.(structuredClone(staleUpdate));
      await pendingEdit;

      testable.panels.open("plan");
      const rendered = planRender(testable.panels, 100, 32);
      expect(rendered).toContain(replacement.goal);
      expect(rendered).not.toContain("STALE CAS RESULT");
      expect(rendered).not.toContain(staleUpdate.goal);
    } finally {
      await app.dispose();
    }
  });

  it("routes an obviously unrelated multi-step task through Question without sending or rebinding silently", async () => {
    const controlled = appBackend({ planId: PLAN.id });
    const questions: Question[] = [
      {
        id: "unrelated-plan-task",
        title: "任务归属",
        prompt: "这个多步骤任务与当前 Plan 明显无关，要新建 Plan 还是仅聊天处理？",
        kind: "singleChoice",
        options: [
          { id: "new-plan", label: "新建 Plan", description: "保持当前 Plan 不变" },
          { id: "chat-only", label: "仅聊天", description: "不写入当前 Plan" },
        ],
      },
    ];
    const router: PlanTaskRouter = {
      route: vi.fn(async () => ({ kind: "question" as const, questions })),
    };
    const planBackend: PlanBackendView = {
      read: vi.fn(async () => structuredClone(PLAN)),
      update: vi.fn(async () => {
        throw new Error("unrelated task must not update the bound Plan");
      }),
    };
    const app = await planApp(controlled.backend, planBackend, router);
    const testable = app as unknown as TestableApp;
    const submission = testable.submit("Design a separate billing system, implement it, migrate data, and deploy it");
    try {
      await vi.waitFor(() => expect(router.route).toHaveBeenCalledOnce());
      expect(router.route).toHaveBeenCalledWith({
        text: "Design a separate billing system, implement it, migrate data, and deploy it",
        binding: { planId: PLAN.id },
        plan: PLAN,
      });
      await vi.waitFor(() => expect(testable.panels.kind).toBe("question"));
      const rendered = testable.panels.render(100, 24, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
      expect(rendered).toContain("任务归属");
      expect(controlled.send).not.toHaveBeenCalled();
      expect(controlled.bindPlan).not.toHaveBeenCalled();
      expect(planBackend.update).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
      await submission;
    }
  });
});
