import { describe, expect, it } from "vitest";

type ReviewReason = "turn-limit" | "work-limit" | "resume" | "compaction" | "repeated-failure" | "completion-claim";

interface ReviewSnapshot {
  meaningfulTurns: number;
  workEvents: number;
  needsReview: boolean;
  reasons: ReviewReason[];
}

interface ReviewTracker {
  snapshot(): ReviewSnapshot;
  noteMeaningfulTurn(): ReviewSnapshot;
  noteWorkEvent(): ReviewSnapshot;
  noteResume(): ReviewSnapshot;
  noteCompaction(): ReviewSnapshot;
  noteFailure(signature: string): ReviewSnapshot;
  noteCompletionClaim(): ReviewSnapshot;
  reset(): ReviewSnapshot;
}

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: unknown;
}

type Handler = (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>;
type ExtensionFactory = (pi: { on(event: "before_agent_start", handler: Handler): void }) => void;

async function trackerModule() {
  const specifier = "../src/continuity/review-tracker.js";
  return (await import(specifier)) as {
    createReviewTracker(): ReviewTracker;
    createReviewReminderExtension(options: { tracker: ReviewTracker }): ExtensionFactory;
  };
}

function handlerFor(factory: ExtensionFactory): Handler {
  let handler: Handler | undefined;
  factory({
    on: (_event, next) => {
      handler = next;
    },
  });
  if (!handler) throw new Error("Review reminder did not register before_agent_start");
  return handler;
}

describe("M8 continuity review tracker", () => {
  it("requests review after four meaningful turns and reset starts a new window", async () => {
    const { createReviewTracker } = await trackerModule();
    const tracker = createReviewTracker();
    for (let index = 0; index < 3; index += 1) expect(tracker.noteMeaningfulTurn().needsReview).toBe(false);

    expect(tracker.noteMeaningfulTurn()).toMatchObject({ needsReview: true, meaningfulTurns: 4 });
    expect(tracker.snapshot().reasons).toContain("turn-limit");
    expect(tracker.reset()).toEqual({ meaningfulTurns: 0, workEvents: 0, needsReview: false, reasons: [] });
  });

  it("requests review after six work events independently of conversational turns", async () => {
    const { createReviewTracker } = await trackerModule();
    const tracker = createReviewTracker();
    for (let index = 0; index < 5; index += 1) expect(tracker.noteWorkEvent().needsReview).toBe(false);
    expect(tracker.noteWorkEvent()).toMatchObject({ needsReview: true, workEvents: 6 });
    expect(tracker.snapshot().reasons).toContain("work-limit");
  });

  it.each([
    ["resume", (tracker: ReviewTracker) => tracker.noteResume()],
    ["compaction", (tracker: ReviewTracker) => tracker.noteCompaction()],
    ["completion-claim", (tracker: ReviewTracker) => tracker.noteCompletionClaim()],
  ] as const)("marks %s as an immediate review boundary", async (reason, trigger) => {
    const { createReviewTracker } = await trackerModule();
    const tracker = createReviewTracker();
    expect(trigger(tracker).needsReview).toBe(true);
    expect(tracker.snapshot().reasons).toContain(reason);
  });

  it("requires the same failure to repeat before marking a review boundary", async () => {
    const { createReviewTracker } = await trackerModule();
    const tracker = createReviewTracker();
    expect(tracker.noteFailure("test:timeout").needsReview).toBe(false);
    expect(tracker.noteFailure("build:type-error").needsReview).toBe(false);
    expect(tracker.noteFailure("test:timeout").needsReview).toBe(true);
    expect(tracker.snapshot().reasons).toContain("repeated-failure");
  });

  it("adds a hidden per-turn system reminder without creating a modal or session message", async () => {
    const { createReviewReminderExtension, createReviewTracker } = await trackerModule();
    const tracker = createReviewTracker();
    tracker.noteCompaction();
    const handler = handlerFor(createReviewReminderExtension({ tracker }));

    const result = await handler({
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "Pi base",
      systemPromptOptions: {},
    });

    expect(result?.systemPrompt).toContain("Pi base");
    expect(result?.systemPrompt).toMatch(/review|复核|检查/i);
    expect(result).not.toHaveProperty("message");
    expect(Object.keys(result ?? {})).toEqual(["systemPrompt"]);
  });
});
