import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

interface PlanWorkItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked" | "done";
  blocker?: string;
  children?: PlanWorkItem[];
}

interface PlanInput {
  title: string;
  goal: string;
  background?: string;
  challenges: string[];
  items: PlanWorkItem[];
  focusItemId?: string;
  blockers: string[];
  nextAction?: string;
}

interface StoredPlan extends PlanInput {
  id: string;
  revision: number;
  semanticHash: string;
  archived: boolean;
}

interface PlanBackendPort {
  create(plan: PlanInput): Promise<StoredPlan>;
  list(options?: { includeArchived?: boolean }): Promise<StoredPlan[]>;
  read(planId: string): Promise<StoredPlan | undefined>;
  update(planId: string, input: { expectedRevision: number; plan: PlanInput }): Promise<StoredPlan>;
  archive(planId: string, input: { expectedRevision: number }): Promise<StoredPlan>;
}

interface PlanBindingPort {
  read(): Promise<string | null>;
  bind(planId: string | null): Promise<void>;
}

interface PlanToolsModule {
  createPlanToolDefinitions(options: {
    backend: PlanBackendPort;
    binding: PlanBindingPort;
    onMutation?: (operation: "create" | "update" | "archive" | "bind", plan?: StoredPlan) => void | Promise<void>;
  }): ToolDefinition[];
}

async function loadToolsModule(): Promise<PlanToolsModule | undefined> {
  const modulePath = "../src/plans/tools.js";
  return import(modulePath).catch(() => undefined) as Promise<PlanToolsModule | undefined>;
}

const STORED_PLAN: StoredPlan = {
  id: "plan-01",
  title: "Local plan",
  goal: "Expose narrow typed operations",
  background: "Private storage root must not leak",
  challenges: ["schema"],
  items: [
    { id: "one", title: "First", status: "in_progress" },
    { id: "two", title: "Second", status: "in_progress", blocker: "waiting" },
  ],
  focusItemId: "one",
  blockers: ["review"],
  nextAction: "Run tests",
  revision: 3,
  semanticHash: "a".repeat(64),
  archived: false,
};

function backendMock(overrides: Partial<PlanBackendPort> = {}): PlanBackendPort {
  return {
    create: vi.fn(async () => structuredClone(STORED_PLAN)),
    list: vi.fn(async () => [structuredClone(STORED_PLAN)]),
    read: vi.fn(async () => structuredClone(STORED_PLAN)),
    update: vi.fn(async () => ({ ...structuredClone(STORED_PLAN), revision: 4 })),
    archive: vi.fn(async () => ({ ...structuredClone(STORED_PLAN), revision: 4, archived: true })),
    ...overrides,
  };
}

function bindingMock(): PlanBindingPort {
  return { read: vi.fn(async () => null), bind: vi.fn(async () => undefined) };
}

async function toolsFor(
  backend = backendMock(),
  binding = bindingMock(),
  onMutation?: (operation: "create" | "update" | "archive" | "bind", plan?: StoredPlan) => void | Promise<void>,
) {
  const module = await loadToolsModule();
  expect(module, "M6 must expose createPlanToolDefinitions from src/plans/tools.ts").toBeDefined();
  if (!module) throw new Error("Plan tools module is unavailable");
  const tools = module.createPlanToolDefinitions({ backend, binding, ...(onMutation ? { onMutation } : {}) });
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])), backend, binding };
}

async function execute(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
  expect(tool).toBeDefined();
  if (!tool) throw new Error("Required plan tool is unavailable");
  return tool.execute("m6-contract-call", params, undefined, undefined, {} as never);
}

function resultPayload(result: Awaited<ReturnType<typeof execute>>): unknown {
  const text = result.content.find((part) => part.type === "text")?.text;
  expect(text).toBeTypeOf("string");
  return JSON.parse(text ?? "null");
}

function planToolInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    title: "Tool-created plan",
    goal: "Validate routing",
    challenges: ["bounded schemas"],
    items: [{ id: "work", title: "Work", status: "in_progress" }],
    focusItemId: "work",
    blockers: [],
    nextAction: "Call update",
    ...overrides,
  };
}

