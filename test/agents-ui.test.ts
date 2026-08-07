import { Key } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getActionDefinition } from "../src/domain/commands.js";
import { DEFAULT_SETTINGS, DEFAULT_USAGE } from "../src/domain/fixtures.js";
import { stripAnsi, visibleWidth } from "../src/ui/ansi.js";
import { PanelController } from "../src/ui/panels.js";
import { plainTheme } from "./helpers.js";

describe("Agents UI", () => {
  it("registers /agents and renders current/preferred model, lane, and sticky fallback state", () => {
    expect(getActionDefinition("agents")?.handler).toBe("agents");
    const panel = new PanelController(DEFAULT_SETTINGS);
    panel.setAgentSnapshot({
      enabled: true,
      projectTrusted: true,
      recovery: false,
      limits: { maxDepth: 5, maxAgentsPerTree: 128, maxConcurrency: 16 },
      pools: [
        {
          provider: "openai",
          source: "automatic",
          roles: {
            orchestrator: "openai/gpt-5",
            researcher: "openai/gpt-5",
            analyst: "openai/gpt-5",
            worker: "openai/gpt-5",
          },
        },
      ],
      active: [],
      teammates: [
        {
          id: "frontend",
          role: "Frontend",
          description: "UI owner",
          routing: "required",
          match: ["frontend"],
          systemPrompt: "role",
          tools: ["read", "edit"],
          preferredModel: "kimi/k2",
          currentModel: "openai/gpt-5",
          effort: "high",
          fallbackModels: ["openai/gpt-5"],
          fallback: { from: "kimi/k2", reason: "quota_exhausted", at: "2026-07-31T00:00:00.000Z" },
          activeLanes: ["main"],
          stickyFallback: true,
        },
      ],
      recent: [
        {
          id: "run-1",
          treeId: "tree-1",
          kind: "task",
          depth: 1,
          model: "openai/gpt-5",
          role: "analyst",
          modelReason: "automatic openai pool · analyst",
          effort: "high",
          contextMode: "inherited",
          task: "Audit implementation",
          tools: ["read"],
          status: "success",
        },
      ],
    });
    panel.open("agents");
    const text = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(text).toContain("frontend · Frontend");
    expect(text).toContain("required · current openai/gpt-5 · preferred kimi/k2 · high · lanes main · sticky fallback");
    expect(text).toContain("depth 5 · tree 128 · concurrency 16");
    expect(text).toContain("analyst · gpt-5 · success · Audit implementation");
    panel.handleInput(Key.enter);
    const transcript = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(transcript).toContain("Agents · Transcript");
    expect(transcript).toContain("automatic openai pool · analyst");
    expect(transcript).toContain("Audit implementation");
    panel.handleInput(Key.tab);
    const tools = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(tools).toContain("Agents · Tools");
    expect(tools).toContain("read");
    panel.handleInput(Key.tab);
    const pools = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(pools).toContain("Agents · Pools");
    expect(pools).toContain("openai · automatic");
    for (const width of [40, 80, 120]) {
      expect(panel.render(width, 14, plainTheme(), DEFAULT_USAGE).every((line) => visibleWidth(line) <= width)).toBe(
        true,
      );
    }
  });
});
