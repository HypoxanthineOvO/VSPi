import { describe, expect, it } from "vitest";
import { type CommandDefinition, filterCommands, resolveCommand } from "../src/domain/commands.js";

describe("command catalog", () => {
  it("contains the approved v1 command set and resolves aliases", () => {
    const root = filterCommands("").filter((command) => command.group === "VSPi");
    expect(root.map((command) => command.label)).toEqual([
      "/new",
      "/sessions",
      "/compact",
      "/model",
      "/providers",
      "/plan",
      "/prompt",
      "/thinking",
      "/effort",
      "/policy",
      "/usage",
      "/settings",
      "/theme",
      "/quit",
    ]);
    expect(resolveCommand("/resume")?.id).toBe("sessions");
    expect(resolveCommand("/session")?.id).toBe("sessions");
    expect(resolveCommand("/provider")?.id).toBe("providers");
    expect(resolveCommand("/thinking")?.id).toBe("thinking");
    expect(resolveCommand("/q")?.id).toBe("quit");
    expect(resolveCommand("/update")).toBeUndefined();
    expect(resolveCommand("/demo-question")).toBeUndefined();
    expect(resolveCommand("/demo-tool")).toBeUndefined();
  });

  it("fuzzy filters production commands without restoring removed fixture entries", () => {
    expect(filterCommands("/mo")[0]?.id).toBe("model");
    expect(filterCommands("question")).toEqual([]);
    expect(filterCommands("update")).toEqual([]);
  });

  it("fails closed when two commands register the same exact alias", () => {
    const commands: CommandDefinition[] = [
      {
        id: "first",
        aliases: ["shared"],
        label: "/first",
        description: "First fixture",
        group: "扩展",
        source: "@vspi/first",
      },
      {
        id: "second",
        aliases: ["shared"],
        label: "/second",
        description: "Second fixture",
        group: "扩展",
        source: "@vspi/second",
      },
    ];

    expect(resolveCommand("/shared", commands)).toBeUndefined();
  });
});
