import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VspiApp } from "../src/app/vspi-app.js";
import type { AttachmentService } from "../src/attachments/service.js";
import type { ChatBackend, ChatBackendEvents } from "../src/backend/types.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { composeEffectivePrompt } from "../src/prompts/effective-prompt.js";
import { createFactoryPromptRegistry } from "../src/prompts/factory-registry.js";
import { checkHarnessSources, type HarnessSource } from "../src/prompts/harness-check.js";
import { createPromptProfileExtension } from "../src/prompts/pi-prompt-profile-extension.js";
import { createPromptProfileService, type PromptProfileService } from "../src/prompts/profile-service.js";
import type { PromptProfile, PromptProfileConfig, PromptProfileSnapshot } from "../src/prompts/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController, type PromptPanelSnapshot } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

type ProfileScope = "global" | "project" | "session";

const EMPTY_CONFIG: PromptProfileConfig = {
  schemaVersion: 1,
  source: "vspi.prompt-profile",
  profiles: [],
  rules: [],
};

async function servicePair(label: string) {
  const root = await mkdtemp(join(tmpdir(), `vspi-m7-corrective-${label}-`));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })]);
  const options = { cwd, home, trustedProject: true };
  return {
    root,
    cwd,
    home,
    first: createPromptProfileService(options),
    second: createPromptProfileService(options),
  };
}

function userProfile(id: string, sourceType: "global" | "project" | "session" = "global"): PromptProfile {
  return {
    id,
    name: id,
    family: "openai",
    sourceType,
    evaluationStatus: "reviewed",
    segments: { profile: `Overlay ${id}` },
    immutable: false,
  };
}

function config(profiles: PromptProfile[] = [], rules: PromptProfileConfig["rules"] = []): PromptProfileConfig {
  return { ...EMPTY_CONFIG, profiles, rules };
}

describe("M7 corrective: concurrency and immutable Factory ownership", () => {
  it("detects a stale expectedHash across two independently loaded service instances", async () => {
    const harness = await servicePair("concurrency");
    const [firstSnapshot, secondSnapshot] = await Promise.all([harness.first.load(), harness.second.load()]);
    expect(firstSnapshot.hashes.global).toBe(secondSnapshot.hashes.global);

    await harness.first.save("global", config([userProfile("writer-a")]), {
      expectedHash: firstSnapshot.hashes.global,
    });
    await expect(
      harness.second.save("global", config([userProfile("writer-b")]), {
        expectedHash: secondSnapshot.hashes.global,
      }),
    ).rejects.toThrow(/expectedHash|conflict|stale/i);

    const persisted = JSON.parse(
      await readFile(join(harness.home, ".config", "vspi", "prompt-profiles.json"), "utf8"),
    ) as PromptProfileConfig;
    expect(persisted.profiles.map((profile) => profile.id)).toEqual(["writer-a"]);
  });

  it.each(["global", "session"] as const)(
    "rejects Factory id shadowing and sourceType=factory in the %s layer",
    async (scope) => {
      const harness = await servicePair(`factory-${scope}`);
      await harness.first.load();
      const factory = createFactoryPromptRegistry().list()[0];
      if (!factory) throw new Error("Factory Registry is empty");

      await expect(
        harness.first.save(scope, config([{ ...structuredClone(factory), sourceType: scope, immutable: false }])),
      ).rejects.toThrow(/Factory|immutable|shadow/i);
      await expect(
        harness.first.save(
          scope,
          config([{ ...structuredClone(factory), id: `fake-factory-${scope}`, sourceType: "factory" }]),
        ),
      ).rejects.toThrow(/sourceType|Factory|immutable/i);
    },
  );

  it("rejects an import with the wrong top-level source and retains the last valid Session layer", async () => {
    const harness = await servicePair("import-source");
    await harness.first.load();
    const factory = createFactoryPromptRegistry().list()[0];
    if (!factory) throw new Error("Factory Registry is empty");
    const fork = await harness.first.fork(factory.id, { id: "last-valid", name: "Last valid", scope: "session" });
    const before = await harness.first.save(
      "session",
      config(
        [fork],
        [{ id: "last-valid-rule", enabled: true, profileId: fork.id, match: { model: "last-valid-model" } }],
      ),
    );
    const beforeResolution = harness.first.resolve({ provider: "test", model: "last-valid-model" });

    await expect(
      harness.first.import(
        JSON.stringify({
          schemaVersion: 1,
          source: "untrusted.prompt-profile",
          profile: userProfile("must-not-import", "session"),
        }),
        { scope: "session" },
      ),
    ).rejects.toThrow(/source/i);

    const after = await harness.first.load();
    expect(after.session).toEqual(before.session);
    expect(harness.first.resolve({ provider: "test", model: "last-valid-model" })).toEqual(beforeResolution);
  });

  it.each(["global", "project"] as const)(
    "rejects a Factory id shadow loaded from the %s file and retains the last-valid layer with a diagnostic",
    async (scope) => {
      const harness = await servicePair(`disk-factory-${scope}`);
      await harness.first.load();
      const valid = config([userProfile(`last-valid-${scope}`, scope)]);
      const expectedHash = (await harness.first.load()).hashes[scope];
      if (!expectedHash) throw new Error(`${scope} fixture hash missing`);
      const validSnapshot = await harness.first.save(scope, valid, {
        expectedHash,
      });
      const factory = createFactoryPromptRegistry().list()[0];
      if (!factory) throw new Error("Factory Registry is empty");
      const path =
        scope === "global"
          ? join(harness.home, ".config", "vspi", "prompt-profiles.json")
          : join(harness.cwd, ".vspi", "prompt-profiles.json");
      await writeFile(
        path,
        `${JSON.stringify(config([{ ...factory, sourceType: scope, immutable: false }]), null, 2)}\n`,
        "utf8",
      );

      const loaded = await harness.first.load();
      expect(loaded[scope]).toEqual(validSnapshot[scope]);
      expect(loaded.diagnostics).toEqual([
        expect.objectContaining({ path, message: expect.stringMatching(/last-valid.*Factory|Factory.*last-valid/i) }),
      ]);
    },
  );
});