describe("M6 typed plan tool schemas", () => {
  it("returns exactly five Pi ToolDefinitions with executable TypeBox schemas", async () => {
    const { tools, byName } = await toolsFor();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["plan_bind", "plan_create", "plan_list", "plan_read", "plan_update"].sort(),
    );
    for (const tool of tools) {
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.execute).toBeTypeOf("function");
    }

    expect(Value.Check(byName.get("plan_list")?.parameters as never, {})).toBe(true);
    expect(Value.Check(byName.get("plan_read")?.parameters as never, { plan_id: "plan-01" })).toBe(true);
    expect(Value.Check(byName.get("plan_create")?.parameters as never, { plan: planToolInput() })).toBe(true);
    expect(
      Value.Check(byName.get("plan_update")?.parameters as never, {
        plan_id: "plan-01",
        expected_revision: 3,
        plan: planToolInput(),
      }),
    ).toBe(true);
    expect(
      Value.Check(byName.get("plan_update")?.parameters as never, {
        plan_id: "plan-01",
        expected_revision: 3,
        archive: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(byName.get("plan_bind")?.parameters as never, {
        plan_id: "plan-01",
        expected_revision: 3,
      }),
    ).toBe(true);
    expect(Value.Check(byName.get("plan_bind")?.parameters as never, { plan_id: null })).toBe(true);
  });

  it("bounds identifiers, text, work depth, enum values and additional properties at schema validation", async () => {
    const { byName } = await toolsFor();
    const createSchema = byName.get("plan_create")?.parameters as never;
    const updateSchema = byName.get("plan_update")?.parameters as never;
    const tooDeep = planToolInput({
      items: [
        {
          id: "l1",
          title: "1",
          status: "pending",
          children: [
            {
              id: "l2",
              title: "2",
              status: "pending",
              children: [
                {
                  id: "l3",
                  title: "3",
                  status: "pending",
                  children: [{ id: "l4", title: "4", status: "pending" }],
                },
              ],
            },
          ],
        },
      ],
      focusItemId: "l3",
    });

    expect(Value.Check(createSchema, { plan: tooDeep })).toBe(false);
    expect(Value.Check(createSchema, { plan: planToolInput({ title: "x".repeat(10_000) }) })).toBe(false);
    expect(
      Value.Check(createSchema, {
        plan: planToolInput({ items: [{ id: "work", title: "Work", status: "invented" as never }] }),
      }),
    ).toBe(false);
    expect(Value.Check(createSchema, { plan: planToolInput(), secret: "must-not-be-accepted" })).toBe(false);
    expect(Value.Check(updateSchema, { plan_id: "plan-01", expected_revision: 0, plan: planToolInput() })).toBe(false);
  });
});

