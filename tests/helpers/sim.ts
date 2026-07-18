/**
 * helpers/sim.ts — headless run driver for the difficulty-curve sim.
 *
 * A co-op game's "balance" is its difficulty curve (principle #18, and the idea
 * itself said "tune it with a sim, don't eyeball it"). So this plays full runs
 * with AI heroes (bot.ts) through the real Session — the exact host code path a
 * live game runs — and reports how deep the party got. Deterministic in the seed:
 * seeded rng everywhere, synthetic fixed-step clock, no wall time.
 */

import { Game, type Seat } from '../../src/game';
import { createSession } from '../../src/net-game';
import type { Mode } from '../../src/modes';
import type { SessionSeat } from '../../src/net-game';

export interface RunResult {
  reached: number;
  steps: number;
  kills: number;
  downs: number;
  revives: number;
  timedOut: boolean;
}

export interface RunOpts {
  seed: number;
  mode: Mode;
  party: number;
  hz?: number;
  /** Safety cap so a stalemate cannot hang the suite. */
  maxFloor?: number;
  maxSteps?: number;
}

export function playRun(opts: RunOpts): RunResult {
  const hz = opts.hz ?? 60;
  const maxFloor = opts.maxFloor ?? 40;
  const maxSteps = opts.maxSteps ?? 60 * 60 * 45; // ~45 sim-minutes, plenty to end
  const seats: Seat[] = Array.from({ length: opts.party }, (_, i) => ({ name: `B${i}`, bot: true }));
  const sseats: SessionSeat[] = Array.from({ length: opts.party }, () => ({ bot: true }));
  const g = new Game({ seed: opts.seed, mode: opts.mode, seats });
  const s = createSession({
    game: g,
    me: -1, // pure headless: no local player, all bots
    seats: sseats,
    seed: opts.seed,
    onEnd: () => {},
  });

  const stepMs = 1000 / hz;
  let t = 0;
  let steps = 0;
  s.pump(t);
  while (!g.over && steps < maxSteps && g.reached <= maxFloor) {
    t += stepMs;
    s.pump(t);
    steps++;
  }

  let downs = 0;
  let revives = 0;
  let kills = 0;
  for (const h of g.heroes) {
    downs += h.contrib.downs;
    revives += h.contrib.revives;
    kills += h.contrib.kills;
  }
  return { reached: g.reached, steps, kills, downs, revives, timedOut: !g.over };
}

export interface CurveResult {
  runs: number;
  /** P(reach floor N) for N = 1..maxN. */
  reach: number[];
  medianFloor: number;
  meanFloor: number;
  timeoutRate: number;
  meanKills: number;
  meanRevives: number;
}

export function curve(
  n: number,
  opts: { mode: Mode; party: number; hz?: number; maxN?: number },
): CurveResult {
  const maxN = opts.maxN ?? 20;
  const reachCount = new Array(maxN + 1).fill(0);
  const floors: number[] = [];
  let timeouts = 0;
  let kills = 0;
  let revives = 0;
  for (let i = 0; i < n; i++) {
    const r = playRun({ seed: 1000 + i * 7 + opts.party * 131, mode: opts.mode, party: opts.party, hz: opts.hz });
    floors.push(r.reached);
    for (let f = 1; f <= maxN; f++) if (r.reached >= f) reachCount[f]++;
    if (r.timedOut) timeouts++;
    kills += r.kills;
    revives += r.revives;
  }
  floors.sort((a, b) => a - b);
  return {
    runs: n,
    reach: reachCount.map((c) => c / n),
    medianFloor: floors[Math.floor(floors.length / 2)],
    meanFloor: floors.reduce((a, b) => a + b, 0) / n,
    timeoutRate: timeouts / n,
    meanKills: kills / n,
    meanRevives: revives / n,
  };
}

export function report(name: string, c: CurveResult): string {
  const r = c.reach.map((p, i) => (i > 0 && i % 2 === 0 ? `f${i}:${(p * 100).toFixed(0)}%` : null)).filter(Boolean);
  return `${name}: median floor ${c.medianFloor}, mean ${c.meanFloor.toFixed(1)}, timeouts ${(c.timeoutRate * 100).toFixed(0)}% | ${r.join(' ')}`;
}