interface PromptProfileUiHarness {
  service: PromptProfileService;
  load: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  export: ReturnType<typeof vi.fn>;
  importFile: ReturnType<typeof vi.fn>;
  writeExport: ReturnType<typeof vi.fn>;
}

function promptSnapshot(): PromptProfileSnapshot {
  const factory = createFactoryPromptRegistry().list()[0];
  if (!factory) throw new Error("Factory Registry is empty");
  const global = config(
    [],
    [{ id: "global-rule", enabled: true, profileId: factory.id, match: { family: factory.family } }],
  );
  const project = config(
    [],
    [{ id: "project-rule", enabled: true, profileId: factory.id, match: { provider: "openai" } }],
  );
  const session = config([], [{ id: "session-rule", enabled: true, profileId: factory.id, match: { model: "gpt-5" } }]);
  return {
    profiles: [structuredClone(factory)],
    rules: [...global.rules, ...project.rules, ...session.rules],
    global,
    project,
    session,
    hashes: { global: "global-hash", project: "project-hash", session: "session-hash" },
    hash: "snapshot-hash",
    diagnostics: [],
  };
}

function promptUiHarness(snapshot = promptSnapshot()): PromptProfileUiHarness {
  const load = vi.fn(async () => structuredClone(snapshot));
  const resolve = vi.fn(() => ({
    profile: structuredClone(snapshot.profiles[0]),
    profileId: snapshot.profiles[0]?.id,
    overlay: snapshot.profiles[0]?.segments.profile,
    scope: "factory" as const,
  }));
  const save = vi.fn(async () => structuredClone(snapshot));
  const fork = vi.fn(async () => ({}));
  const exportProfile = vi.fn(() => "legacy in-memory export must not be used");
  const importFile = vi.fn(async () => structuredClone(snapshot.profiles[0]));
  const writeExport = vi.fn(async () => "/tmp/vspi-exports/factory-openai.json");
  const service = {
    load,
    resolve,
    save,
    fork,
    export: exportProfile,
    import: vi.fn(async () => structuredClone(snapshot.profiles[0])),
    importFile,
    writeExport,
    refreshFactory: vi.fn(),
  } as unknown as PromptProfileService;
  return { service, load, resolve, save, fork, export: exportProfile, importFile, writeExport };
}

