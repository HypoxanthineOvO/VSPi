import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CronRuntime } from "../src/cron/runtime.js";
import { createCronToolDefinitions } from "../src/cron/tools.js";
import type { CronStoreEvent } from "../src/cron/types.js";

async function tools() {
  const events: CronStoreEvent[] = [];
  const runtime = await CronRuntime.restore({
    store: {
      read: () => events,
      append: (event) => {
        events.push(event);
      },
    },
    now: () => new Date(2026, 7, 27, 10, 0, 0).getTime(),
    isIdle: () => true,
    injectPrompt: () => {},
  });
  return new Map(createCronToolDefinitions(runtime).map((tool) => [tool.name, tool]));
}

async function execute(tool: ToolDefinition | undefined, input: Record<string, unknown>) {
  if (!tool) throw new Error("missing cron tool");
  return tool.execute("call", input, undefined, undefined, {} as never);
}

describe("Cron tools", () => {
  it("exposes create/list/delete with strict bounded schemas", async () => {
    const byName = await tools();
    expect([...byName.keys()]).toEqual(["CronCreate", "CronList", "CronDelete"]);
    expect(Value.Check(byName.get("CronCreate")?.parameters as never, { cron: "5 * * * *", prompt: "check" })).toBe(
      true,
    );
    expect(
      Value.Check(byName.get("CronCreate")?.parameters as never, { cron: "5 * * * *", prompt: "check", extra: true }),
    ).toBe(false);
    expect(Value.Check(byName.get("CronCreate")?.parameters as never, { after: "2h30m", prompt: "continue" })).toBe(
      true,
    );
    expect(
      Value.Check(byName.get("CronCreate")?.parameters as never, {
        run_at: "2026-08-28T09:00+08:00",
        prompt: "continue",
      }),
    ).toBe(true);
    expect(byName.get("CronCreate")?.promptSnippet).toContain("one-shot");
    expect(byName.get("CronCreate")?.promptGuidelines?.join(" ")).toContain("quota");
  });

  it("creates a native relative one-shot", async () => {
    const byName = await tools();
    const created = await execute(byName.get("CronCreate"), { after: "2h", prompt: "retry after quota reset" });
    expect(created.details).toMatchObject({ recurring: false, nextFireAt: new Date(2026, 7, 27, 12, 0, 0).getTime() });
  });

  it("creates, lists, and deletes a task", async () => {
    const byName = await tools();
    const created = await execute(byName.get("CronCreate"), {
      cron: " 5   11 * * * ",
      prompt: "check the build",
      recurring: false,
    });
    const createDetails = created.details as { id: string; cron: string; recurring: boolean };
    expect(createDetails).toMatchObject({ cron: "5 11 * * *", recurring: false });

    const listed = await execute(byName.get("CronList"), {});
    expect(listed.details).toMatchObject({
      cron_jobs: [{ id: createDetails.id, prompt: "check the build", recurring: false }],
    });
    await execute(byName.get("CronDelete"), { id: createDetails.id });
    expect((await execute(byName.get("CronList"), {})).details).toEqual({ cron_jobs: [] });
  });

  it("enforces the prompt limit in UTF-8 bytes", async () => {
    const byName = await tools();
    await expect(execute(byName.get("CronCreate"), { cron: "* * * * *", prompt: "你".repeat(3_000) })).rejects.toThrow(
      "8192 UTF-8 bytes",
    );
  });
});
