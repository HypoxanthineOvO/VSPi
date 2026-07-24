import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";
import type { PolicySnapshot } from "./m4-contract.js";

interface PolicyPanel {
  setPolicySnapshot(snapshot: PolicySnapshot): void;
  open(kind: "policy"): void;
  render(width: number, maxRows: number, theme: ReturnType<typeof plainTheme>, usage: typeof DEFAULT_USAGE): string[];
  renderHint(width: number, theme: ReturnType<typeof plainTheme>): string;
  handleInput(data: string): unknown;
}

describe("M4 Policy TUI contract", () => {
  it("enables /policy with one production handler instead of a deferred reason", () => {
    const command = ACTION_REGISTRY.find((entry) => entry.id === "policy");
    expect(command).toMatchObject({
      label: "/policy",
      availability: "enabled",
      handler: "policy",
    });
    expect(command?.disabledReason).toBeUndefined();
  });

  it("renders truthful levels/hints and requires an explicit YOLO warning action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS) as unknown as PolicyPanel;
    expect(panel.setPolicySnapshot, "Policy panel requires a runtime snapshot input").toBeTypeOf("function");
    if (typeof panel.setPolicySnapshot !== "function") return;
    panel.setPolicySnapshot({ policy: "Standard", boundary: "Sandboxed", sandboxed: true, recovery: false });
    panel.open("policy");
    const initial = panel.render(80, 16, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(initial).toMatch(/Safe[\s\S]*Standard[\s\S]*Auto[\s\S]*YOLO/);
    expect(initial).toMatch(/Standard[\s\S]{0,80}Sandboxed/);
    expect(initial).toMatch(/YOLO[\s\S]{0,80}Host/);
    expect(stripAnsi(panel.renderHint(80, plainTheme()))).toMatch(/Enter.*(?:切换|选择)/i);

    let warning = "";
    for (let index = 0; index < 4; index += 1) {
      warning = panel.render(80, 16, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
      if (/YOLO[\s\S]{0,160}(?:高风险|不可跳过|明确确认)/i.test(warning)) break;
      panel.handleInput("\u001b[B");
    }
    expect(warning).toMatch(/YOLO[\s\S]{0,160}(?:Host|风险|绕过|sandbox|确认)/i);
    expect(stripAnsi(panel.renderHint(80, plainTheme()))).toMatch(/Enter.*(?:确认|切换).*YOLO|YOLO.*确认/i);
    expect(panel.handleInput("\r")).toMatchObject({
      type: "policyChange",
      policy: "YOLO",
      requiresAcknowledgement: true,
    });
  });
});
