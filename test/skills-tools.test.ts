import { describe, expect, it, vi } from "vitest";
import type { Question } from "../src/domain/types.js";
import { createSkillToolDefinitions } from "../src/skills/tools.js";
import type { SkillCatalogItem, SkillManager } from "../src/skills/types.js";

describe("Skill model tools", () => {
  it("lists the catalog without mutation", async () => {
    const manager = fakeManager();
    const tools = createSkillToolDefinitions({
      manager: () => manager,
      request: vi.fn(async (questions) => questions),
    });
    const list = tools.find((tool) => tool.name === "skill_list");
    const result = await list?.execute("call", {}, undefined, undefined, undefined as never);
    expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ci-review") });
    expect(manager.install).not.toHaveBeenCalled();
  });

  it("offers install-and-enable, install-only and cancel before changing anything", async () => {
    const manager = fakeManager();
    const request = vi.fn(async (questions: Question[]) => {
      const question = questions[0];
      return question ? [{ ...question, answer: "install-only" }] : [];
    });
    const tools = createSkillToolDefinitions({ manager: () => manager, request });
    const manage = tools.find((tool) => tool.name === "skill_manage");

    await manage?.execute(
      "call",
      { action: "install", source: "https://github.com/example/skills.git", scope: "user" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(request.mock.calls[0]?.[0][0]?.options?.map((option) => option.id)).toEqual([
      "install-enable",
      "install-only",
      "cancel",
    ]);
    expect(manager.install).toHaveBeenCalledWith("https://github.com/example/skills.git", "user", false);
  });

  it("never mutates when the user cancels", async () => {
    const manager = fakeManager();
    const request = vi.fn(async (questions: Question[]) => {
      const question = questions[0];
      return question ? [{ ...question, answer: "cancel" }] : [];
    });
    const tools = createSkillToolDefinitions({ manager: () => manager, request });
    const manage = tools.find((tool) => tool.name === "skill_manage");

    await manage?.execute(
      "call",
      { action: "enable", skill_id: "skill-id", scope: "user" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(manager.setEnabled).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing sources before opening a Question", async () => {
    const manager = fakeManager();
    const request = vi.fn(async (questions: Question[]) => questions);
    const tools = createSkillToolDefinitions({ manager: () => manager, request });
    const manage = tools.find((tool) => tool.name === "skill_manage");

    await expect(
      manage?.execute(
        "call",
        { action: "install", source: "https://user:secret@example.com/skills.git", scope: "user" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Skill URL 不能包含凭据");
    expect(request).not.toHaveBeenCalled();
    expect(manager.install).not.toHaveBeenCalled();
  });
});

function fakeManager(): SkillManager {
  const item: SkillCatalogItem = {
    id: "skill-id",
    name: "ci-review",
    description: "Review CI failures",
    filePath: "/skills/ci-review/SKILL.md",
    source: "package",
    sourceLabel: "Package",
    scope: "user",
    enabled: false,
    installed: true,
    disableModelInvocation: false,
    packageSource: "https://github.com/example/skills.git",
    packagePattern: "skills/ci-review/SKILL.md",
    actions: ["enable", "update", "remove"],
  };
  return {
    list: vi.fn(async () => ({ items: [item], issues: [], projectTrusted: false })),
    install: vi.fn(async (source, scope, enabled) => ({ source, scope, enabled, skills: ["ci-review"] })),
    setEnabled: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}
