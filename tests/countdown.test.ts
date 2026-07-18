/**
 * countdown.test.ts — the 3-2-1-DELVE beat before a run.
 *
 * It runs off an injectable timer so it can be driven with fake time — the game
 * uses setInterval (never rAF alone), because a countdown that freezes when you
 * glance at another tab is worse than none.
 */

import { describe, expect, it, vi } from 'vitest';
import { startCountdown } from '../src/countdown';

function driver() {
  let fn: (() => void) | null = null;
  const setTimer = (f: () => void) => {
    fn = f;
    return 1;
  };
  const clearTimer = () => {
    fn = null;
  };
  return { setTimer, clearTimer, tick: () => fn?.(), cleared: () => fn === null };
}

describe('startCountdown', () => {
  it('fires the first beat immediately, then counts down to GO', () => {
    const d = driver();
    const beats: number[] = [];
    let done = false;
    startCountdown({ onBeat: (n) => beats.push(n), onDone: () => (done = true), setTimer: d.setTimer, clearTimer: d.clearTimer });
    expect(beats).toEqual([3]); // immediate
    d.tick();
    d.tick();
    d.tick();
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(done).toBe(true);
  });

  it('stops its timer once GO has fired', () => {
    const d = driver();
    startCountdown({ onBeat: () => {}, onDone: () => {}, setTimer: d.setTimer, clearTimer: d.clearTimer });
    d.tick();
    d.tick();
    d.tick();
    expect(d.cleared()).toBe(true);
  });

  it('cancel() stops it early and blocks onDone', () => {
    const d = driver();
    let done = false;
    const c = startCountdown({ onBeat: () => {}, onDone: () => (done = true), setTimer: d.setTimer, clearTimer: d.clearTimer });
    c.cancel();
    d.tick();
    expect(done).toBe(false);
    expect(c.done()).toBe(true);
  });

  it('cancel() is safe to call twice', () => {
    const d = driver();
    const c = startCountdown({ onBeat: () => {}, onDone: () => {}, setTimer: d.setTimer, clearTimer: d.clearTimer });
    c.cancel();
    expect(() => c.cancel()).not.toThrow();
  });

  it('works against real timers too', async () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    let done = false;
    startCountdown({ from: 3, beatMs: 10, onBeat: (n) => beats.push(n), onDone: () => (done = true) });
    await vi.advanceTimersByTimeAsync(40);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
