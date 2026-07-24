import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type ProfileSourceType = "factory" | "user-fork" | "global" | "project" | "session";
type EvaluationStatus = "unreviewed" | "reviewed" | "verified";

interface PromptProfile {
  id: string;
  name: string;
  family: string;
  sourceType: ProfileSourceType;
  evaluationStatus: EvaluationStatus;
  immutable: boolean;
  segments: { profile: string };
  origin?: { profileId: string; revision?: string };
}

interface PromptRule {
  id: string;
  enabled: boolean;
  profileId: string;
  match: { provider?: string; model?: string; family?: string };
}

interface ProfileLayerInput {
  schemaVersion: 1;
  source: "vspi.prompt-profile";
  profiles: PromptProfile[];
  rules: PromptRule[];
  pin?: string;
  disabled?: boolean;
}

interface FactoryPromptRegistry {
  list(): readonly PromptProfile[];
  get(id: string): PromptProfile | undefined;
}

interface PromptProfileSnapshot {
  profiles: PromptProfile[];
  diagnostics: Array<{ path: string; message: string }>;
  hashes: { global: string; project?: string; session?: string };
  hash: string;
}

interface ResolvedPromptProfile {
  profile?: PromptProfile;
  ruleId?: string;
  scope: "off" | "factory" | "global" | "project" | "session";
}

interface PromptProfileService {
  load(): Promise<PromptProfileSnapshot>;
  resolve(identity: { provider: string; model: string }): ResolvedPromptProfile;
  save(scope: "global" | "project" | "session", value: ProfileLayerInput): Promise<PromptProfileSnapshot>;
  fork(
    factoryId: string,
    input: { id: string; name: string; scope: "global" | "project" | "session" },
  ): Promise<PromptProfile>;
  import(serialized: string, options: { scope: "global" | "project" | "session" }): Promise<PromptProfile>;
  export(profileId: string): string;
  refreshFactory(registry: FactoryPromptRegistry): void;
}

interface EffectivePromptInput {
  piBase: string;
  system?: string;
  append?: string;
  context?: string;
  profile?: string;
  plan?: string;
  secrets?: string[];
}

interface EffectivePromptResult {
  segments: Array<{
    source: "pi-base" | "system" | "append" | "context" | "profile" | "plan";
    content: string;
  }>;
  text: string;
}

async function factoryModule() {
  const specifier = "../src/prompts/factory-registry.js";
  return (await import(specifier)) as {
    createFactoryPromptRegistry(options?: {
      entries?: PromptProfile[];
      contentOverrides?: Partial<Record<string, string>>;
    }): FactoryPromptRegistry;
  };
}

async function serviceModule() {
  const specifier = "../src/prompts/profile-service.js";
  return (await import(specifier)) as {
    createPromptProfileService(options: {
      cwd: string;
      home: string;
      trustedProject: boolean;
      factoryRegistry?: FactoryPromptRegistry;
    }): PromptProfileService;
  };
}

async function effectivePromptModule() {
  const specifier = "../src/prompts/effective-prompt.js";
  return (await import(specifier)) as {
    composeEffectivePrompt(input: EffectivePromptInput): EffectivePromptResult;
  };
}

async function serviceHarness(label: string, factoryRegistry?: FactoryPromptRegistry) {
  const root = await mkdtemp(join(tmpdir(), `vspi-m7-${label}-`));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const { createPromptProfileService } = await serviceModule();
  return {
    root,
    cwd,
    home,
    service: createPromptProfileService({
      cwd,
      home,
      trustedProject: true,
      ...(factoryRegistry ? { factoryRegistry } : {}),
    }),
  };
}

function layer(rules: PromptRule[], options: { pin?: string; disabled?: boolean } = {}): ProfileLayerInput {
  return {
    schemaVersion: 1,
    source: "vspi.prompt-profile",
    profiles: [],
    rules,
    ...(options.pin ? { pin: options.pin } : {}),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
  };
}

