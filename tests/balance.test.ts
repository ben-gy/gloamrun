/**
 * balance.test.ts — is the difficulty curve actually a curve?
 *
 * Gloamrun is co-op, so it has no seat-fairness or snowball problem — the risk it
 * DOES have is the one the idea named: the difficulty ramp. Two ways it dies, and
 * both are invisible to unit tests and to the few minutes you spend playing it:
 *
 *   1. A cliff — everyone wipes on floor 1, so there is no game.
 *   2. An immortal party — a geared four-gun party out-DPSes the swarm forever
 *      and the run never ends. This one is real and specific: hero upgrades
 *      compound multiplicatively, so a purely polynomial monster ramp is
 *      out-scaled and the sim runs to the floor cap. The fix (a geometric HP term
 *      past floor 5) was found HERE, by measuring — the baseline had this disease
 *      and no amount of playing four flawless floors would have surfaced it.
 *
 * The AI hero (bot.ts) is not a perfect player — a real player goes a floor or
 * two deeper — but it is a CONSISTENT one, and the whole point is the SHAPE of
 * the curve, not the absolute floor. Every draw is seeded, so these numbers are
 * deterministic: a bound that moves, moved for a reason.
 *
 * Runtime is ~30-40s. That is the price of the only test that can see whether the
 * game is still a game on floor 10.
 */

import { describe, expect, it } from 'vitest';
import { curve, playRun } from './helpers/sim';
import { MODES } from '../src/modes';
import { withTuning } from '../src/tuning';

const N = 70;

// One curve per (mode, party), reused across questions. Sim time is the budget.
const delve1 = curve(N, { mode: MODES.delve, party: 1, maxN: 16 });
const delve2 = curve(N, { mode: MODES.delve, party: 2, maxN: 16 });
const delve4 = curve(N, { mode: MODES.delve, party: 4, maxN: 16 });
const ons4 = curve(N, { mode: MODES.onslaught, party: 4, maxN: 16 });
const gaunt4 = curve(N, { mode: MODES.gauntlet, party: 4, maxN: 16 });

describe('the run is not a floor-1 cliff', () => {
  for (const [name, c] of [
    ['Delve solo', delve1],
    ['Delve duo', delve2],
    ['Delve four', delve4],
  ] as const) {
    it(`${name}: almost everyone clears the first floor`, () => {
      // Measured P(reach floor 2): 1.00 across the board. A game that wipes you on
      // floor 1 is not a game.
      expect(c.reach[2]).toBeGreaterThan(0.9);
    });
  }

  it('a solo delver gets a real run, not an instant death', () => {
    // Measured solo median floor 3 for the (deliberately mediocre) bot; a human
    // goes deeper. The floor it must clear reliably is that there IS a run.
    expect(delve1.medianFloor).toBeGreaterThanOrEqual(2);
    expect(delve1.meanFloor).toBeGreaterThan(2.5);
  });
});

describe('the ramp resolves — no immortal party, every run ends', () => {
  for (const [name, c] of [
    ['Delve four', delve4],
    ['Onslaught four', ons4],
    ['Gauntlet four', gaunt4],
  ] as const) {
    it(`${name}: the swarm eventually overwhelms even four guns`, () => {
      // Measured P(reach floor 12): Delve 0.03, Onslaught 0.00, Gauntlet 0.00.
      // The disease this catches is a flat tail that never drops — a party that
      // has out-scaled the dungeon and cannot die.
      expect(c.reach[12], 'four guns should not reach floor 12 often').toBeLessThan(0.2);
    });

    it(`${name}: runs terminate rather than running to the cap`, () => {
      // Measured timeout (hit the floor/step cap while still alive): 1-4%. The
      // immortal-party bug was ~40% before the geometric ramp term.
      expect(c.timeoutRate, 'a run that never ends is the failure this guards').toBeLessThan(0.1);
    });
  }

  it('the ramp is monotone — depth keeps getting harder', () => {
    // P(reach floor N) must never rise as N grows. A rise means a floor was
    // EASIER than a shallower one, which is a generation bug.
    for (const c of [delve1, delve2, delve4, ons4, gaunt4]) {
      for (let f = 3; f <= 16; f++) expect(c.reach[f]).toBeLessThanOrEqual(c.reach[f - 1] + 1e-9);
    }
  });
});

