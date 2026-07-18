/**
 * countdown.ts — 3, 2, 1, GO before a run begins.
 *
 * A run never begins the instant the floor appears. Without this, whoever happens
 * to be looking gets a free head start and the board reads as a jump-cut. The
 * AUDIO carries it — players watch the room, not the overlay — so each beat fires
 * a sound whether or not anything is rendering.
 *
 * Each peer counts locally from the host's round start; that leaves peers in step
 * to within one network hop, which is plenty (the run has no fixed clock anyway).
 *
 * setInterval, never rAF alone: a backgrounded tab pauses rAF, and a countdown
 * that freezes when you glance at another tab is worse than none.
 */

export interface CountdownOpts {
  from?: number;
  beatMs?: number;
  /** Fires per beat. `n` is 3,2,1 then 0 for GO. */
  onBeat: (n: number) => void;
  onDone: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Countdown {
  cancel(): void;
  done(): boolean;
}

export function startCountdown(opts: CountdownOpts): Countdown {
  const from = opts.from ?? 3;
  const beatMs = opts.beatMs ?? 700;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let n = from;
  let finished = false;
  let handle: unknown = null;

  opts.onBeat(n);

  const stop = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  handle = setTimer(() => {
    if (finished) return;
    n--;
    opts.onBeat(n);
    if (n <= 0) {
      finished = true;
      stop();
      opts.onDone();
    }
  }, beatMs);

  return {
    cancel() {
      if (finished) return;
      finished = true;
      stop();
    },
    done: () => finished,
  };
}