describe("M7 Factory Prompt Registry", () => {
  it("covers the ten required model families with independent source and evaluation metadata", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const profiles = createFactoryPromptRegistry().list();

    expect(new Set(profiles.map((profile) => profile.family))).toEqual(
      new Set([
        "anthropic",
        "openai",
        "google",
        "deepseek",
        "moonshot",
        "z-ai",
        "xiaomi",
        "minimax",
        "tencent",
        "alibaba",
      ]),
    );
    expect(profiles.every((profile) => profile.sourceType === "factory" && profile.immutable)).toBe(true);
    expect(profiles.some((profile) => profile.evaluationStatus === "unreviewed")).toBe(true);
    for (const profile of profiles) {
      expect(["unreviewed", "reviewed", "verified"]).toContain(profile.evaluationStatus);
      expect(profile.segments.profile.trim().length).toBeGreaterThan(0);
      expect(Object.isFrozen(profile), `${profile.id} must be immutable`).toBe(true);
    }
  });

  it("does not use evaluation status as a functional availability gate", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const registry = createFactoryPromptRegistry();
    const unreviewed = registry.list().find((profile) => profile.evaluationStatus === "unreviewed");
    if (!unreviewed) throw new Error("Factory fixture must retain at least one unreviewed profile");
    const harness = await serviceHarness("evaluation-not-gate", registry);

    await harness.service.load();
    await harness.service.save(
      "session",
      layer([{ id: "select-unreviewed", enabled: true, profileId: unreviewed.id, match: { model: "m" } }]),
    );

    expect(await harness.service.resolve({ provider: "test", model: "m" })).toMatchObject({
      profile: { id: unreviewed.id, evaluationStatus: "unreviewed" },
      scope: "session",
    });
  });
});

describe("M7 Prompt Profile matching and layered controls", () => {
  it("applies Session > project > global and exact model > provider > family, with rule toggles", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const registry = createFactoryPromptRegistry();
    const byFamily = (family: string) => {
      const profile = registry.list().find((item) => item.family === family);
      if (!profile) throw new Error(`Factory profile missing: ${family}`);
      return profile.id;
    };
    const harness = await serviceHarness("priority", registry);
    await harness.service.load();
    await harness.service.save(
      "global",
      layer([
        { id: "family", enabled: true, profileId: byFamily("openai"), match: { family: "openai" } },
        { id: "provider", enabled: true, profileId: byFamily("google"), match: { provider: "openai" } },
        { id: "model", enabled: true, profileId: byFamily("deepseek"), match: { model: "gpt-5" } },
      ]),
    );
    expect(await harness.service.resolve({ provider: "openai", model: "gpt-5" })).toMatchObject({
      profile: { id: byFamily("deepseek") },
      ruleId: "model",
      scope: "global",
    });

    await harness.service.save(
      "project",
      layer([
        { id: "project-provider", enabled: true, profileId: byFamily("moonshot"), match: { provider: "openai" } },
      ]),
    );
    await harness.service.save(
      "session",
      layer([{ id: "session-model", enabled: true, profileId: byFamily("anthropic"), match: { model: "gpt-5" } }]),
    );
    expect(await harness.service.resolve({ provider: "openai", model: "gpt-5" })).toMatchObject({
      profile: { id: byFamily("anthropic") },
      scope: "session",
    });

    await harness.service.save(
      "session",
      layer([{ id: "session-model", enabled: false, profileId: byFamily("anthropic"), match: { model: "gpt-5" } }]),
    );
    expect(await harness.service.resolve({ provider: "openai", model: "gpt-5" })).toMatchObject({
      profile: { id: byFamily("moonshot") },
      scope: "project",
    });
  });

  it("supports profile pin/off and rematches instead of carrying a stale profile across model switches", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const registry = createFactoryPromptRegistry();
    const openai = registry.list().find((item) => item.family === "openai");
    const anthropic = registry.list().find((item) => item.family === "anthropic");
    if (!openai || !anthropic) throw new Error("required Factory profiles missing");
    const harness = await serviceHarness("pin-off-switch", registry);
    await harness.service.load();
    await harness.service.save(
      "global",
      layer([
        { id: "openai-family", enabled: true, profileId: openai.id, match: { family: "openai" } },
        { id: "anthropic-family", enabled: true, profileId: anthropic.id, match: { family: "anthropic" } },
      ]),
    );

    expect((await harness.service.resolve({ provider: "openai", model: "gpt-5" })).profile?.id).toBe(openai.id);
    expect((await harness.service.resolve({ provider: "anthropic", model: "claude-sonnet-4" })).profile?.id).toBe(
      anthropic.id,
    );

    await harness.service.save("session", layer([], { pin: openai.id }));
    expect(await harness.service.resolve({ provider: "anthropic", model: "claude-sonnet-4" })).toMatchObject({
      profile: { id: openai.id },
      scope: "session",
    });
    await harness.service.save("session", layer([], { disabled: true }));
    expect(await harness.service.resolve({ provider: "openai", model: "gpt-5" })).toEqual({ scope: "off" });
  });
});

