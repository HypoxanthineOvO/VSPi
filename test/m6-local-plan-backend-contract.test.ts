import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

type PlanStatus = "pending" | "in_progress" | "blocked" | "done";

interface PlanWorkItem {
  id: string;
  title: string;
  status: PlanStatus;
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

type FaultStage = "after_lock_acquired" | "after_revision_persisted" | "after_head_persisted";

interface LocalPlanBackend {
  create(plan: PlanInput): Promise<StoredPlan>;
  list(options?: { includeArchived?: boolean }): Promise<StoredPlan[]>;
  read(planId: string): Promise<StoredPlan | undefined>;
  update(planId: string, input: { expectedRevision: number; plan: PlanInput }): Promise<StoredPlan>;
  archive(planId: string, input: { expectedRevision: number }): Promise<StoredPlan>;
}

interface LocalPlanBackendModule {
  createLocalPlanBackend(options: {
    rootDir: string;
    lockTimeoutMs?: number;
    staleLockMs?: number;
    faultInjector?: (
      stage: FaultStage,
      context: { planId?: string; revision?: number; semanticHash?: string },
    ) => void | Promise<void>;
  }): LocalPlanBackend;
}

async function loadBackendModule(): Promise<LocalPlanBackendModule | undefined> {
  const modulePath = "../src/plans/local-plan-backend.js";
  return import(modulePath).catch(() => undefined) as Promise<LocalPlanBackendModule | undefined>;
}

async function backendAt(
  rootDir: string,
  options: Omit<Parameters<LocalPlanBackendModule["createLocalPlanBackend"]>[0], "rootDir"> = {},
): Promise<LocalPlanBackend> {
  const module = await loadBackendModule();
  expect(module, "M6 must expose createLocalPlanBackend from src/plans/local-plan-backend.ts").toBeDefined();
  if (!module) throw new Error("LocalPlanBackend module is unavailable");
  return module.createLocalPlanBackend({ rootDir, ...options });
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    title: "Ship local plans",
    goal: "Keep work resumable without Hypo-Workflow state",
    background: "The plan belongs to VSPi, not chat history.",
    challenges: ["atomic persistence", "concurrent writers"],
    items: [
      {
        id: "storage",
        title: "Storage",
        status: "in_progress",
        children: [
          {
            id: "revisions",
            title: "Immutable revisions",
            status: "in_progress",
            children: [{ id: "head", title: "Atomic HEAD", status: "pending" }],
          },
        ],
      },
      { id: "tools", title: "Typed tools", status: "blocked", blocker: "Storage contract first" },
    ],
    focusItemId: "revisions",
    blockers: ["Need crash recovery evidence"],
    nextAction: "Commit revision 1",
    ...overrides,
  };
}

function publicInput(plan: StoredPlan, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    title: plan.title,
    goal: plan.goal,
    ...(plan.background === undefined ? {} : { background: plan.background }),
    challenges: structuredClone(plan.challenges),
    items: structuredClone(plan.items),
    ...(plan.focusItemId === undefined ? {} : { focusItemId: plan.focusItemId }),
    blockers: structuredClone(plan.blockers),
    ...(plan.nextAction === undefined ? {} : { nextAction: plan.nextAction }),
    ...overrides,
  };
}

interface FileSnapshot {
  path: string;
  bytes: Buffer;
}

async function snapshotFiles(root: string): Promise<FileSnapshot[]> {
  const result: FileSnapshot[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push({ path: relative(root, path), bytes: await readFile(path) });
    }
  }
  await visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function committedRevisionFile(files: FileSnapshot[], plan: StoredPlan): FileSnapshot | undefined {
  const hashPrefix = plan.semanticHash.slice(0, 12);
  return files.find(({ path, bytes }) => {
    const name = basename(path);
    const text = bytes.toString("utf8");
    return (
      name.includes(hashPrefix) &&
      new RegExp(`(^|\\D)0*${plan.revision}(\\D|$)`).test(name) &&
      text.includes(plan.id) &&
      text.includes(plan.semanticHash)
    );
  });
}

