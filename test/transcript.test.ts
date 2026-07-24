import { describe, expect, it } from "vitest";
import type { Attachment, TranscriptMessage } from "../src/domain/types.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PALETTE } from "../src/ui/theme.js";
import { renderTranscript, renderTranscriptMessage } from "../src/ui/transcript.js";
import { cellsForText, plainTheme, sgrCells } from "./helpers.js";

const ATTACHMENT: Attachment = {
  id: "shot",
  alias: "登录页-修改前",
  mimeType: "image/png",
  width: 1440,
  height: 900,
  size: 42,
  path: "/tmp/shot.png",
  status: "ready",
};

function userMessage(text: string, attachments?: Attachment[]): TranscriptMessage {
  return { id: "u", role: "user", kind: "text", text, ...(attachments ? { attachments } : {}) };
}

function expectUserFrame(lines: string[], width: number, unicode: boolean): void {
  const plain = lines.map(stripAnsi);
  const [tl, tr, bl, br, horizontal, vertical] = unicode
    ? ["╭", "╮", "╰", "╯", "─", "│"]
    : ["+", "+", "+", "+", "-", "|"];

  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  expect(plain[0]).toBe(`${tl}${horizontal.repeat(width - 2)}${tr}`);
  expect(plain.at(-1)).toBe(`${bl}${horizontal.repeat(width - 2)}${br}`);
  for (const line of plain.slice(1, -1)) {
    expect(line.startsWith(vertical)).toBe(true);
    expect(line.endsWith(vertical)).toBe(true);
  }
}

