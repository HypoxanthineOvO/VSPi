import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderSplash } from "../src/ui/splash.js";
import { renderStatusLines, type StatusLineInput } from "../src/ui/status.js";
import type { VspiTheme } from "../src/ui/theme.js";
import { plainTheme } from "./helpers.js";

interface M1StartupStatus {
  model: string;
  backend: "Pi" | "Fixture";
  policy: string;
  boundary: "Sandboxed" | "Host";
  version: string;
}

type M1SplashRenderer = (width: number, theme: VspiTheme, progress: number, status: M1StartupStatus) => string[];

const renderM1Splash = renderSplash as unknown as M1SplashRenderer;

function statusInput(overrides: Record<string, unknown> = {}): StatusLineInput {
  return {
    cwd: "/workspace/vspi",
    usage: {
      ...DEFAULT_USAGE,
      contextTokens: 50_176,
      contextWindow: 128_000,
      contextPercent: 39,
      inputTokens: 42_000,
      outputTokens: 8_100,
      costUsd: 0.414,
    },
    modelLabel: "OpenAI / GPT-5.4",
    effort: "高",
    busy: false,
    backend: "Pi",
    policy: "Standard",
    boundary: "Sandboxed",
    ...overrides,
  } as unknown as StatusLineInput;
}

function plainStatus(input: StatusLineInput, width: number): string[] {
  const lines = renderStatusLines(input, width, plainTheme());
  expect(lines).toHaveLength(2);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  return lines.map(stripAnsi);
}

function expectInOrder(line: string, labels: string[]): void {
  let previous = -1;
  for (const label of labels) {
    const position = line.indexOf(label);
    expect(position, `${label} is missing from ${line}`).toBeGreaterThan(previous);
    previous = position;
  }
}