describe("M6 LocalPlanBackend revision store", () => {
  it("creates, lists, reads, updates and archives isolated plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-crud-"));
    const backend = await backendAt(root);
    const first = await backend.create(planInput({ title: "First plan" }));
    const second = await backend.create(planInput({ title: "Second plan", focusItemId: "tools" }));

    expect(first).toMatchObject({ title: "First plan", revision: 1, archived: false });
    expect(second).toMatchObject({ title: "Second plan", revision: 1, archived: false });
    expect(first.id).not.toBe(second.id);
    expect(first.semanticHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await backend.list()).map((plan) => plan.id).sort()).toEqual([first.id, second.id].sort());
    expect(await backend.read(first.id)).toEqual(first);

    const updated = await backend.update(first.id, {
      expectedRevision: first.revision,
      plan: publicInput(first, { nextAction: "Commit revision 2" }),
    });
    expect(updated).toMatchObject({ id: first.id, revision: 2, nextAction: "Commit revision 2" });
    expect((await backend.read(second.id))?.revision).toBe(1);

    const archived = await backend.archive(first.id, { expectedRevision: updated.revision });
    expect(archived).toMatchObject({ id: first.id, revision: 3, archived: true });
    expect((await backend.list()).map((plan) => plan.id)).toEqual([second.id]);
    expect((await backend.list({ includeArchived: true })).map((plan) => plan.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect((await backend.read(first.id))?.archived).toBe(true);
  });

  it("persists immutable numbered, content-addressed revisions and advances an atomic current pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-revisions-"));
    const backend = await backendAt(root);
    const revision1 = await backend.create(planInput());
    const filesAtRevision1 = await snapshotFiles(root);
    const persistedRevision1 = committedRevisionFile(filesAtRevision1, revision1);

    expect(persistedRevision1, "revision filename must carry its number and semantic hash").toBeDefined();
    const revision2 = await backend.update(revision1.id, {
      expectedRevision: 1,
      plan: publicInput(revision1, { nextAction: "Advance HEAD atomically" }),
    });
    const filesAtRevision2 = await snapshotFiles(root);
    const persistedRevision2 = committedRevisionFile(filesAtRevision2, revision2);

    expect(revision2.revision).toBe(2);
    expect(revision2.semanticHash).not.toBe(revision1.semanticHash);
    expect(persistedRevision2, "each committed revision must be independently content addressed").toBeDefined();
    expect(filesAtRevision2.find((file) => file.path === persistedRevision1?.path)?.bytes).toEqual(
      persistedRevision1?.bytes,
    );
    await expect((await backendAt(root)).read(revision1.id)).resolves.toEqual(revision2);
  });

  it("accepts three levels and multiple in-progress items while rejecting deeper trees or dangling focus", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-schema-"));
    const backend = await backendAt(root);
    const valid = await backend.create(planInput());

    expect(valid.items[0]?.status).toBe("in_progress");
    expect(valid.items[0]?.children?.[0]?.status).toBe("in_progress");
    expect(valid.items[1]).toMatchObject({ status: "blocked", blocker: "Storage contract first" });
    expect(valid).toMatchObject({
      focusItemId: "revisions",
      blockers: ["Need crash recovery evidence"],
      nextAction: "Commit revision 1",
    });

    const level4: PlanWorkItem = {
      id: "l1",
      title: "Level 1",
      status: "pending",
      children: [
        {
          id: "l2",
          title: "Level 2",
          status: "pending",
          children: [
            {
              id: "l3",
              title: "Level 3",
              status: "pending",
              children: [{ id: "l4", title: "Level 4", status: "pending" }],
            },
          ],
        },
      ],
    };
    await expect(backend.create(planInput({ items: [level4], focusItemId: "l3" }))).rejects.toThrow(
      /depth|three|3|层/i,
    );
    await expect(backend.create(planInput({ focusItemId: "missing-item" }))).rejects.toThrow(/focus|item|引用|存在/i);
    await expect(
      backend.create(
        planInput({ items: [...planInput().items, { id: "tools", title: "Duplicate", status: "pending" }] }),
      ),
    ).rejects.toThrow(/duplicate|unique|item.*id|重复/i);
  });

  it("keeps semantic hashes stable across key order and non-semantic revision metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-semantic-hash-"));
    const backend = await backendAt(root);
    const created = await backend.create(planInput());
    const reorderedWithMetadata = {
      semanticHash: "caller-supplied-hash-must-not-participate",
      revision: 999,
      archived: false,
      nextAction: created.nextAction,
      blockers: [...created.blockers],
      focusItemId: created.focusItemId,
      items: structuredClone(created.items),
      challenges: [...created.challenges],
      background: created.background,
      goal: created.goal,
      title: created.title,
      id: "caller-supplied-id-must-not-participate",
    } as unknown as PlanInput;

    const noSemanticChange = await backend.update(created.id, {
      expectedRevision: created.revision,
      plan: reorderedWithMetadata,
    });

    expect(noSemanticChange.semanticHash).toBe(created.semanticHash);
    expect(noSemanticChange.id).toBe(created.id);
    expect(noSemanticChange).not.toMatchObject({ revision: 999 });
  });

  it("rejects a stale expected revision without writing a revision, temp file, or pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-conflict-"));
    const backend = await backendAt(root);
    const created = await backend.create(planInput());
    const before = await snapshotFiles(root);

    await expect(
      backend.update(created.id, {
        expectedRevision: created.revision + 10,
        plan: publicInput(created, { title: "Must never persist" }),
      }),
    ).rejects.toThrow(/conflict|expected|revision|stale|冲突/i);

    expect(await snapshotFiles(root)).toEqual(before);
    expect(await backend.read(created.id)).toEqual(created);
  });

  it("rejects symlinked plan directories and HEAD files without writing through either link", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "vspi-m6-plan-outside-"));
    const outsidePlan = join(outside, "borrowed-plan");
    const outsideHead = join(outside, "borrowed-head.json");
    await mkdir(outsidePlan);
    await writeFile(join(outsidePlan, "marker.txt"), "OUTSIDE_PLAN_UNCHANGED");
    await writeFile(outsideHead, "OUTSIDE_HEAD_UNCHANGED");
    const backend = await backendAt(root);
    await backend.list();
    await symlink(outsidePlan, join(root, "plans", "plan-external"));
    const outsideBeforePlanLink = await snapshotFiles(outside);

    await expect(backend.read("plan-external")).rejects.toThrow(/symlink|symbolic|ordinary|directory|链接/i);
    await expect(
      backend.update("plan-external", { expectedRevision: 1, plan: planInput({ title: "Must stay inside" }) }),
    ).rejects.toThrow(/symlink|symbolic|ordinary|directory|链接/i);
    expect(await snapshotFiles(outside)).toEqual(outsideBeforePlanLink);

    const created = await backend.create(planInput({ title: "HEAD symlink boundary" }));
    const headPath = join(root, "plans", created.id, "HEAD");
    await rm(headPath);
    await symlink(outsideHead, headPath);
    const outsideBeforeHeadLink = await snapshotFiles(outside);

    await expect(backend.read(created.id)).rejects.toThrow(/symlink|symbolic|ordinary|HEAD|链接/i);
    await expect(
      backend.update(created.id, {
        expectedRevision: created.revision,
        plan: publicInput(created, { nextAction: "Must not follow HEAD" }),
      }),
    ).rejects.toThrow(/symlink|symbolic|ordinary|HEAD|链接/i);
    expect(await snapshotFiles(outside)).toEqual(outsideBeforeHeadLink);
  });

  it("rejects HEAD revision, hash, or file drift instead of treating damaged committed state as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-head-drift-"));
    const backend = await backendAt(root);
    const created = await backend.create(planInput());
    const headPath = join(root, "plans", created.id, "HEAD");
    const validHead = JSON.parse(await readFile(headPath, "utf8")) as {
      file: string;
      revision: number;
      semanticHash: string;
    };
    const driftedHeads = [
      { ...validHead, revision: validHead.revision + 1 },
      { ...validHead, semanticHash: "b".repeat(64) },
      { ...validHead, file: `${String(validHead.revision).padStart(8, "0")}-${"c".repeat(12)}.json` },
    ];

    for (const drifted of driftedHeads) {
      await writeFile(headPath, `${JSON.stringify(drifted)}\n`);
      await expect(backend.read(created.id)).rejects.toThrow(/HEAD|integrity|metadata|revision|hash|file|完整性/i);
    }
  });
});

