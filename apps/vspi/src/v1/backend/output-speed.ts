export interface OutputSpeedSnapshot {
  now: number | null;
  average: number | null;
}

interface DeltaSample {
  at: number;
  estimatedTokens: number;
}

const WINDOW_MS = 2_000;

export class OutputSpeedTracker {
  private readonly samples: DeltaSample[] = [];
  private responseFirstDeltaAt: number | undefined;
  private responseLastDeltaAt: number | undefined;
  private completedTokens = 0;
  private completedDurationMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  recordDelta(delta: string): OutputSpeedSnapshot {
    const at = this.now();
    this.responseFirstDeltaAt ??= at;
    this.responseLastDeltaAt = at;
    this.samples.push({ at, estimatedTokens: Array.from(delta).length / 4 });
    return this.snapshot();
  }

  finish(outputTokens: number): OutputSpeedSnapshot {
    if (
      this.responseFirstDeltaAt !== undefined &&
      this.responseLastDeltaAt !== undefined &&
      this.responseLastDeltaAt > this.responseFirstDeltaAt &&
      Number.isFinite(outputTokens) &&
      outputTokens >= 0
    ) {
      this.completedTokens += outputTokens;
      this.completedDurationMs += this.responseLastDeltaAt - this.responseFirstDeltaAt;
    }
    this.samples.length = 0;
    this.responseFirstDeltaAt = undefined;
    this.responseLastDeltaAt = undefined;
    return this.snapshot();
  }

  reset(): void {
    this.samples.length = 0;
    this.responseFirstDeltaAt = undefined;
    this.responseLastDeltaAt = undefined;
    this.completedTokens = 0;
    this.completedDurationMs = 0;
  }

  snapshot(): OutputSpeedSnapshot {
    const at = this.now();
    while (this.samples[0] && this.samples[0].at < at - WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const activeDurationMs = first ? at - first.at : 0;
    const estimatedTokens = this.samples.reduce((total, sample) => total + sample.estimatedTokens, 0);
    return {
      now: activeDurationMs > 0 ? (estimatedTokens * 1_000) / activeDurationMs : null,
      average: this.completedDurationMs > 0 ? (this.completedTokens * 1_000) / this.completedDurationMs : null,
    };
  }
}
