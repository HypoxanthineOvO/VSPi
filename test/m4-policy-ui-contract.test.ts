import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { PolicySnapshot } from "../src/policy/execution-policy.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

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

  it("renders all approval levels as Host and makes Auto the no-prompt level", () => {
    const panel = new PanelController(DEFAULT_SETTINGS) as unknown as PolicyPanel;
    expect(panel.setPolicySnapshot, "Policy panel requires a runtime snapshot input").toBeTypeOf("function");
    if (typeof panel.setPolicySnapshot !== "function") return;
    panel.setPolicySnapshot({
      policy: "Standard",
      boundary: "Host",
      sandboxed: false,
      recovery: false,
      sessionAllowlist: [],
    });
    panel.open("policy");
    const initial = panel.render(80, 16, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(initial).toMatch(/Safe[\s\S]*Standard[\s\S]*YOLO[\s\S]*Auto/);
    expect(initial).not.toContain("Sandboxed");
    expect(initial.match(/Host/g)?.length).toBeGreaterThanOrEqual(4);
    expect(stripAnsi(panel.renderHint(80, plainTheme()))).toMatch(/Enter.*(?:切换|选择)/i);

    for (let index = 0; index < 2; index += 1) panel.handleInput("\u001b[B");
    expect(panel.handleInput("\r")).toMatchObject({
      type: "policyChange",
      policy: "Auto",
      requiresAcknowledgement: false,
    });
  });
});
