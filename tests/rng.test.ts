/**
 * rng.test.ts — the P2P-sync determinism invariant.
 *
 * Two peers seeded identically must produce byte-identical streams AND identical
 * dungeons. The second half is the one specific to this game: a promoted host
 * rebuilds the current floor's monster queue from the shared seed, so if two
 * peers disagreed about the queue, a takeover would spawn a different swarm than
 * everyone else is fighting.
 */

import { describe, expect, it } from 'vitest';
import { makeRng, hashSeed, randInt, shuffle, pick } from '@ben-gy/game-engine/rng';
import { Game, type Seat } from '../src/game';
import { MODES } from '../src/modes';

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    expect(Array.from({ length: 100 }, () => a())).toEqual(Array.from({ length: 100 }, () => b()));
  });

  it('produces an identical stream for the same string seed', () => {
    const a = makeRng('room-AB12');
    const b = makeRng('room-AB12');
    expect(Array.from({ length: 50 }, () => a())).toEqual(Array.from({ length: 50 }, () => b()));
  });

  it('diverges for different seeds', () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
  });

  it('stays within [0,1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed / helpers', () => {
  it('hashSeed is stable and unsigned 32-bit', () => {
    const h = hashSeed('hello');
    expect(h).toBe(hashSeed('hello'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('shuffle / randInt / pick agree across peers', () => {
    const deck = Array.from({ length: 40 }, (_, i) => i);
    expect(shuffle(makeRng('s'), deck)).toEqual(shuffle(makeRng('s'), deck));
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 50; i++) expect(randInt(a, 1, 6)).toBe(randInt(b, 1, 6));
    expect(pick(makeRng('x'), ['a', 'b', 'c'])).toBe(pick(makeRng('x'), ['a', 'b', 'c']));
  });
});

describe('the dungeon is deterministic in the seed', () => {
  const seats = (n: number): Seat[] => Array.from({ length: n }, (_, i) => ({ name: `H${i}`, bot: true }));

  it('two Games on the same seed build the SAME floor and spawn the SAME swarm', () => {
    const a = new Game({ seed: 555, mode: MODES.delve, seats: seats(2) });
    const b = new Game({ seed: 555, mode: MODES.delve, seats: seats(2) });
    // Same opening geometry.
    expect(a.heroes.map((h) => [h.x, h.y])).toEqual(b.heroes.map((h) => [h.x, h.y]));
    // Release monsters over a few seconds with identical (no) input.
    for (let i = 0; i < 120; i++) {
      a.hostStep(1 / 60);
      b.hostStep(1 / 60);
    }
    const shape = (g: Game) => g.monsters.map((m) => [m.id, m.kind, m.elite, Math.round(m.x), Math.round(m.y), m.maxHp]);
    expect(shape(a)).toEqual(shape(b));
    expect(a.monsters.length).toBeGreaterThan(0); // it was a real swarm, not an empty room
  });

  it('a rebuilt floor queue matches — the property a host takeover relies on', () => {
    // syncFloor rebuilds the current floor's queue from the seed. A promoted peer
    // must spawn the identical monsters the old host would have.
    const live = new Game({ seed: 1001, mode: MODES.gauntlet, seats: seats(3) });
    live.phase = 'draft';
    // Give everyone a pick so descend is legal, then go down two floors.
    for (const h of live.heroes) live.picks.set(h.i, 'dmg');
    live.descend(); // now floor 2
    const rebuilt = new Game({ seed: 1001, mode: MODES.gauntlet, seats: seats(3) });
    rebuilt.syncFloor(2, 0);
    for (let i = 0; i < 90; i++) {
      live.hostStep(1 / 60);
      rebuilt.hostStep(1 / 60);
    }
    const shape = (g: Game) => g.monsters.map((m) => [m.id, m.kind, Math.round(m.x), Math.round(m.y)]).sort();
    expect(shape(rebuilt)).toEqual(shape(live));
  });

  it('a different seed builds a different dungeon', () => {
    const a = new Game({ seed: 1, mode: MODES.delve, seats: seats(2) });
    const b = new Game({ seed: 2, mode: MODES.delve, seats: seats(2) });
    for (let i = 0; i < 120; i++) {
      a.hostStep(1 / 60);
      b.hostStep(1 / 60);
    }
    const shape = (g: Game) => g.monsters.map((m) => [m.kind, Math.round(m.x), Math.round(m.y)]);
    expect(shape(a)).not.toEqual(shape(b));
  });
});
