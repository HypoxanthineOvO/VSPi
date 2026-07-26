import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/ui/markdown.js";
import { createTheme } from "../src/ui/theme.js";
import { capabilities } from "./helpers.js";

describe("terminal background adaptation", () => {
  it("uses terminal-owned foreground and background in Terminal mode", () => {
    const theme = createTheme(capabilities({ colorLevel: 3, truecolor: true }), "Terminal");
    const rendered = [
      theme.userSurface("user"),
      theme.codeBlock("code"),
      ...renderMarkdown("```bash\necho ok\n```", 40, theme),
    ].join("\n");
    expect(rendered).not.toMatch(/(?:38|48);2;/);
    expect(rendered).not.toContain("\u001b[30m");
    expect(rendered).not.toContain("\u001b[40m");
  });

  it("offers an explicit light palette for terminals with a light background", () => {
    const theme = createTheme(capabilities({ colorLevel: 3, truecolor: true }), "VSPi Light");
    expect(theme.text("text")).toContain("38;2;32;36;40");
    expect(theme.codeBlock("code")).toContain("48;2;238;240;242");
  });
});