function visibleColumn(line: string, target: string): number {
  const index = line.indexOf(target);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

function expectFixedModelEffortGap(identity: string): void {
  const effort = identity.indexOf("Effort");
  expect(effort).toBeGreaterThan(-1);
  expect(identity.slice(0, effort)).toMatch(/\S {2}$/);
  expect(identity.slice(0, effort)).not.toMatch(/\S {3,}$/);
}

describe("M1 two-line status contract", () => {
  it.each([40, 80, 120] as const)("renders two exact-width, non-overlapping lines at %s columns", (width) => {
    const lines = plainStatus(statusInput(), width);

    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });

  it("uses Model/Effort/Context then an unlabeled cwd/Token/Cost row at 80 columns", () => {
    const [identity = "", telemetry = ""] = plainStatus(statusInput(), 80);

    expectInOrder(identity, ["Model", "Effort", "Context"]);
    expect(telemetry).toMatch(/^\/workspace\/vspi/);
    expect(telemetry).not.toMatch(/\bPath\b/);
    expectInOrder(telemetry, ["Token", "Cost"]);
    expect(telemetry).toContain("¥");
  });

  it("keeps telemetry anchors fixed when only long model and path values are truncated", () => {
    const short = plainStatus(statusInput(), 80);
    const long = plainStatus(
      statusInput({
        modelLabel: "A Provider With A Very Long Name / A Model With An Even Longer Identity",
        cwd: "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi",
      }),
      80,
    );

    expectFixedModelEffortGap(short[0] ?? "");
    expectFixedModelEffortGap(long[0] ?? "");
    expect(visibleColumn(long[0] ?? "", "Effort")).toBeGreaterThan(visibleColumn(short[0] ?? "", "Effort"));
    expect(visibleColumn(long[0] ?? "", "Context")).toBe(visibleColumn(short[0] ?? "", "Context"));
    for (const label of ["Token", "Cost"]) {
      const shortColumn = visibleColumn(short[1] ?? "", label);
      const longColumn = visibleColumn(long[1] ?? "", label);
      expect(shortColumn, `${label} must be present on status line 2`).toBeGreaterThan(-1);
      expect(longColumn).toBe(shortColumn);
    }
    expect(long[0]).toContain("…");
    expect(long[1]).toContain("…");
  });

  it("keeps Backend in Splash while retaining dynamic Policy truth", () => {
    const status = plainStatus(statusInput(), 120).join("\n");
    const piSplash = renderM1Splash(80, plainTheme(), 1, {
      model: "OpenAI / GPT-5.4",
      backend: "Pi",
      policy: "Standard",
      boundary: "Sandboxed",
      version: "9.8.7-test",
    })
      .map(stripAnsi)
      .join("\n");
    const fixtureSplash = renderM1Splash(80, plainTheme(), 1, {
      model: "Offline Fixture",
      backend: "Fixture",
      policy: "Standard",
      boundary: "Sandboxed",
      version: "9.8.7-test",
    })
      .map(stripAnsi)
      .join("\n");

    expect(status).not.toContain("Backend");
    expect(status).toContain("Policy Standard");
    expect(status).toContain("Sandboxed");
    expect(status).not.toMatch(/\bMode\b|\bAuto\b/);
    expect(piSplash).toContain("Backend Pi");
    expect(piSplash).toContain("Policy Standard");
    expect(piSplash).toContain("Sandboxed");
    expect(fixtureSplash).toContain("Backend Fixture");
    expect(fixtureSplash).toContain("Policy Standard");
    expect(fixtureSplash).toContain("Sandboxed");
    expect(fixtureSplash).not.toMatch(/\bMode\b|\bAuto\b/);
  });

  it("omits Splash-only Backend while retaining Policy at 80/120 columns", () => {
    const scenarios = [
      { backend: "Pi", policy: "Standard", boundary: "Sandboxed" },
      { backend: "Fixture", policy: "YOLO", boundary: "Host" },
    ] as const;
    const tracks = {
      80: { context: 56, token: 52, cost: 70 },
      120: { context: 96, token: 92, cost: 110 },
    } as const;

    for (const width of [80, 120] as const) {
      for (const capabilities of [
        { colorLevel: 0 as const, truecolor: false },
        { colorLevel: 3 as const, truecolor: true },
      ]) {
        for (const scenario of scenarios) {
          const ansi = renderStatusLines(statusInput(scenario), width, plainTheme(capabilities));
          const plain = ansi.map(stripAnsi);
          const rendered = plain.join("\n");

          expect(ansi).toHaveLength(2);
          expect(ansi.every((line) => visibleWidth(line) === width)).toBe(true);
          expect(rendered).not.toContain(`Backend ${scenario.backend}`);
          expect(rendered).toContain(`Policy ${scenario.policy}`);
          expect(rendered).toContain(scenario.boundary);
          expect(visibleColumn(plain[0] ?? "", "Model")).toBe(0);
          expect(visibleColumn(plain[0] ?? "", "Effort")).toBe(visibleWidth("Model OpenAI / GPT-5.4  "));
          expectFixedModelEffortGap(plain[0] ?? "");
          expect(visibleColumn(plain[0] ?? "", "Context")).toBe(tracks[width].context);
          expect(plain[1]).toMatch(/^\/workspace\/vspi/);
          expect(plain[1]).not.toMatch(/\bPath\b/);
          expect(visibleColumn(plain[1] ?? "", "Token")).toBe(tracks[width].token);
          expect(visibleColumn(plain[1] ?? "", "Cost")).toBe(tracks[width].cost);
        }
      }
    }
  });

  it("truncates only long model/path values while preserving telemetry and Policy", () => {
    const longModel = "A Provider With A Very Long Name / A Model With An Even Longer Identity";
    const longPath = "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi";

    for (const width of [80, 120] as const) {
      const plain = renderStatusLines(
        statusInput({
          modelLabel: longModel,
          cwd: longPath,
          backend: "Fixture",
          policy: "Standard",
          boundary: "Sandboxed",
        }),
        width,
        plainTheme(),
      ).map(stripAnsi);
      const rendered = plain.join("\n");

      expect(plain).toHaveLength(2);
      if (width === 80) expect(rendered).not.toContain(longModel);
      expect(rendered).not.toContain(longPath);
      expectFixedModelEffortGap(plain[0] ?? "");
      if (width === 80) expect(plain[0]?.slice(0, visibleColumn(plain[0] ?? "", "Effort"))).toContain("…");
      expect(plain[1]?.slice(0, visibleColumn(plain[1] ?? "", "Token"))).toContain("…");
      expect(plain[1]).toMatch(/^\//);
      expect(plain[1]).not.toMatch(/\bPath\b/);
      expect(rendered).not.toContain("Backend Fixture");
      expect(rendered).toContain("Policy Standard");
      expect(rendered).toContain("Sandboxed");
      expect(rendered).toContain("Context 50K / 128K 39%");
      expect(rendered).toContain("Token ↑42k ↓8.1k");
      expect(rendered).toContain("Cost ¥2.97");
    }
  });
});
