import headlessXterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import {
  formatInspectorRow,
  inferPhase,
  parseMockArguments,
  serializeStyledBufferLine,
} from "../scripts/terminal-mock.js";

const { Terminal } = headlessXterm;

describe("terminal mock inspector shell", () => {
  it("keeps the child dimensions independent from the four-column row gutter", () => {
    expect(parseMockArguments(["--rows", "40", "--cols", "80"])).toEqual({
      rows: 40,
      columns: 80,
      trace: false,
      columnRuler: false,
      theme: "Terminal",
    });
    expect(parseMockArguments(["--theme", "light"]).theme).toBe("VSPi Light");
    expect(parseMockArguments(["--theme", "dark"]).theme).toBe("VSPi Dark");
    expect(() => parseMockArguments(["--theme", "paper"])).toThrow("--theme must be terminal, dark, or light");
    expect(formatInspectorRow(7, false, "content")).toBe("07 │content");
    expect(formatInspectorRow(7, true, "content")).toBe("07*│content");
  });

  it("labels interaction phases from child content rather than the workspace path", () => {
    expect(inferPhase(["╭ Sessions ─╮"])).toBe("resume-picker");
    expect(inferPhase(["MOCK_RESUME_072_END"])).toBe("resume-restored");
    expect(inferPhase(["Trace Question"])).toBe("question");
    expect(inferPhase(["● Working 00:01"])).toBe("working");
    expect(inferPhase(["◈ VSPi", "Mock Deterministic"])).toBe("startup");
    expect(inferPhase(["/home/heyx/VSPi", "Mock Deterministic"])).toBe("idle");
  });

  it("serializes cell colors and text attributes for historical inspector Frames", async () => {
    const terminal = new Terminal({ allowProposedApi: true, cols: 12, rows: 2 });
    await new Promise<void>((resolve) => {
      terminal.write("\u001b[1;2;3;4;7;9;38;2;95;199;199;48;5;25mX\u001b[0m", resolve);
    });
    const rendered = serializeStyledBufferLine(terminal.buffer.active.getLine(0), terminal.cols);

    expect(rendered).toContain("1;2;3;4;7;9");
    expect(rendered).toContain("38;2;95;199;199");
    expect(rendered).toContain("48;5;25");
    expect(rendered).toContain("X");
    expect(rendered.endsWith("\u001b[0m")).toBe(true);
    terminal.dispose();
  });
});
