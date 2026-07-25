import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { renderSplash, runStartupSequence, type StartupStatus } from "../src/ui/splash.js";
import { plainTheme } from "./helpers.js";

const VERSION = "9.8.7-test";
const LEGACY_COPY = ["Home · auto/safe · Web", "Kimi / OpenAI / DeepSeek"] as const;

function renderedText(lines: string[]): string {
  return lines.map(stripAnsi).join("\n");
}

function expectTruthfulStatus(lines: string[], status: StartupStatus): void {
  const text = renderedText(lines);
  expect(text).toContain(status.model);
  expect(text).toContain(`Backend ${status.backend}`);
  expect(text).toContain(`Policy ${status.policy} · ${status.boundary}`);
  expect(text).not.toMatch(/\bMode\b|\bAuto\b/);
  for (const legacy of LEGACY_COPY) expect(text).not.toContain(legacy);
}

describe("startup cover", () => {
  it.each([
    [
      "real pi",
      { model: "OpenAI / GPT-5.4", backend: "Pi", policy: "Standard", boundary: "Sandboxed", version: VERSION },
    ],
    [
      "explicit fixture",
      {
        model: "Offline Fixture",
        backend: "Fixture",
        policy: "Standard",
        boundary: "Sandboxed",
        version: VERSION,
      },
    ],
    ["host policy", { model: "OpenAI / GPT-5.4", backend: "Pi", policy: "YOLO", boundary: "Host", version: VERSION }],
  ] as const)("renders the resolved model, backend, policy, boundary, and version for %s", (_scenario, status) => {
    const lines = renderSplash(80, plainTheme(), 1, status);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expectTruthfulStatus(lines, status);
    expect(renderedText(lines)).toContain(status.version);
    expect(renderedText(lines)).not.toContain("v0.2.0");
  });

  it.each([
    [40, false],
    [40, true],
    [80, false],
    [80, true],
    [120, false],
    [120, true],
  ] as const)("keeps the truthful final cover width-safe at %i columns (ASCII: %s)", (width, ascii) => {
    const status: StartupStatus = {
      model: "OpenAI / GPT-5.4",
      backend: "Pi",
      policy: "Standard",
      boundary: "Sandboxed",
      version: VERSION,
    };
    const lines = renderSplash(width, plainTheme({ unicode: !ascii }), 1, status);

    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    expectTruthfulStatus(lines, status);
    expect(renderedText(lines)).toContain(status.version);
    if (ascii) expect(stripAnsi(lines[0] ?? "").startsWith("+")).toBe(true);
  });

  it("uses a brand-only initialization frame instead of presenting invented runtime state", () => {
    const text = renderedText(renderSplash(80, plainTheme({ reducedMotion: false }), 0));

    expect(text).toContain("VSPi");
    expect(text).not.toMatch(/\bSafe\b/);
    for (const legacy of LEGACY_COPY) expect(text).not.toContain(legacy);
  });

  it("re-renders animation and final frames at the current width after a resize", async () => {
    let currentWidth = 80;
    const writes: string[] = [];
    const status: StartupStatus = {
      model: "OpenAI / GPT-5.4",
      backend: "Pi",
      policy: "Standard",
      boundary: "Sandboxed",
      version: VERSION,
    };

    await runStartupSequence({
      width: 80,
      getWidth: () => currentWidth,
      theme: plainTheme({ reducedMotion: false }),
      write: (chunk) => {
        writes.push(chunk);
        currentWidth = 100;
      },
      startApp: () => status,
      startTui: () => {},
    });

    expect(writes.length).toBeGreaterThan(2);
    const firstFrameLines = (writes[0] ?? "").split("\n");
    expect(firstFrameLines.every((line) => visibleWidth(line) === 80)).toBe(true);
    const finalFrameLines = (writes.at(-1) ?? "")
      .replace(/\r/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离启动帧里的 CSI 光标移动序列。
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(finalFrameLines.length).toBeGreaterThan(0);
    expect(finalFrameLines.every((line) => visibleWidth(line) === 100)).toBe(true);
  });
});