describe("M6 LocalPlanBackend locking and recovery", () => {
  it("does not steal a live PID/heartbeat lock after staleLockMs and commits one CAS update", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-lock-"));
    let releaseFirstWriter: (() => void) | undefined;
    let firstWriterEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstWriterEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirstWriter = resolve;
    });
    let pauseNextLock = false;
    const firstBackend = await backendAt(root, {
      lockTimeoutMs: 2_000,
      staleLockMs: 15,
      faultInjector: async (stage) => {
        if (stage !== "after_lock_acquired" || !pauseNextLock) return;
        pauseNextLock = false;
        firstWriterEntered?.();
        await gate;
      },
    });
    const secondBackend = await backendAt(root, { lockTimeoutMs: 2_000, staleLockMs: 15 });
    const created = await firstBackend.create(planInput());
    const before = await snapshotFiles(root);
    pauseNextLock = true;
    const firstWrite = firstBackend.update(created.id, {
      expectedRevision: 1,
      plan: publicInput(created, { nextAction: "First writer" }),
    });
    await entered;

    let secondSettled = false;
    const secondWrite = secondBackend
      .update(created.id, {
        expectedRevision: 1,
        plan: publicInput(created, { nextAction: "Second writer" }),
      })
      .finally(() => {
        secondSettled = true;
      });
    await delay(75);
    expect(secondSettled, "a live owner must keep the writer lock after several stale/heartbeat intervals").toBe(false);
    releaseFirstWriter?.();

    const outcomes = await Promise.allSettled([firstWrite, secondWrite]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(String((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason)).toMatch(
      /conflict|expected|revision|stale|冲突/i,
    );
    const current = await secondBackend.read(created.id);
    expect(current?.revision).toBe(2);
    expect(["First writer", "Second writer"]).toContain(current?.nextAction);
    const after = await snapshotFiles(root);
    const newCommittedRevisions = after.filter(
      (file) =>
        !before.some((old) => old.path === file.path) && file.path.includes(current?.semanticHash.slice(0, 12) ?? "!"),
    );
    expect(newCommittedRevisions).toHaveLength(1);
  });

  it("reuses an identical orphan revision and safely advances HEAD after a pre-swap crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-crash-"));
    let crashNextRevision = false;
    const crashingBackend = await backendAt(root, {
      faultInjector(stage) {
        if (stage === "after_revision_persisted" && crashNextRevision) throw new Error("SIMULATED_WRITER_CRASH");
      },
    });
    const created = await crashingBackend.create(planInput());
    const retriedPlan = publicInput(created, { nextAction: "Retry identical orphan" });
    crashNextRevision = true;

    await expect(
      crashingBackend.update(created.id, {
        expectedRevision: 1,
        plan: retriedPlan,
      }),
    ).rejects.toThrow("SIMULATED_WRITER_CRASH");

    const recoveredBackend = await backendAt(root, { lockTimeoutMs: 500 });
    expect(await recoveredBackend.read(created.id)).toEqual(created);
    const recovered = await recoveredBackend.update(created.id, {
      expectedRevision: 1,
      plan: structuredClone(retriedPlan),
    });
    expect(recovered).toMatchObject({ revision: 2, nextAction: "Retry identical orphan" });
    expect(await recoveredBackend.read(created.id)).toEqual(recovered);
  });

  it("ignores partial temporary files beside committed storage and preserves other plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m6-plan-partial-"));
    const backend = await backendAt(root);
    const first = await backend.create(planInput({ title: "Stable first" }));
    const second = await backend.create(planInput({ title: "Stable second", nextAction: "Leave untouched" }));
    const files = await snapshotFiles(root);
    const firstRevision = committedRevisionFile(files, first);
    expect(firstRevision).toBeDefined();
    if (!firstRevision) return;
    const sibling = join(root, dirname(firstRevision.path));
    await writeFile(join(sibling, `${basename(firstRevision.path)}.tmp`), "{ partial json");
    await writeFile(join(sibling, `.partial-${first.semanticHash}`), "truncated");
    expect((await stat(sibling)).isDirectory()).toBe(true);

    const recoveredBackend = await backendAt(root);
    expect(await recoveredBackend.read(first.id)).toEqual(first);
    expect(await recoveredBackend.read(second.id)).toEqual(second);
    const updated = await recoveredBackend.update(first.id, {
      expectedRevision: first.revision,
      plan: publicInput(first, { nextAction: "Recovered despite temp debris" }),
    });
    expect(updated.revision).toBe(2);
    expect(await recoveredBackend.read(second.id)).toEqual(second);
  });
});
