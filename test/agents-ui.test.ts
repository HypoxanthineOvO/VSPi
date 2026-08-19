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
      limits: {
        maxDepth: 3,
        maxAgentsPerTree: 12,
        maxConcurrency: 16,
        maxRunTokens: 120_000,
        maxTreeTokens: 500_000,
        maxTreeCostUsd: 20,
        maxRunSeconds: 900,
      },
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
          lanes: [
            {
              lane: "main",
              state: "blocked",
              owner: "build-host:42",
              updatedAt: "2026-07-31T00:00:00.000Z",
            },
          ],
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
          provider: "openai",
          role: "analyst",
          modelReason: "automatic openai pool · analyst",
          effort: "high",
          contextMode: "inherited",
          contextChars: 1_024,
          task: "Audit implementation",
          tools: ["read"],
          usage: { input: 2_000, output: 500, cacheRead: 100, cacheWrite: 0, cost: 0.2, turns: 1 },
          budget: {
            runTokensUsed: 2_600,
            maxRunTokens: 120_000,
            treeTokensUsed: 5_000,
            maxTreeTokens: 500_000,
            treeCostUsd: 0.4,
            maxTreeCostUsd: 20,
            maxRunSeconds: 900,
            warnRunTokens: false,
            warnTreeTokens: false,
            warnTreeCost: false,
            warnElapsed: false,
          },
          timeline: [
            { at: "2026-07-31T00:00:00.000Z", kind: "queued", summary: "Run queued" },
            { at: "2026-07-31T00:00:01.000Z", kind: "completed", summary: "Run completed" },
          ],
          status: "success",
        },
      ],
      authority: {
        pendingRequired: ["frontend"],
        turnOverrides: [],
        sessionOverrides: ["ops"],
        taskEpoch: 7,
      },
    });
    panel.open("agents");
    const text = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    // C19 P0-3：Teammate Ban 后 map 视图不再渲染 teammate 区块与 authority 行。
    expect(text).not.toContain("frontend · Frontend");
    expect(text).not.toContain("main:blocked");
    expect(text).not.toContain("Authority");
    expect(text).toContain("depth 3");
    expect(text).toContain("analyst · gpt-5 · success · Audit implementation");
    for (const width of [40, 80, 120]) {
      const map = panel.render(width, 40, plainTheme(), DEFAULT_USAGE);
      expect(map.every((line) => visibleWidth(line) <= width)).toBe(true);
      const mapText = map.map(stripAnsi).join("\n");
      expect(mapText).not.toContain("current openai/gpt-5");
    }
    panel.handleInput(Key.enter);
    const timeline = panel.render(100, 20, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(timeline).toContain("Agents · Timeline");
    expect(timeline).toContain("automatic openai pool · analyst · context inherited/1024 chars");
    expect(timeline).toContain("run 2.6K / 120K");
    expect(timeline).toContain("tree 5.0K / 500K");
    expect(timeline).toContain("completed · Run completed");
    expect(timeline).toContain("Run output preview");
    expect(timeline).not.toContain("Transcript");
    for (const width of [40, 80, 120]) {
      const rendered = panel.render(width, 40, plainTheme(), DEFAULT_USAGE);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      const renderedText = rendered.map(stripAnsi).join("\n");
      expect(renderedText).toContain("Timeline");
      expect(renderedText).toContain("context inherited/1024 chars");
      expect(renderedText).toContain("run 2.6K / 120K");
    }
    panel.handleInput(Key.tab);
    const tools = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(tools).toContain("Agents · Tools");
    expect(tools).toContain("read");
    for (const width of [40, 80, 120]) {
      expect(panel.render(width, 40, plainTheme(), DEFAULT_USAGE).every((line) => visibleWidth(line) <= width)).toBe(
        true,
      );
    }
    panel.handleInput(Key.tab);
    const pools = panel.render(100, 14, plainTheme(), DEFAULT_USAGE).map(stripAnsi).join("\n");
    expect(pools).toContain("Agents · Pools");
    expect(pools).toContain("openai · automatic");
    for (const width of [40, 80, 120]) {
      expect(panel.render(width, 40, plainTheme(), DEFAULT_USAGE).every((line) => visibleWidth(line) <= width)).toBe(
        true,
      );
    }
  });
});
