import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveBackend } from "../src/backend/adaptive-backend.js";
import { FixtureBackend } from "../src/backend/fixture-backend.js";
import { PiBackend } from "../src/backend/pi-backend.js";
import type { ChatBackendEvents } from "../src/backend/types.js";
import { loadSettings } from "../src/config/settings.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { resolveStartupSecurity } from "../src/policy/startup-security.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderStatusLines } from "../src/ui/status.js";
import { plainTheme } from "./helpers.js";

const execFile = promisify(execFileCallback);
const ROOT = resolve(import.meta.dirname, "..");

function events(): ChatBackendEvents {
  return {
    onMessage: vi.fn(),
    onMessageUpdate: vi.fn(),
    onBusy: vi.fn(),
    onUsage: vi.fn(),
    onNotice: vi.fn(),
  };
}

function hasForbiddenControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function isolatedCliEnv(home: string, fixture: boolean): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|VSPi_FIXTURE|VSPi_BACKEND)/i.test(key),
    ),
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: join(home, ".pi-agent"),
    VSPi_REDUCED_MOTION: "1",
    ...(fixture ? { VSPi_FIXTURE: "1" } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("M9 terminal render matrix", () => {
  const policies = [
    ["Safe", "Host"],
    ["Standard", "Host"],
    ["YOLO", "Host"],
    ["Auto", "Host"],
  ] as const;

  it.each([40, 80, 120] as const)(
    "renders bounded non-overlapping status at %s columns with and without color",
    (width) => {
      for (const colorLevel of [0, 3] as const) {
        const lines = renderStatusLines(
          {
            cwd: "/workspace/a/deep/path/that/must/flex/without/overlapping/telemetry",
            usage: {
              ...DEFAULT_USAGE,
              contextTokens: 50_176,
              contextWindow: 128_000,
              contextPercent: 39,
              inputTokens: 999_000,
              outputTokens: 888_000,
              costUsd: 9_999.99,
            },
            modelLabel: "OpenAI / A Very Long Production Model Identity",
            effort: "high",
            busy: true,
            policy: "Standard",
            boundary: "Sandboxed",
          },
          width,
          plainTheme({ colorLevel, truecolor: colorLevel === 3 }),
        );
        const plain = lines.map(stripAnsi);
        expect(lines).toHaveLength(2);
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(plain.every((line) => !hasForbiddenControl(line))).toBe(true);
        expect(plain[0]?.indexOf("Model")).toBeLessThan(plain[0]?.indexOf("Effort") ?? -1);
        expect(plain[0]?.indexOf("Effort")).toBeLessThan(plain[0]?.indexOf("Context") ?? -1);
        expect(plain[1]).toMatch(/^\//);
        expect(plain[1]).not.toMatch(/\bPath\b|Backend/);
        if (width >= 80) {
          expect(plain[1]).toContain("Policy Standard · Sandboxed");
          expect(plain[1]?.indexOf("Policy")).toBeLessThan(plain[1]?.indexOf("Token") ?? -1);
          expect(plain[1]?.indexOf("Token")).toBeLessThan(plain[1]?.indexOf("Cost") ?? -1);
        }
        if (colorLevel === 0) expect(lines.join("")).not.toContain("\u001b");
        else expect(lines.join("")).toContain("\u001b[");
      }
    },
  );

  it.each(policies)("reports %s only with its honest %s boundary", (policy, boundary) => {
    const plain = renderStatusLines(
      {
        cwd: "/workspace/vspi",
        usage: DEFAULT_USAGE,
        modelLabel: "Provider / Model",
        effort: "medium",
        busy: false,
        policy,
        boundary,
      },
      120,
      plainTheme(),
    ).map(stripAnsi);
    expect(plain.join("\n")).toContain(`Policy ${policy} · ${boundary}`);
  });

  it("makes Recovery visible while forcing Standard Host", () => {
    const security = resolveStartupSecurity({
      argv: ["--recovery", "--trust-project", "--policy", "YOLO"],
      globalPolicy: "YOLO",
      projectPolicy: "YOLO",
    });
    expect(security).toMatchObject({
      recovery: true,
      policy: "Standard",
      boundary: "Host",
      trustedProject: false,
      resourceScope: "global-only",
      extensions: false,
      workflowAdapter: false,
    });
    const rendered = renderStatusLines(
      {
        cwd: "/workspace/vspi",
        usage: DEFAULT_USAGE,
        modelLabel: "Provider / Model",
        effort: "medium",
        busy: false,
        mode: "Recovery",
        policy: security.policy,
        boundary: security.boundary,
      },
      120,
      plainTheme(),
    )
      .map(stripAnsi)
      .join("\n");
    expect(rendered).toContain("Recovery");
    expect(rendered).toContain("Policy Standard · Host");
    expect(rendered).not.toContain("YOLO");
  });
});

describe("M9 startup and legacy compatibility", () => {
  it("makes --render-once fail closed on unconfigured Pi and succeed only with explicit Fixture", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m9-render-once-project-"));
    const home = await mkdtemp(join(tmpdir(), "vspi-m9-render-once-home-"));
    const command = join(ROOT, "node_modules", ".bin", "tsx");
    const args = [join(ROOT, "src", "index.ts"), "--render-once"];

    let failure: (Error & { code?: number | string; stdout?: string; stderr?: string }) | undefined;
    try {
      await execFile(command, args, {
        cwd,
        env: isolatedCliEnv(home, false),
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    }
    expect(failure, "default --render-once must not silently start Fixture").toBeDefined();
    expect(failure?.code).not.toBe(0);
    expect(`${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`).not.toMatch(/Backend Fixture|Offline Fixture/);

    const explicit = await execFile(command, args, {
      cwd,
      env: isolatedCliEnv(home, true),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(`${explicit.stdout}\n${explicit.stderr}`).toMatch(/Backend Fixture|Offline Fixture/);
  }, 60_000);

  it("fails closed on Pi startup and never starts Fixture unless explicitly selected", async () => {
    const failure = new Error("M9 real Pi setup failure");
    const piStart = vi.spyOn(PiBackend.prototype, "start").mockRejectedValue(failure);
    const fixtureStart = vi.spyOn(FixtureBackend.prototype, "start").mockResolvedValue();
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m9-backend-"));

    const production = new AdaptiveBackend(cwd);
    await expect(production.start(events())).rejects.toBe(failure);
    expect(production.kind).toBe("pi");
    expect(fixtureStart).not.toHaveBeenCalled();

    const explicitFixture = new AdaptiveBackend(cwd, "fixture");
    await expect(explicitFixture.start(events())).resolves.toBeUndefined();
    expect(explicitFixture.kind).toBe("fixture");
    expect(piStart).toHaveBeenCalledOnce();
    expect(fixtureStart).toHaveBeenCalledOnce();
  });

  it("loads legacy partial global/project settings with current defaults and trust semantics", async () => {
    const home = await mkdtemp(join(tmpdir(), "vspi-m9-legacy-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "vspi-m9-legacy-project-"));
    await mkdir(join(home, ".config", "vspi"), { recursive: true });
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await writeFile(join(home, ".config", "vspi", "settings.json"), JSON.stringify({ theme: "Terminal" }));
    await writeFile(join(cwd, ".vspi", "settings.json"), JSON.stringify({ showThinking: false }));

    expect(await loadSettings(cwd, home, { trustedProject: false })).toEqual({
      ...DEFAULT_SETTINGS,
      scope: "global",
      theme: "Terminal",
    });
    expect(await loadSettings(cwd, home, { trustedProject: true })).toEqual({
      ...DEFAULT_SETTINGS,
      scope: "project",
      theme: "Terminal",
      thinkingDisplay: "hidden",
    });
  });
});