describe("M7 profile ownership and interchange", () => {
  it("keeps a user fork mutable and unchanged when its immutable Factory origin is refreshed", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const v1 = createFactoryPromptRegistry({ contentOverrides: { openai: "Factory OpenAI revision one" } });
    const harness = await serviceHarness("factory-refresh", v1);
    await harness.service.load();
    const factory = v1.list().find((profile) => profile.family === "openai");
    if (!factory) throw new Error("OpenAI Factory profile missing");

    const fork = await harness.service.fork(factory.id, {
      id: "my-openai",
      name: "My OpenAI",
      scope: "global",
    });
    expect(fork).toMatchObject({
      sourceType: "user-fork",
      immutable: false,
      origin: { profileId: factory.id },
      segments: { profile: "Factory OpenAI revision one" },
    });

    harness.service.refreshFactory(
      createFactoryPromptRegistry({ contentOverrides: { openai: "Factory OpenAI revision two" } }),
    );
    expect((await harness.service.load()).profiles.find((profile) => profile.id === fork.id)?.segments.profile).toBe(
      "Factory OpenAI revision one",
    );
  });

  it("exports and imports a versioned, source-attributed schema and keeps the last valid state on failure", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const registry = createFactoryPromptRegistry();
    const harness = await serviceHarness("import-export", registry);
    await harness.service.load();
    const factory = registry.list()[0];
    if (!factory) throw new Error("Factory registry is empty");
    const fork = await harness.service.fork(factory.id, { id: "portable", name: "Portable", scope: "global" });
    const serialized = await harness.service.export(fork.id);
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      source: "vspi.prompt-profile",
      profile: { id: "portable", sourceType: "user-fork" },
    });

    const imported = await harness.service.import(serialized, { scope: "session" });
    expect(imported).toMatchObject({ id: "portable", sourceType: "session" });
    await harness.service.save(
      "session",
      layer([{ id: "portable-rule", enabled: true, profileId: imported.id, match: { model: "portable-model" } }]),
    );
    const before = await harness.service.resolve({ provider: "test", model: "portable-model" });
    await expect(
      harness.service.import(
        JSON.stringify({ schemaVersion: 999, source: "vspi.prompt-profile", profile: { id: "broken" } }),
        { scope: "session" },
      ),
    ).rejects.toThrow(/schemaVersion|profile\.name|profile\.segments/i);
    expect(await harness.service.resolve({ provider: "test", model: "portable-model" })).toEqual(before);
  });
});

describe("M7 effective prompt provenance", () => {
  it("labels all six sources in order and redacts explicit and credential-shaped secrets", async () => {
    const { composeEffectivePrompt } = await effectivePromptModule();
    const result = composeEffectivePrompt({
      piBase: "Pi base",
      system: "SYSTEM instructions",
      append: "APPEND instructions",
      context: "AGENTS context with token sk-context-sentinel",
      profile: "Profile overlay uses api_key=PROFILE_SECRET_SENTINEL",
      plan: "Plan capsule",
      secrets: ["sk-context-sentinel", "PROFILE_SECRET_SENTINEL"],
    });

    expect(result.segments.map((segment) => segment.source)).toEqual([
      "pi-base",
      "system",
      "append",
      "context",
      "profile",
      "plan",
    ]);
    expect(result.text).not.toContain("sk-context-sentinel");
    expect(result.text).not.toContain("PROFILE_SECRET_SENTINEL");
    expect(result.segments.map((segment) => segment.content).join("\n")).toMatch(/\[REDACTED\]|•••/);
  });

  it("does not rewrite Pi SYSTEM, APPEND_SYSTEM, or AGENTS files while loading and composing", async () => {
    const { createFactoryPromptRegistry } = await factoryModule();
    const harness = await serviceHarness("read-only-user-files", createFactoryPromptRegistry());
    const files = [
      join(harness.cwd, "SYSTEM.md"),
      join(harness.cwd, "APPEND_SYSTEM.md"),
      join(harness.cwd, "AGENTS.md"),
    ];
    await Promise.all(files.map((path, index) => writeFile(path, `USER FILE ${index}\n`, "utf8")));
    const before = await Promise.all(files.map((path) => readFile(path, "utf8")));

    await harness.service.load();
    await harness.service.resolve({ provider: "openai", model: "gpt-5" });
    const { composeEffectivePrompt } = await effectivePromptModule();
    composeEffectivePrompt({
      piBase: "Pi",
      ...(before[0] ? { system: before[0] } : {}),
      ...(before[1] ? { append: before[1] } : {}),
      ...(before[2] ? { context: before[2] } : {}),
    });

    expect(await Promise.all(files.map((path) => readFile(path, "utf8")))).toEqual(before);
  });
});
