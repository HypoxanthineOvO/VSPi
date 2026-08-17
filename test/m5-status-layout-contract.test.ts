import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { UsageSnapshot } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderStatusLines, type StatusLineInput } from "../src/ui/status.js";
import { plainTheme } from "./helpers.js";

const MAX_USAGE: UsageSnapshot = {
  ...DEFAULT_USAGE,
  contextTokens: 999_000,
  contextWindow: 1_000_000,
  contextPercent: 100,
  inputTokens: 999_000,
  outputTokens: 999_000,
  costUsd: 9_999.99,
  fxRate: 1,
};

const LONG_MODEL = "A Provider With A Very Long Name / A Model With An Even Longer Identity";
const LONG_PATH = "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi";

function input(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    cwd: LONG_PATH,
    usage: MAX_USAGE,
    modelLabel: LONG_MODEL,
    effort: "high",
    busy: false,
    backend: "Pi",
    policy: "Standard",
    boundary: "Sandboxed",
    ...overrides,
  };
}

function render(status: StatusLineInput, width: number): { ansi: string[]; plain: string[] } {
  const ansi = renderStatusLines(status, width, plainTheme());
  return { ansi, plain: ansi.map(stripAnsi) };
}

function expectOrder(line: string, labels: string[]): void {
  let previous = -1;
  for (const label of labels) {
    const current = line.indexOf(label);
    expect(current, `${label} missing from ${line}`).toBeGreaterThan(previous);
    previous = current;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAnsiStyled(rendered: string, token: string): boolean {
  return new RegExp(`\\u001b\\[[0-9;]*m${escapeRegExp(token)}\\u001b\\[[0-9;]*m`).test(rendered);
}

describe("M5 dynamic status layout", () => {
  it("places fixed Speed immediately before Context, prioritizing Speed at 40 columns", () => {
    for (const width of [40, 80, 120]) {
      const { ansi, plain } = render(input(), width);
      expect(plain).toHaveLength(2);
      expect(ansi.every((line) => visibleWidth(line) <= width)).toBe(true);
      expectOrder(plain[0] ?? "", width >= 80 ? ["Model", "Effort", "Speed", "Context"] : ["Model", "Effort", "Speed"]);
      if (width < 80) expect(plain[0]).not.toContain("Context");
      expect(plain[1]).toMatch(/^\//);
      expect(plain[1]).not.toMatch(/\bPath\b/);
      expectOrder(plain[1] ?? "", ["Token", "Cost"]);
      expect(plain.join("\n")).not.toContain("Backend");
      if (width >= 80) {
        expect(plain[0]).not.toContain("Policy");
        expect(plain[1]).toContain("Policy Standard · Sandboxed");
        expectOrder(plain[1] ?? "", ["Policy", "Token", "Cost"]);
      }
    }
  });

  it.each([80, 120] as const)("reserves complete representative telemetry tracks at %s columns", (width) => {
    const { ansi, plain } = render(input(), width);
    const identity = plain[0] ?? "";
    const telemetry = plain[1] ?? "";

    expect(ansi).toHaveLength(2);
    expect(ansi.every((line) => visibleWidth(line) === width)).toBe(true);
    expect(identity).toContain("Context 999K / 1000K 100%");
    expectOrder(identity, ["Speed", "Context"]);
    expect(telemetry).toMatch(/^\//);
    expect(telemetry).not.toMatch(/\bPath\b/);
    expect(telemetry).toContain("Policy Standard · Sandboxed");
    expect(telemetry).toContain("Token ↑999k ↓999k");
    expect(telemetry).toContain("Cost ¥9999.99");
    expect(identity.slice(identity.indexOf("Effort"))).not.toContain("…");
    expect(telemetry.slice(telemetry.indexOf("Token"))).not.toContain("…");
  });

  it.each([80, 120] as const)("keeps exactly two cells between the fitted Model and Effort at %s columns", (width) => {
    const [identity = ""] = render(input(), width).plain;
    const effort = identity.indexOf("Effort");
    const modelPrefix = identity.slice(0, effort);

    expect(effort).toBeGreaterThan(-1);
    expect(modelPrefix).toMatch(/^Model\s+.*\S {2}$/);
    expect(modelPrefix).not.toMatch(/… {3,}$|Backend|Policy/);
  });

  it("keeps the 40-column fallback on exactly two coherent bounded rows", () => {
    const { ansi, plain } = render(input(), 40);

    expect(ansi).toHaveLength(2);
    expect(ansi.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expectOrder(plain[0] ?? "", ["Model", "Effort", "Speed"]);
    expect(plain[0]).toMatch(/Effort\s+High\s+Speed/);
    expect(plain[0]).not.toContain("Context");
    expect(plain[1]).toMatch(/^\//);
    expect(plain[1]).not.toMatch(/\bPath\b/);
    expectOrder(plain[1] ?? "", ["Token", "Cost"]);
    expect(plain.join("\n")).not.toContain("Backend");
    expect(plain[1]).toContain("Cost …");
    expect(plain[1]).not.toContain("Cost ?");
  });

  it("retains localized ANSI colors for every label and value", () => {
    const status: StatusLineInput = {
      cwd: "/workspace/vspi",
      usage: { ...DEFAULT_USAGE, contextTokens: 50_000, contextWindow: 128_000, contextPercent: 39 },
      modelLabel: "OpenAI / GPT-5.4",
      effort: "high",
      busy: false,
    };
    const rendered = renderStatusLines(status, 120, plainTheme({ colorLevel: 3, truecolor: true })).join("\n");

    const plain = stripAnsi(rendered);
    expect(plain).not.toMatch(/\bPath\b/);
    expect(plain.split("\n")[1]).toMatch(/^\/workspace\/vspi/);

    for (const label of ["Model", "Effort", "Speed", "Context", "Token", "Cost"]) {
      expect(isAnsiStyled(rendered, label), `${label} label color`).toBe(true);
    }
    for (const value of ["OpenAI / GPT-5.4", "High", "50K / 128K 39%", "/workspace/vspi", "↑0 ↓0", "¥0.00"]) {
      expect(isAnsiStyled(rendered, value), `${value} value color`).toBe(true);
    }
  });
});
