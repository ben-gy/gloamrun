// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * tuning.ts — a tiny override hook so the balance sim can prove which constants
 * are load-bearing (principle #18). In the game these are just their defaults;
 * in a test, `withTuning({ ... }, fn)` runs `fn` with the constant changed so the
 * sim can show what breaks when it moves.
 *
 * Only constants a test actually pins live here — everything else stays inline.
 */

export interface Tuning {
  /**
   * Geometric HP growth per floor past floor 5. This is what GUARANTEES a run
   * ends: hero upgrades compound multiplicatively, so without a monster term that
   * also grows geometrically, a great party's DPS outruns the swarm forever. Flat
   * it (1.0) and the deep tail explodes — balance.test.ts asserts exactly that.
   */
  RAMP_EXP: number;
}

const DEFAULT: Tuning = { RAMP_EXP: 1.062 };

let current: Tuning = { ...DEFAULT };

export function tuning(): Tuning {
  return current;
}

export function withTuning<T>(patch: Partial<Tuning>, fn: () => T): T {
  const prev = current;
  current = { ...current, ...patch };
  try {
    return fn();
  } finally {
    current = prev;
  }
}
