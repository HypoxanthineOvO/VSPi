import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { UsageSnapshot } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { formatContextTokens, renderStatusLines, type StatusLineInput } from "../src/ui/status.js";
import { plainTheme } from "./helpers.js";

const ACTIVE_USAGE: UsageSnapshot = {
  ...DEFAULT_USAGE,
  contextTokens: 50_176,
  contextWindow: 128_000,
  contextPercent: 39,
  inputTokens: 42_000,
  outputTokens: 8_100,
  costUsd: 0.414,
};

function statusInput(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    cwd: "/workspace/vspi",
    usage: ACTIVE_USAGE,
    modelLabel: "OpenAI / GPT-5.4",
    effort: "high",
    busy: true,
    mode: "Inspect",
    ...overrides,
  };
}

function render(input: StatusLineInput, width: number): { ansi: string[]; plain: string[] } {
  const ansi = renderStatusLines(input, width, plainTheme());
  expect(ansi.every((line) => visibleWidth(line) === width)).toBe(true);
  return { ansi, plain: ansi.map(stripAnsi) };
}

function visibleColumn(line: string, target: string): number {
  const index = line.indexOf(target);
  return index < 0 ? -1 : visibleWidth(line.slice(0, index));
}

function visibleCellSlice(line: string, start: number, end: number): string {
  let column = 0;
  let output = "";
  for (const character of line) {
    const nextColumn = column + visibleWidth(character);
    if (nextColumn > start && column < end) output += character;
    column = nextColumn;
    if (column >= end) break;
  }
  return output;
}

function expectFixedModelEffortGap(identity: string): void {
  const effort = identity.indexOf("Effort");
  const prefix = identity.slice(0, effort);

  expect(effort).toBeGreaterThan(-1);
  expect(prefix).toMatch(/\S {2}$/);
  expect(prefix).not.toMatch(/\S {3,}$/);
}

describe("Context status presentation", () => {
  it.each([
    [50_176, 128_000, 39, "Context 50K / 128K 39%"],
    [0, 0, 0, "Context 0K / 0K 0%"],
    [null, 128_000, null, "Context ?K / 128K ?%"],
    [500, 9_500, 7, "Context 0.5K / 9.5K 7%"],
    [1_500, 10_600, 13, "Context 1.5K / 11K 13%"],
    [10_600, 128_000, 8, "Context 11K / 128K 8%"],
  ] as const)(
    "formats %s / %s with decimal uppercase K and snapshot percent",
    (contextTokens, contextWindow, contextPercent, expected) => {
      const usage: UsageSnapshot = {
        ...ACTIVE_USAGE,
        contextTokens,
        contextWindow,
        contextPercent,
      };
      const { plain } = render(statusInput({ usage, busy: false }), 120);

      expect(plain.join("\n")).toContain(expected);
    },
  );

  it("uses the snapshot percentage instead of recomputing it from rounded K values", () => {
    const usage: UsageSnapshot = { ...ACTIVE_USAGE, contextPercent: 73 };
    const { plain } = render(statusInput({ usage, busy: false }), 120);

    expect(plain.join("\n")).toContain("Context 50K / 128K 73%");
  });
});

