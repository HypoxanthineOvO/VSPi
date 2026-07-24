import { describe, expect, it } from "vitest";
import { type CommandDefinition, matchCommands } from "../src/domain/commands.js";

describe("canonical command matcher", () => {
  it("binds an alias token to its canonical command while preserving aliases", () => {
    const match = matchCommands("/exit")[0];

    expect(match).toMatchObject({
      canonicalId: "quit",
      canonicalToken: "/quit",
      matchedToken: "/exit",
      matchKind: "alias",
      command: {
        id: "quit",
        label: "/quit",
        aliases: ["exit", "q"],
      },
    });
    expect(match).toHaveProperty("source");
  });

  it("returns canonical provenance and aliases for canonical matching", () => {
    expect(matchCommands("/qui")[0]).toMatchObject({
      canonicalId: "quit",
      canonicalToken: "/quit",
      matchedToken: "/quit",
      matchKind: "canonical",
      command: { aliases: ["exit", "q"] },
    });
  });

  it("preserves extension source when a plugin alias is matched", () => {
    const plugin: CommandDefinition = {
      id: "deploy",
      aliases: ["ship"],
      label: "/deploy",
      description: "Deploy fixture",
      group: "扩展",
      source: "@acme/deploy",
    };

    expect(matchCommands("/sh", [plugin])[0]).toMatchObject({
      canonicalId: "deploy",
      canonicalToken: "/deploy",
      matchedToken: "/ship",
      matchKind: "alias",
      source: "@acme/deploy",
    });
  });
});