describe("M6 typed plan tool routing", () => {
  it("routes list/read/create and projects answer-only, storage-safe results", async () => {
    const backend = backendMock({
      read: vi.fn(async () => ({
        ...structuredClone(STORED_PLAN),
        storagePath: "/home/private/.vspi/plans",
        apiToken: "PLAN_TOOL_SECRET_SENTINEL",
      })) as PlanBackendPort["read"],
    });
    const { byName } = await toolsFor(backend);
    const listResult = await execute(byName.get("plan_list"), { include_archived: true });
    const readResult = await execute(byName.get("plan_read"), { plan_id: "plan-01" });
    const createResult = await execute(byName.get("plan_create"), { plan: planToolInput() });
    const listed = resultPayload(listResult);
    const read = resultPayload(readResult);
    const created = resultPayload(createResult);

    expect(backend.list).toHaveBeenCalledWith({ includeArchived: true });
    expect(backend.read).toHaveBeenCalledWith("plan-01");
    expect(backend.create).toHaveBeenCalledWith(planToolInput());
    expect(listed).toEqual([
      expect.objectContaining({ id: "plan-01", title: "Local plan", revision: 3, archived: false }),
    ]);
    expect(read).toMatchObject({ id: "plan-01", goal: STORED_PLAN.goal, items: STORED_PLAN.items, revision: 3 });
    expect(created).toMatchObject({ id: "plan-01", revision: 3, semanticHash: "a".repeat(64) });
    const serialized = JSON.stringify({ listResult, readResult, createResult });
    expect(serialized).not.toContain("/home/private");
    expect(serialized).not.toContain("PLAN_TOOL_SECRET_SENTINEL");
    expect(serialized).not.toMatch(/storagePath|apiToken/);
  });

  it("passes expected_revision to update and uses the archive operation for archived plans", async () => {
    const backend = backendMock();
    const { byName } = await toolsFor(backend);
    const updatePlan = planToolInput({ nextAction: "Persist exact revision" });
    const updated = resultPayload(
      await execute(byName.get("plan_update"), {
        plan_id: "plan-01",
        expected_revision: 3,
        plan: updatePlan,
      }),
    );
    const archived = resultPayload(
      await execute(byName.get("plan_update"), {
        plan_id: "plan-01",
        expected_revision: 4,
        archive: true,
      }),
    );

    expect(backend.update).toHaveBeenCalledWith("plan-01", { expectedRevision: 3, plan: updatePlan });
    expect(backend.archive).toHaveBeenCalledWith("plan-01", { expectedRevision: 4 });
    expect(updated).toMatchObject({ id: "plan-01", revision: 4 });
    expect(archived).toMatchObject({ id: "plan-01", revision: 4, archived: true });
  });

  it("binds through the injected Session custom-entry port and verifies the requested revision", async () => {
    const backend = backendMock();
    const binding = bindingMock();
    const { byName } = await toolsFor(backend, binding);
    const bound = resultPayload(
      await execute(byName.get("plan_bind"), { plan_id: "plan-01", expected_revision: STORED_PLAN.revision }),
    );
    const unbound = resultPayload(await execute(byName.get("plan_bind"), { plan_id: null }));

    expect(backend.read).toHaveBeenCalledWith("plan-01");
    expect(binding.bind).toHaveBeenNthCalledWith(1, "plan-01");
    expect(binding.bind).toHaveBeenNthCalledWith(2, null);
    expect(bound).toEqual({ planId: "plan-01", revision: 3 });
    expect(unbound).toEqual({ planId: null });
  });

  it("reports successful mutations so the runtime can refresh the panel and reset review hooks", async () => {
    const onMutation = vi.fn();
    const { byName } = await toolsFor(backendMock(), bindingMock(), onMutation);

    await execute(byName.get("plan_create"), { plan: planToolInput() });
    await execute(byName.get("plan_update"), {
      plan_id: "plan-01",
      expected_revision: 3,
      plan: planToolInput({ nextAction: "Refresh UI" }),
    });
    await execute(byName.get("plan_update"), { plan_id: "plan-01", expected_revision: 4, archive: true });
    await execute(byName.get("plan_bind"), { plan_id: "plan-01", expected_revision: 3 });

    expect(onMutation.mock.calls.map(([operation]) => operation)).toEqual(["create", "update", "archive", "bind"]);
  });

  it("rejects stale bind revisions before touching the binding port", async () => {
    const backend = backendMock();
    const binding = bindingMock();
    const { byName } = await toolsFor(backend, binding);

    await expect(
      execute(byName.get("plan_bind"), { plan_id: "plan-01", expected_revision: STORED_PLAN.revision - 1 }),
    ).rejects.toThrow(/conflict|expected|revision|stale|冲突/i);
    expect(binding.bind).not.toHaveBeenCalled();
  });

  it("bounds and redacts backend failures before returning them to the model", async () => {
    const privatePath = "/home/private/workspace/.vspi/plans";
    const secret = "PLAN_BACKEND_SECRET_SENTINEL";
    const backend = backendMock({
      read: vi.fn(async () => {
        throw new Error(`cannot read ${privatePath}; token=${secret}; ${"internal detail ".repeat(200)}`);
      }),
    });
    const { byName } = await toolsFor(backend);
    let caught: unknown;
    try {
      await execute(byName.get("plan_read"), { plan_id: "plan-01" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = String(caught);
    expect(message.length).toBeLessThanOrEqual(600);
    expect(message).not.toContain(privatePath);
    expect(message).not.toContain(secret);
    expect(message).toMatch(/plan|read|failed|error|读取|失败/i);
  });
});