describe("responsive status anchoring", () => {
  it("keeps Model and Effort close while right-anchoring Context/Token/Cost at 80 columns", () => {
    const { plain } = render(statusInput(), 80);
    const identity = plain[0] ?? "";
    const telemetry = plain[1] ?? "";

    expect(visibleColumn(identity, "Model")).toBe(0);
    expect(visibleColumn(identity, "Effort")).toBe(visibleWidth("Model OpenAI / GPT-5.4  "));
    expectFixedModelEffortGap(identity);
    expect(visibleColumn(identity, "Context")).toBe(56);
    expect(telemetry).toMatch(/^\/workspace\/vspi/);
    expect(telemetry).not.toMatch(/\bPath\b/);
    expect(visibleColumn(telemetry, "Token")).toBe(52);
    expect(visibleColumn(telemetry, "Cost")).toBe(70);
    expect(identity).toContain("Context 50K / 128K 39%");
  });

  it("holds the 80-column right tracks while Model/Effort use a fixed small gap", () => {
    const contexts: Array<[name: string, usage: UsageSnapshot, text: string]> = [
      ["active", ACTIVE_USAGE, "Context 50K / 128K 39%"],
      ["zero", { ...ACTIVE_USAGE, contextTokens: 0, contextWindow: 0, contextPercent: 0 }, "Context 0K / 0K 0%"],
      [
        "unknown",
        { ...ACTIVE_USAGE, contextTokens: null, contextWindow: 128_000, contextPercent: null },
        "Context ?K / 128K ?%",
      ],
      [
        "compacted",
        {
          ...ACTIVE_USAGE,
          contextTokens: null,
          contextWindow: 128_000,
          contextPercent: null,
          inputTokens: 42_000,
          outputTokens: 8_100,
        },
        "Context ?K / 128K ?%",
      ],
    ];
    const identities = [
      { cwd: "/v", modelLabel: "Pi / Short" },
      {
        cwd: "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi",
        modelLabel: "A Provider With A Long Name / A Model With An Even Longer Identity",
      },
    ];

    for (const [name, usage, contextText] of contexts) {
      for (const identity of identities) {
        const { plain } = render(statusInput({ ...identity, usage }), 80);
        expectFixedModelEffortGap(plain[0] ?? "");
        if (identity.modelLabel === "Pi / Short") {
          expect(visibleColumn(plain[0] ?? "", "Effort"), `${name}: short Effort`).toBe(
            visibleWidth("Model Pi / Short  "),
          );
        } else {
          expect(plain[0]?.slice(0, plain[0].indexOf("Effort")), `${name}: long Model truncation`).toMatch(/… {2}$/);
        }
        expect(visibleColumn(plain[0] ?? "", "Context"), `${name}: Context`).toBe(56);
        expect(plain[1], `${name}: unlabeled cwd`).toMatch(/^\//);
        expect(plain[1], `${name}: no Path label`).not.toMatch(/\bPath\b/);
        expect(visibleColumn(plain[1] ?? "", "Token"), `${name}: Token`).toBe(52);
        expect(visibleColumn(plain[1] ?? "", "Cost"), `${name}: Cost`).toBe(70);
        expect(plain[0], name).toContain(contextText);
      }
    }
  });

  it("preserves 120-column right tracks with adjacent Model/Effort and an unlabeled cwd", () => {
    for (const overrides of [
      {},
      {
        cwd: "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi",
        modelLabel: "A Provider With A Long Name / A Model With An Even Longer Identity",
      },
    ]) {
      const { plain } = render(statusInput(overrides), 120);
      expect(plain).toHaveLength(2);
      expect(visibleColumn(plain[0] ?? "", "Model")).toBe(0);
      expectFixedModelEffortGap(plain[0] ?? "");
      if (overrides.modelLabel) {
        expect(plain[0]?.slice(0, plain[0].indexOf("Effort"))).toMatch(/… {2}$/);
      } else {
        expect(visibleColumn(plain[0] ?? "", "Effort")).toBe(visibleWidth("Model OpenAI / GPT-5.4  "));
      }
      expect(visibleColumn(plain[0] ?? "", "Context")).toBe(96);
      expect(plain[1]).toMatch(/^\//);
      expect(plain[1]).not.toMatch(/\bPath\b/);
      expect(visibleColumn(plain[1] ?? "", "Token")).toBe(92);
      expect(visibleColumn(plain[1] ?? "", "Cost")).toBe(110);
      expect(plain[0]).toContain("Context 50K / 128K 39%");
    }
  });

  it("bounds extreme and non-finite telemetry inside the fixed 80/120-column slots", () => {
    const tracks = {
      80: { context: 56, token: 52, cost: 70, end: 80 },
      120: { context: 96, token: 92, cost: 110, end: 120 },
    } as const;
    const finiteUsage: UsageSnapshot = {
      ...ACTIVE_USAGE,
      contextTokens: 9.99e307,
      contextWindow: 9.99e307,
      inputTokens: 9.99e307,
      outputTokens: 9.99e307,
      costUsd: 9.99e307,
      fxRate: 9.99e307,
    };

    for (const width of [80, 120] as const) {
      const track = tracks[width];
      const lines = render(statusInput({ usage: finiteUsage }), width).plain;
      const identity = lines[0] ?? "";
      const telemetry = lines[1] ?? "";
      const contextSlot = visibleCellSlice(identity, track.context, track.end).trimEnd();
      const tokenSlot = visibleCellSlice(telemetry, track.token, track.cost).trimEnd();
      const costSlot = visibleCellSlice(telemetry, track.cost, track.end).trimEnd();

      expect(visibleColumn(identity, "Context"), `${width}: finite Context anchor`).toBe(track.context);
      expect(visibleColumn(telemetry, "Token"), `${width}: finite Token anchor`).toBe(track.token);
      expect(visibleColumn(telemetry, "Cost"), `${width}: finite Cost anchor`).toBe(track.cost);
      expect(lines.join("\n")).not.toMatch(/Infinity|NaN|Infi/);
      expect(contextSlot, `${width}: finite Context truncation`).toMatch(/^Context .*…$/);
      expect(tokenSlot, `${width}: finite Token truncation`).toMatch(/^Token .*…$/);
      expect(costSlot, `${width}: finite overflow cost fallback`).toMatch(/^Cost\s+.*\?$/);

      let referenceSlots: string[] | undefined;
      for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NaN]) {
        const usage: UsageSnapshot = {
          ...ACTIVE_USAGE,
          contextTokens: nonFinite,
          contextWindow: nonFinite,
          inputTokens: nonFinite,
          outputTokens: nonFinite,
          costUsd: nonFinite,
          fxRate: nonFinite,
        };
        const nonFiniteLines = render(statusInput({ usage }), width).plain;
        const nonFiniteIdentity = nonFiniteLines[0] ?? "";
        const nonFiniteTelemetry = nonFiniteLines[1] ?? "";
        const slots = [
          visibleCellSlice(nonFiniteIdentity, track.context, track.end).trimEnd(),
          visibleCellSlice(nonFiniteTelemetry, track.token, track.cost).trimEnd(),
          visibleCellSlice(nonFiniteTelemetry, track.cost, track.end).trimEnd(),
        ];

        expect(visibleColumn(nonFiniteIdentity, "Context"), `${width}: non-finite Context anchor`).toBe(track.context);
        expect(visibleColumn(nonFiniteTelemetry, "Token"), `${width}: non-finite Token anchor`).toBe(track.token);
        expect(visibleColumn(nonFiniteTelemetry, "Cost"), `${width}: non-finite Cost anchor`).toBe(track.cost);
        expect(nonFiniteLines.join("\n")).not.toMatch(/Infinity|NaN|Infi/);
        expect(slots[0]?.match(/\?/g), `${width}: Context fallbacks`).toHaveLength(2);
        expect(slots[1]?.match(/\?/g), `${width}: Token fallbacks`).toHaveLength(2);
        expect(slots[2], `${width}: cost fallback`).toContain("?");
        if (referenceSlots) expect(slots, `${width}: stable non-finite fallback`).toEqual(referenceSlots);
        referenceSlots = slots;
      }
    }
  });

  it("keeps Backend out while retaining Policy in the dynamic Path track", () => {
    for (const backend of ["Pi", "Fixture"] as const) {
      const { plain } = render(statusInput({ backend, policy: "Standard", boundary: "Sandboxed" }), 120);
      const identity = plain[0] ?? "";
      const telemetry = plain[1] ?? "";

      expect(identity).not.toContain(`Backend ${backend}`);
      expect(identity).not.toContain("Policy Standard · Sandboxed");
      expect(telemetry).toContain("Policy Standard · Sandboxed");
      expect(telemetry).not.toContain(`Backend ${backend}`);
      expect(visibleColumn(identity, "Effort")).toBe(visibleWidth("Model OpenAI / GPT-5.4  "));
      expectFixedModelEffortGap(identity);
      expect(visibleColumn(identity, "Context")).toBe(96);
      expect(telemetry).toMatch(/^\/workspace\/vspi/);
      expect(telemetry).not.toMatch(/\bPath\b/);
      expect(visibleColumn(telemetry, "Token")).toBe(92);
      expect(visibleColumn(telemetry, "Cost")).toBe(110);
      expect(identity).not.toMatch(/\bMode\b|\bAuto\b/);
    }
  });

  it("uses exactly two right-anchored lines at 80 columns", () => {
    const { plain } = render(statusInput(), 80);

    expect(plain).toHaveLength(2);
    expect(plain[0]).toMatch(/^Model\s/);
    expect(plain[0]?.trimEnd()).toMatch(/Context\s+50K \/ 128K 39%$/);
    expect(plain[1]).toMatch(/^\/workspace\/vspi/);
    expect(plain[1]).not.toMatch(/\bPath\b/);
    expect(plain[1]?.trimEnd()).toMatch(/Cost\s+¥2\.97$/);
    expect(plain[0]?.indexOf("Effort")).toBeLessThan(plain[0]?.indexOf("Context") ?? -1);
    expect(plain[1]?.indexOf("Token")).toBeLessThan(plain[1]?.indexOf("Cost") ?? -1);
  });

  it("truncates long path and model values without moving either right group", () => {
    const short = render(statusInput(), 80).plain;
    const long = render(
      statusInput({
        cwd: "/workspace/a-very-long-project/directory/with/deeply/nested/packages/vspi",
        modelLabel: "A Provider With A Long Name / A Model With An Even Longer Identity",
      }),
      80,
    ).plain;

    expect(long[0]?.indexOf("Effort")).toBeGreaterThan(short[0]?.indexOf("Effort") ?? -1);
    expectFixedModelEffortGap(short[0] ?? "");
    expectFixedModelEffortGap(long[0] ?? "");
    expect(long[0]?.indexOf("Context")).toBe(short[0]?.indexOf("Context"));
    expect(long[1]?.indexOf("Token")).toBe(short[1]?.indexOf("Token"));
    expect(long[1]?.indexOf("Cost")).toBe(short[1]?.indexOf("Cost"));
    expect(long[0]?.slice(0, long[0]?.indexOf("Effort"))).toContain("…");
    expect(long[1]?.slice(0, long[1]?.indexOf("Token"))).toContain("…");
    expect(long.join("\n")).toContain("Context 50K / 128K 39%");
  });

  it("keeps the two ordered tracks at 40 columns", () => {
    const { plain } = render(statusInput(), 40);

    expect(plain).toHaveLength(2);
    expect(visibleColumn(plain[0] ?? "", "Model")).toBe(0);
    expect(plain[0]?.indexOf("Model")).toBeLessThan(plain[0]?.indexOf("Effort") ?? -1);
    expect(plain[0]?.indexOf("Effort")).toBeLessThan(plain[0]?.indexOf("Context") ?? -1);
    expect(visibleColumn(plain[0] ?? "", "Context")).toBe(25);
    expect(plain[1]).toMatch(/^\//);
    expect(plain[1]).not.toMatch(/\bPath\b/);
    expect(visibleColumn(plain[1] ?? "", "Token")).toBe(20);
    expect(visibleColumn(plain[1] ?? "", "Cost")).toBe(32);
  });

  it("uses exactly two ordered 120-column lines", () => {
    const { plain } = render(statusInput(), 120);

    expect(plain).toHaveLength(2);
    expect(plain[0]).toMatch(/^Model\s/);
    expect(plain[0]?.indexOf("Model")).toBeLessThan(plain[0]?.indexOf("Effort") ?? -1);
    expect(plain[0]?.indexOf("Effort")).toBeLessThan(plain[0]?.indexOf("Context") ?? -1);
    expect(plain[1]).toMatch(/^\/workspace\/vspi/);
    expect(plain[1]).not.toMatch(/\bPath\b/);
    expect(plain[1]?.indexOf("Token")).toBeLessThan(plain[1]?.indexOf("Cost") ?? -1);
  });
});

describe("carry-safe telemetry at rounding boundaries", () => {
  it("never rounds Context/Token/Cost up into a wider digit tier", () => {
    expect(formatContextTokens(999_950)).toBe("999K");
    expect(formatContextTokens(999_500)).toBe("999K");
    expect(formatContextTokens(9_999)).toBe("9.9K");
    expect(formatContextTokens(999_000)).toBe("999K");
    expect(formatContextTokens(1_000_000)).toBe("1000K");
    expect(formatContextTokens(50_176)).toBe("50K");
    expect(formatContextTokens(10_600)).toBe("11K");
  });

  it.each([80, 120] as const)(
    "keeps carried Context/Token/Cost values complete inside the representative tracks at %s columns",
    (width) => {
      const usage: UsageSnapshot = {
        ...ACTIVE_USAGE,
        contextTokens: 999_950,
        contextWindow: 1_000_000,
        contextPercent: 100,
        inputTokens: 999_500,
        outputTokens: 999_500,
        costUsd: 9_999.995,
        fxRate: 1,
      };
      const { ansi, plain } = render(statusInput({ usage }), width);
      const identity = plain[0] ?? "";
      const telemetry = plain[1] ?? "";

      expect(ansi.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(identity).toContain("Context 999K / 1000K 100%");
      expect(telemetry).toContain("Token ↑999k ↓999k");
      expect(telemetry).toContain("Cost ¥9999.99");
      expect(identity.slice(identity.indexOf("Context"))).not.toContain("…");
      expect(telemetry.slice(telemetry.indexOf("Token"))).not.toContain("…");
    },
  );

  it("formats sub-10K token counts without decimal carry", () => {
    const usage: UsageSnapshot = { ...ACTIVE_USAGE, inputTokens: 9_999, outputTokens: 9_999 };
    const telemetry = render(statusInput({ usage }), 80).plain[1] ?? "";
    expect(telemetry).toContain("Token ↑9.9k ↓9.9k");
    expect(telemetry).not.toContain("10.0k");
  });

  it("shows the rounded Cost at 41-59 columns instead of a false ellipsis", () => {
    const usage: UsageSnapshot = { ...ACTIVE_USAGE, costUsd: 10_034, fxRate: 1 };
    const telemetry = render(statusInput({ usage }), 59).plain[1] ?? "";

    expect(telemetry).toContain("Cost ¥10034");
    expect(telemetry).not.toContain("Cost …");
  });

  it("omits the Token field entirely at 40 columns when even the input side cannot fit", () => {
    const usage: UsageSnapshot = { ...ACTIVE_USAGE, inputTokens: 1e21, outputTokens: 0 };
    const telemetry = render(statusInput({ usage }), 40).plain[1] ?? "";

    expect(telemetry).not.toContain("Token");
    expect(telemetry).not.toContain("Token ?");
    expect(telemetry).toContain("Cost");
  });
});