describe('co-op actually helps — but does not trivialise', () => {
  it('a bigger party gets deeper', () => {
    // Measured mean floor: solo 3.5, duo 4.3, four 6.8. More friends, more depth
    // — that is the whole promise of delving together.
    expect(delve2.meanFloor).toBeGreaterThan(delve1.meanFloor);
    expect(delve4.meanFloor).toBeGreaterThan(delve2.meanFloor);
  });

  it('the revive loop is a real part of co-op, and solo cannot use it', () => {
    // Measured revives per run: solo 0 (nobody to pick you up), duo ~24, four ~67.
    // If co-op parties never revived, the mechanic would be dead weight.
    expect(delve1.meanRevives).toBe(0);
    expect(delve2.meanRevives).toBeGreaterThan(1);
    expect(delve4.meanRevives).toBeGreaterThan(delve2.meanRevives);
  });

  it('four guns do not make the dungeon a stroll', () => {
    // Even a full party is mostly gone by floor 8. Deep runs are the aspiration,
    // not the norm.
    expect(delve4.reach[8]).toBeLessThan(0.55);
  });
});

describe('the modes are genuinely different games', () => {
  it('Onslaught is a crowd, Gauntlet is a duel', () => {
    // Measured kills/run at party 4: Onslaught ~500, Gauntlet ~110. Onslaught's
    // whole identity is volume; Gauntlet's is a few brutal elites. If these
    // converge, two of the three modes are the same game.
    expect(ons4.meanKills).toBeGreaterThan(gaunt4.meanKills * 2);
  });

  it('the modes carry different room sizes and swarm caps', () => {
    // A mode has to change how it PLAYS, not just a number. These are the
    // structural levers that do it.
    expect(MODES.onslaught.roomScale).toBeGreaterThan(MODES.gauntlet.roomScale);
    expect(MODES.onslaught.maxAlive).toBeGreaterThan(MODES.delve.maxAlive * 2);
    expect(MODES.gauntlet.eliteBase).toBeGreaterThan(MODES.delve.eliteBase * 2);
  });
});

describe('the constant the termination rests on', () => {
  it('RAMP_EXP is load-bearing: flatten it and the party becomes immortal', () => {
    // Pin it, per principle #18. The geometric HP term is the ONLY thing keeping
    // a great party's multiplicative upgrades from out-scaling the swarm forever.
    // Flatten it to 1.0 and the deep tail returns: more four-gun runs reach the
    // bottom of the sim and more of them never end. This test exists so that
    // "let's make the deep floors less spongey" cannot quietly re-arm the trap.
    const loose = withTuning({ RAMP_EXP: 1.0 }, () =>
      curve(40, { mode: MODES.delve, party: 4, maxN: 16 }),
    );
    const shipped = curve(40, { mode: MODES.delve, party: 4, maxN: 16 });
    expect(loose.reach[12]).toBeGreaterThan(shipped.reach[12]);
    expect(loose.timeoutRate + loose.meanFloor).toBeGreaterThan(shipped.timeoutRate + shipped.meanFloor);
  });

  it('the sim step is fine enough not to tunnel a fast dasher through a monster', () => {
    // A dashing hero covers ~520 units/sec; at 60Hz that is 8.7 units a step,
    // inside a crawler's 12-unit radius, so contact is never skipped. Drop the
    // rate and the sim stops seeing the collisions the whole game is about, so
    // every number above would be measuring a different game.
    const fast = playRun({ seed: 42, mode: MODES.delve, party: 2, hz: 60 });
    const slow = playRun({ seed: 42, mode: MODES.delve, party: 2, hz: 20 });
    // The coarse sim lets heroes phase past danger, so they survive longer.
    expect(slow.reached).toBeGreaterThanOrEqual(fast.reached);
  });
});