function fakeTui(): TUI {
  return {
    terminal: { columns: 100, rows: 30, setProgress: vi.fn(), write: vi.fn() },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeAttachments(): AttachmentService {
  return {
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AttachmentService;
}

function fakeBackend(): ChatBackend {
  return {
    kind: "fixture",
    modelLabel: "OpenAI / GPT-5",
    modelId: "gpt-5",
    modelProvider: "openai",
    supportsVision: false,
    start: vi.fn(async (_events: ChatBackendEvents) => {}),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

interface CorrectivePromptEvent {
  type: "promptImport";
  path: string;
  scope: ProfileScope;
}

interface TestableApp {
  applyPanelEvent(event: CorrectivePromptEvent | { type: "promptExport"; profileId: string }): Promise<void>;
}

async function appHarness(profiles = promptUiHarness()) {
  const app = new VspiApp(fakeTui(), plainTheme(), fakeBackend(), {
    cwd: "/workspace/m7-corrective",
    settings: { ...DEFAULT_SETTINGS, bridgeEnabled: false },
    attachments: fakeAttachments(),
    renderOnce: true,
    promptProfiles: profiles.service,
    onExit: vi.fn(),
  });
  await app.start();
  return { app, profiles, testable: app as unknown as TestableApp };
}

async function openPrompt(app: VspiApp): Promise<void> {
  app.composer.setText("/prompt");
  app.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("M7 corrective: real App/Panel actions and scope ownership", () => {
  it("collects an Import path in the Panel and dispatches the real service importFile flow", async () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setPromptSnapshot({
      profiles: [],
      rules: [],
      resolved: { scope: "off", pinned: false, disabled: true },
      effectiveSegments: [],
    });
    panel.open("prompt");
    expect(panel.handleInput("i")).toBeUndefined();
    for (const character of "/tmp/profile.json") expect(panel.handleInput(character)).toBeUndefined();
    expect(panel.handleInput("\r")).toEqual({
      type: "promptImport",
      path: "/tmp/profile.json",
      scope: "session",
    });

    const harness = await appHarness();
    try {
      await harness.testable.applyPanelEvent({
        type: "promptImport",
        path: "/tmp/profile.json",
        scope: "session",
      });
      expect(harness.profiles.importFile).toHaveBeenCalledWith("/tmp/profile.json", { scope: "session" });
      expect(harness.profiles.load).toHaveBeenCalled();
    } finally {
      await harness.app.dispose();
    }
  });

  it("uses the real export writer and reports the returned artifact path", async () => {
    const harness = await appHarness();
    try {
      await harness.testable.applyPanelEvent({ type: "promptExport", profileId: "factory-openai" });
      expect(harness.profiles.writeExport).toHaveBeenCalledWith("factory-openai");
      expect(harness.profiles.export).not.toHaveBeenCalled();
      expect(stripAnsi(harness.app.render(100).join("\n"))).toContain("/tmp/vspi-exports/factory-openai.json");
    } finally {
      await harness.app.dispose();
    }
  });

  it("toggles a rule only in its owning layer instead of flattening all rules into Session", async () => {
    const snapshot = promptSnapshot();
    const harness = await appHarness(promptUiHarness(snapshot));
    try {
      await openPrompt(harness.app);
      harness.profiles.save.mockClear();

      await (
        harness.app as unknown as {
          applyPanelEvent(event: { type: "promptToggleRule"; ruleId: string; enabled: boolean }): Promise<void>;
        }
      ).applyPanelEvent({ type: "promptToggleRule", ruleId: "global-rule", enabled: false });

      expect(harness.profiles.save).toHaveBeenCalledTimes(1);
      const [scope, saved] = harness.profiles.save.mock.calls[0] as [ProfileScope, PromptProfileConfig];
      expect(scope).toBe("global");
      expect(saved.rules).toEqual([{ ...snapshot.global.rules[0], enabled: false }]);
      expect(saved.rules.map((rule) => rule.id)).not.toEqual(expect.arrayContaining(["project-rule", "session-rule"]));
    } finally {
      await harness.app.dispose();
    }
  });

  it("carries duplicate rule ownership from Panel to App and updates exactly that layer with its snapshot hash", async () => {
    const snapshot = promptSnapshot();
    const duplicateId = "shared-rule";
    const globalRule = snapshot.global.rules[0];
    const project = snapshot.project;
    const projectRule = project?.rules[0];
    const session = snapshot.session;
    const sessionRule = session?.rules[0];
    if (!globalRule || !project || !projectRule || !session || !sessionRule) {
      throw new Error("Prompt ownership fixture is incomplete");
    }
    snapshot.global.rules = [{ ...globalRule, id: duplicateId }];
    project.rules = [{ ...projectRule, id: duplicateId }];
    session.rules = [{ ...sessionRule, id: duplicateId }];
    snapshot.rules = [...snapshot.global.rules, ...project.rules, ...session.rules];

    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setPromptSnapshot({
      profiles: [],
      rules: [
        { id: duplicateId, label: "Global shared", enabled: true, ownerScope: "global" },
        { id: duplicateId, label: "Project shared", enabled: true, ownerScope: "project" },
        { id: duplicateId, label: "Session shared", enabled: true, ownerScope: "session" },
      ],
      resolved: { scope: "factory", pinned: false, disabled: false },
      effectiveSegments: [],
    } as unknown as PromptPanelSnapshot);
    panel.open("prompt");
    const event = panel.handleInput("t");
    expect(event).toEqual({
      type: "promptToggleRule",
      ruleId: duplicateId,
      ownerScope: "global",
      enabled: false,
    });

    const harness = await appHarness(promptUiHarness(snapshot));
    try {
      await openPrompt(harness.app);
      harness.profiles.save.mockClear();
      await (harness.testable as unknown as { applyPanelEvent(event: unknown): Promise<void> }).applyPanelEvent(event);
      expect(harness.profiles.save).toHaveBeenCalledWith(
        "global",
        expect.objectContaining({ rules: [{ ...snapshot.global.rules[0], enabled: false }] }),
        { expectedHash: snapshot.hashes.global },
      );
    } finally {
      await harness.app.dispose();
    }
  });

  it("passes the owning snapshot hash for toggle, pin, and off read-modify-write saves", async () => {
    const snapshot = promptSnapshot();
    const harness = await appHarness(promptUiHarness(snapshot));
    try {
      await openPrompt(harness.app);
      harness.profiles.save.mockClear();
      const app = harness.testable as unknown as { applyPanelEvent(event: unknown): Promise<void> };

      await app.applyPanelEvent({
        type: "promptToggleRule",
        ruleId: "project-rule",
        ownerScope: "project",
        enabled: false,
      });
      await app.applyPanelEvent({ type: "promptPin", profileId: "factory-openai" });
      await app.applyPanelEvent({ type: "promptOff" });

      expect(harness.profiles.save).toHaveBeenNthCalledWith(1, "project", expect.any(Object), {
        expectedHash: snapshot.hashes.project,
      });
      expect(harness.profiles.save).toHaveBeenNthCalledWith(
        2,
        "session",
        expect.objectContaining({ pin: "factory-openai", disabled: false }),
        { expectedHash: snapshot.hashes.session },
      );
      expect(harness.profiles.save).toHaveBeenNthCalledWith(3, "session", expect.objectContaining({ disabled: true }), {
        expectedHash: snapshot.hashes.session,
      });
    } finally {
      await harness.app.dispose();
    }
  });
});

describe("M7 corrective: effective runtime projection and Harness resolver", () => {
  it("reports the fully assembled Pi prompt as one non-overlapping segment and does not invent a Plan segment", async () => {
    type Handler = (event: {
      type: "before_agent_start";
      prompt: string;
      systemPrompt: string;
      systemPromptOptions: Record<string, unknown>;
    }) => Promise<{ systemPrompt?: string } | undefined>;
    let handler: Handler | undefined;
    const onEffectivePrompt = vi.fn();
    createPromptProfileExtension({
      resolve: async () => ({ profileId: "profile", overlay: "PROFILE OVERLAY" }),
      getModelIdentity: () => ({ provider: "openai", model: "gpt-5" }),
      onEffectivePrompt,
    })({
      on(event: string, next: unknown) {
        if (event === "before_agent_start") handler = next as Handler;
      },
    } as never);
    if (!handler) throw new Error("before_agent_start handler was not registered");
    const assembled = "PI BASE\nCUSTOM SYSTEM\nAPPEND SYSTEM\nCONTEXT FILE";
    await handler({
      type: "before_agent_start",
      prompt: "turn",
      systemPrompt: assembled,
      systemPromptOptions: {
        customPrompt: "CUSTOM SYSTEM",
        appendSystemPrompt: "APPEND SYSTEM",
        contextFiles: [{ path: "AGENTS.md", content: "CONTEXT FILE" }],
      },
    });

    expect(onEffectivePrompt).toHaveBeenCalledWith([
      { source: "pi-base", content: assembled },
      { source: "profile", content: "PROFILE OVERLAY" },
    ]);
    const segments = onEffectivePrompt.mock.calls[0]?.[0] as Array<{ source: string; content: string }>;
    expect(segments.some((segment) => segment.source === "plan")).toBe(false);
    expect(
      segments
        .map((segment) => segment.content)
        .join("\n")
        .match(/CUSTOM SYSTEM/g),
    ).toHaveLength(1);
  });

  it("projects real composed runtime segments while keeping bearer and explicit secrets out of the UI", () => {
    const explicitSecret = "EXPLICIT_PROFILE_SECRET";
    const bearerSecret = "bearer-token-must-not-render";
    const effective = composeEffectivePrompt({
      piBase: "Pi runtime base",
      system: "SYSTEM runtime instructions",
      append: `APPEND runtime instructions\nAuthorization: Bearer ${bearerSecret}`,
      context: "AGENTS runtime context",
      profile: `Profile runtime overlay ${explicitSecret}`,
      secrets: [explicitSecret],
    });
    expect(effective.segments.map((segment) => segment.source)).toEqual([
      "pi-base",
      "system",
      "append",
      "context",
      "profile",
    ]);

    const snapshot: PromptPanelSnapshot = {
      profiles: [],
      rules: [],
      resolved: { scope: "session", pinned: false, disabled: false },
      effectiveSegments: effective.segments,
    };
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setPromptSnapshot(snapshot);
    panel.open("prompt");
    const rendered = stripAnsi(panel.render(100, 24, plainTheme(), DEFAULT_USAGE, true).join("\n"));
    for (const source of ["Pi base", "SYSTEM", "APPEND", "context", "Profile"]) expect(rendered).toContain(source);
    expect(rendered).not.toContain(explicitSecret);
    expect(rendered).not.toContain(bearerSecret);
  });

  it("reports a changed ref and an offline diagnostic through the public Harness resolver", async () => {
    const manifestPath = join(import.meta.dirname, "..", "Docs", "harness", "sources.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sources: HarnessSource[] };
    const changed = manifest.sources[0];
    const offline = manifest.sources[1];
    if (!changed || !offline) throw new Error("Harness manifest needs at least two sources");
    const before = await readFile(manifestPath, "utf8");

    const report = await checkHarnessSources({
      manifestPath,
      resolveUpstreamRef: vi.fn(async (source: HarnessSource) => {
        if (source.family === changed.family) return `${source.ref.value}-changed`;
        if (source.family === offline.family) throw new Error("offline: network unavailable");
        return source.ref.value;
      }),
    });

    expect(report.checked).toBe(manifest.sources.length);
    expect(report.changes).toEqual([
      {
        family: changed.family,
        currentRef: changed.ref.value,
        upstreamRef: `${changed.ref.value}-changed`,
        sourceUrl: changed.sourceUrl,
      },
    ]);
    expect(report.diagnostics).toEqual([expect.stringMatching(new RegExp(`${offline.family}.*offline`, "i"))]);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });
});
