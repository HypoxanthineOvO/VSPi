import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type ReviewReason =
  | "turn-limit"
  | "work-limit"
  | "resume"
  | "compaction"
  | "repeated-failure"
  | "completion-claim";

export interface ReviewSnapshot {
  meaningfulTurns: number;
  workEvents: number;
  needsReview: boolean;
  reasons: ReviewReason[];
}

export interface ReviewTracker {
  snapshot(): ReviewSnapshot;
  noteMeaningfulTurn(): ReviewSnapshot;
  noteWorkEvent(): ReviewSnapshot;
  noteResume(): ReviewSnapshot;
  noteCompaction(): ReviewSnapshot;
  noteFailure(signature: string): ReviewSnapshot;
  noteCompletionClaim(): ReviewSnapshot;
  reset(): ReviewSnapshot;
}

export function createReviewTracker(): ReviewTracker {
  let meaningfulTurns = 0;
  let workEvents = 0;
  const reasons = new Set<ReviewReason>();
  const failures = new Map<string, number>();

  const snapshot = (): ReviewSnapshot => ({
    meaningfulTurns,
    workEvents,
    needsReview: reasons.size > 0,
    reasons: [...reasons],
  });
  const add = (reason: ReviewReason) => {
    reasons.add(reason);
    return snapshot();
  };

  return {
    snapshot,
    noteMeaningfulTurn() {
      meaningfulTurns += 1;
      return meaningfulTurns >= 4 ? add("turn-limit") : snapshot();
    },
    noteWorkEvent() {
      workEvents += 1;
      return workEvents >= 6 ? add("work-limit") : snapshot();
    },
    noteResume: () => add("resume"),
    noteCompaction: () => add("compaction"),
    noteFailure(signature) {
      const count = (failures.get(signature) ?? 0) + 1;
      failures.set(signature, count);
      return count >= 2 ? add("repeated-failure") : snapshot();
    },
    noteCompletionClaim: () => add("completion-claim"),
    reset() {
      meaningfulTurns = 0;
      workEvents = 0;
      reasons.clear();
      failures.clear();
      return snapshot();
    },
  };
}

export function createReviewReminderExtension(options: { tracker: ReviewTracker }): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const review = options.tracker.snapshot();
      if (!review.needsReview) return;
      const reminder = `<vspi_continuity_reminder hidden="true">Review the active Local Plan before continuing. Reasons: ${review.reasons.join(", ")}.</vspi_continuity_reminder>`;
      return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
    });
  };
}