describe("transcript rendering", () => {
  it("renders a truecolor user message inside the exact light rounded surface", () => {
    const palette = PALETTE as Record<string, string>;
    expect(palette.userBackground).toBe("#B8E6E3");
    expect(palette.userText).toBe("#102426");

    const user = userMessage("hello");
    const lines = renderTranscriptMessage(user, 40, plainTheme({ colorLevel: 3, truecolor: true, unicode: true }));
    const plain = lines.map(stripAnsi);

    expectUserFrame(lines, 40, true);
    expect(plain).toEqual([`╭${"─".repeat(38)}╮`, `│${" hello".padEnd(38)}│`, `╰${"─".repeat(38)}╯`]);
    const content = cellsForText(lines[1] ?? "", "hello");
    expect(content.every((cell) => cell.background === "rgb(184,230,227)")).toBe(true);
    expect(content.every((cell) => cell.foreground === "rgb(16,36,38)")).toBe(true);
    for (const edge of [cellsForText(lines[0] ?? "", "╭"), cellsForText(lines[2] ?? "", "╰")]) {
      expect(edge[0]?.foreground).toBe("rgb(95,199,199)");
      expect(edge[0]?.background).toBeUndefined();
    }
  });

  it.each([
    ["truecolor", 3, true, true],
    ["256 color", 2, false, true],
    ["no color", 0, false, true],
    ["ASCII no color", 0, false, false],
  ] as const)("keeps the full-width user frame exact at 40/80/120 with %s", (_name, colorLevel, truecolor, unicode) => {
    for (const width of [40, 80, 120]) {
      const lines = renderTranscriptMessage(
        userMessage("message surface"),
        width,
        plainTheme({ colorLevel, truecolor, unicode }),
      );
      expectUserFrame(lines, width, unicode);

      const content = cellsForText(lines.join("\n"), "message surface");
      if (colorLevel === 2) {
        expect(content.every((cell) => cell.background === "ansi256(152)")).toBe(true);
        expect(content.every((cell) => cell.foreground === "ansi256(234)")).toBe(true);
      } else if (colorLevel === 0) {
        expect(sgrCells(lines.join("\n")).every((cell) => cell.background === undefined)).toBe(true);
      }
    }
  });

  it.each([40, 80, 120] as const)(
    "wraps hard lines and long words inside an exact %s-column user frame without losing attachments",
    (width) => {
      const text = `first hard line\nsecond hard line ${"longword".repeat(24)}`;
      const lines = renderTranscriptMessage(
        userMessage(text, [ATTACHMENT]),
        width,
        plainTheme({ colorLevel: 3, truecolor: true }),
      );
      const plain = lines.map(stripAnsi);
      const firstLine = plain.findIndex((line) => line.includes("first hard line"));
      const secondLine = plain.findIndex((line) => line.includes("second hard line"));

      expectUserFrame(lines, width, true);
      expect(firstLine).toBeGreaterThan(0);
      expect(secondLine).toBeGreaterThan(firstLine);
      expect(plain.slice(1, -1).join("").replaceAll(/\s|│/g, "")).toContain("〔登录页-修改前·1440×900·PNG〕");
      expect(plain.slice(1, -1).length).toBeGreaterThan(2);
    },
  );

  it("preserves the complete user block and attachment content when Inspect selects it", () => {
    const message = userMessage("inspect this", [ATTACHMENT]);
    const theme = plainTheme({ colorLevel: 3, truecolor: true });
    const normal = renderTranscriptMessage(message, 80, theme);
    const inspected = renderTranscriptMessage(message, 80, theme, { inspectedId: message.id });

    expectUserFrame(inspected, 80, true);
    expect(inspected.map(stripAnsi)).toEqual(normal.map(stripAnsi));
    expect(stripAnsi(inspected.join("\n"))).toContain("inspect this");
    expect(stripAnsi(inspected.join("\n"))).toContain("〔登录页-修改前 · 1440×900 · PNG〕");
    expect(inspected.join("\n")).toContain("\u001b[48;2;43;62;65m");
  });

  it("keeps adjacent assistant Markdown outside the user frame with one transcript spacer", () => {
    const user = userMessage("question");
    const assistant: TranscriptMessage = { id: "a", role: "assistant", kind: "text", text: "## Answer" };
    const theme = plainTheme();
    const userLines = renderTranscriptMessage(user, 60, theme);
    const assistantLines = renderTranscriptMessage(assistant, 60, theme);
    const transcript = renderTranscript([user, assistant], 60, theme);

    expect(transcript.slice(0, userLines.length)).toEqual(userLines);
    expect(transcript[userLines.length]).toBe("");
    expect(transcript.slice(userLines.length + 1)).toEqual(assistantLines);
    expect(stripAnsi(assistantLines.join("\n"))).toContain("◆ Answer");
    expect(stripAnsi(assistantLines.join("\n"))).not.toMatch(/[╭╮╰╯]/);
  });

  it("uses visual roles without printing participant names", () => {
    const user: TranscriptMessage = { id: "u", role: "user", kind: "text", text: "你好" };
    const assistant: TranscriptMessage = { id: "a", role: "assistant", kind: "text", text: "## 回应" };
    const userText = renderTranscriptMessage(user, 40, plainTheme()).map(stripAnsi).join("\n");
    const assistantText = renderTranscriptMessage(assistant, 40, plainTheme()).map(stripAnsi).join("\n");
    expect(userText).not.toContain("User");
    expect(assistantText).not.toContain("VSPi");
    expect(assistantText).toContain("◆");
  });

  it("renders expanded edit tools as width-safe diffs", () => {
    const tool: TranscriptMessage = {
      id: "edit",
      role: "assistant",
      kind: "tool",
      name: "edit",
      summary: "+1 -1",
      status: "success",
      output: "@@ -4,1 +4,1 @@\n-old\n+new",
      expanded: true,
    };
    const lines = renderTranscriptMessage(tool, 42, plainTheme());
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
    expect(lines.map(stripAnsi).join("\n")).toContain("new");
  });

  it("shows only model, effort, task and status for Sub Agent entries", () => {
    const subagent: TranscriptMessage = {
      id: "sub",
      role: "assistant",
      kind: "subagent",
      model: "GPT-5.4",
      effort: "高",
      task: "审查布局",
      status: "running",
    };
    const text = renderTranscriptMessage(subagent, 60, plainTheme()).map(stripAnsi).join("\n");
    expect(text).toContain("GPT-5.4 · 高 · 审查布局 · running");
    expect(text).not.toContain("thinking");
  });

  it("keeps the streaming cursor visible when the last line fills the full width", () => {
    const message: TranscriptMessage = {
      id: "a",
      role: "assistant",
      kind: "text",
      text: "满".repeat(120),
      streaming: true,
    };
    const lines = renderTranscriptMessage(message, 40, plainTheme());

    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    const last = stripAnsi(lines.at(-1) ?? "");
    expect(last.endsWith("▋")).toBe(true);
    expect(visibleWidth(last)).toBe(40);
  });
});
