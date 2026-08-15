import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import type { SessionOption } from "../src/domain/types.js";
import { stripAnsi } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

interface InteractionDefinitionContract {
  id: string;
  surface: "panel" | "composer" | "inspect";
  context: string;
  keys: readonly string[];
  matches: (input: string, state?: unknown) => boolean;
  handler: string;
  hint: (state?: unknown) => string | undefined;
}

interface InteractionRegistryContract {
  schemaVersion: "1";
  actions: readonly InteractionDefinitionContract[];
}

function panelText(panel: PanelController): string {
  return panel.render(80, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
}

function hintText(panel: PanelController): string {
  return stripAnsi(panel.renderHint(80, plainTheme())).trim();
}

describe("M1 state-aware interaction hints", () => {
  it("does not advertise selection or collapse actions for an empty Plan", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const before = panelText(panel);

    expect(before).toContain("Plan");
    expect(before).not.toMatch(/Workflow|当前计划为空/);
    for (const input of ["\u001b[A", "\u001b[B", "\u001b[D", "\u001b[C", "\r"]) {
      expect(panel.handleInput(input)).toBeUndefined();
    }
    expect(panelText(panel)).toBe(before);
    expect(hintText(panel)).not.toMatch(/▴▾|◂⟶|选择|折叠|展开|Enter/);
  });

  it("does not advertise open or Fork actions while Sessions is empty", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.open("sessions");
    const before = panelText(panel);

    expect(before).toContain("暂无会话");
    expect(panel.handleInput("\r")).toBeUndefined();
    expect(panel.handleInput("F")).toBeUndefined();
    expect(panelText(panel)).toBe(before);
    expect(hintText(panel)).not.toMatch(/▴▾|选择|Enter|打开|Shift\+F|创建分支|Fork/i);
  });

  it("restores open and Fork hints when Sessions contains an actionable row", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    const session: SessionOption = {
      id: "session-1",
      label: "可恢复会话",
      relativeTime: "刚刚",
      branchDepth: 0,
    };
    panel.setSessions([session]);
    panel.open("sessions");

    expect(hintText(panel)).toContain("Enter 打开");
    expect(hintText(panel)).toMatch(/Shift\+F.*(?:分支|Fork)/i);
    expect(panel.handleInput("\r")).toEqual({ type: "session", session });
  });

  it("advertises and dispatches the enabled /plan workspace action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/plan");
    const rendered = panelText(panel);
    const hint = hintText(panel);
    const event = panel.handleInput("\r");

    expect(rendered).not.toMatch(/暂未|未接入|不可用|后续|M4/i);
    expect(hint).toContain("Enter 执行");
    expect(event).toMatchObject({ type: "command", command: { id: "plan" } });
  });

  it("advertises and dispatches the enabled /prompt panel action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/prompt");

    expect(panelText(panel)).not.toMatch(/暂未|未接入|不可用|后续|M4/i);
    expect(hintText(panel)).toContain("Enter 执行");
    expect(panel.handleInput("\r")).toMatchObject({
      type: "command",
      command: { id: "prompt" },
    });
  });

  it("advertises and dispatches the enabled /policy panel action", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/policy");

    expect(panelText(panel)).not.toMatch(/暂未|未接入|不可用|后续|M4/i);
    expect(hintText(panel)).toContain("Enter 执行");
    expect(panel.handleInput("\r")).toMatchObject({ type: "command", command: { id: "policy" } });
  });

  it("continues to advertise execution for an enabled command", () => {
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setCommandQuery("/providers");

    expect(hintText(panel)).toContain("Enter 执行");
    expect(panel.handleInput("\r")).toMatchObject({ type: "command", command: { id: "providers" } });
  });
});

describe("M1 unified interaction registry", () => {
  it("ties every Panel/Composer/Inspect action id to key matching, dispatch, and hint generation", async () => {
    const modulePath = "../src/ui/interactions.js";
    const interactionModule = (await import(modulePath).catch(() => undefined)) as
      | { INTERACTION_REGISTRY?: InteractionRegistryContract }
      | undefined;
    const registry = interactionModule?.INTERACTION_REGISTRY;

    expect(registry, "src/ui/interactions must export INTERACTION_REGISTRY for audit introspection").toBeDefined();
    if (!registry) return;
    expect(registry.schemaVersion).toBe("1");
    expect(Array.isArray(registry.actions)).toBe(true);
    expect(registry.actions.length).toBeGreaterThan(0);
    expect(new Set(registry.actions.map((action) => action.id)).size).toBe(registry.actions.length);

    for (const action of registry.actions) {
      expect(action.id).toMatch(/\S/);
      expect(["panel", "composer", "inspect"]).toContain(action.surface);
      expect(action.context).toMatch(/\S/);
      expect(action.keys.length).toBeGreaterThan(0);
      expect(action.keys.every((key) => key.length > 0)).toBe(true);
      expect(action.matches).toBeTypeOf("function");
      expect(action.handler).toMatch(/\S/);
      expect(action.hint).toBeTypeOf("function");
    }

    const surfaces = new Set(registry.actions.map((action) => action.surface));
    expect(surfaces).toEqual(new Set(["panel", "composer", "inspect"]));
    const panelContexts = new Set(
      registry.actions.filter((action) => action.surface === "panel").map((action) => action.context),
    );
    for (const context of ["plan", "sessions", "commands"]) expect(panelContexts).toContain(context);

    const unknownCsi = "\u001b[99~";
    for (const [surface, context, state] of [
      ["panel", "approval", { approvalReasonEditing: true }],
      ["panel", "question", { questionMode: "freeText" }],
      ["composer", "main", { composerEmpty: true }],
    ] as const) {
      const ownsUnknown = registry.actions
        .filter((action) => action.surface === surface && action.context === context)
        .some((action) => action.matches(unknownCsi, state));
      expect(ownsUnknown, `${surface}/${context} must not swallow unknown CSI input`).toBe(false);
    }
    expect(
      registry.actions
        .filter((action) => action.surface === "panel" && action.context === "question")
        .some((action) => action.matches("回答", { questionMode: "freeText" })),
    ).toBe(true);
  });
});
