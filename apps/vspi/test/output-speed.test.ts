/**
 * Scenario: footer speed is sampled from streamed output and calibrated by authoritative usage.
 * Responsibilities: rolling speed and completed-turn average.
 * Wiring: pure tracker with an injected monotonic clock.
 * Run: pnpm -C apps/vspi test
 */
import { describe, expect, it } from 'vitest';

import { OutputSpeedTracker } from '../src/v1/backend/output-speed.js';

describe('output speed telemetry (stream and turn contract)', () => {
  it('reports rolling speed while deltas arrive and expires after the window', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);

    expect(tracker.recordDelta('1234').now).toBeNull();
    now = 1_500;
    expect(tracker.recordDelta('5678').now).toBe(4);
    now = 3_501;
    expect(tracker.snapshot().now).toBeNull();
  });

  it('uses authoritative output tokens and includes turn-end tail time', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.recordDelta('first');
    now = 1_500;
    tracker.recordDelta('last');
    now = 2_000;

    expect(tracker.finish(20)).toEqual({ now: null, average: 20 });
  });

  it('ignores thinking-like input when only assistant deltas are recorded', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.recordDelta('assistant');
    now = 2_000;

    expect(tracker.snapshot().now).toBe(2.25);
  });

  it('does not start timing for empty output or complete without output', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);

    expect(tracker.recordDelta('').now).toBeNull();
    now = 2_000;
    expect(tracker.finish(20)).toEqual({ now: null, average: null });
  });

  it('does not produce a rate for a single delta in the same millisecond', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.recordDelta('1234');

    expect(tracker.finish(4)).toEqual({ now: null, average: null });
  });

  it('ignores invalid authoritative token counts', () => {
    let now = 1_000;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.recordDelta('1234');
    now = 2_000;

    expect(tracker.finish(Number.NaN)).toEqual({ now: null, average: null });
  });
});
