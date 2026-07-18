/**
 * game.test.ts — the pure simulation. Movement, the phase machine, downs and
 * revives, the draft, and the wipe that ends a run.
 */

import { describe, expect, it } from 'vitest';
import { Game, HERO_R, type Monster, type Seat } from '../src/game';
import { MODES } from '../src/modes';
import { UPGRADES } from '../src/upgrades';

const seats = (n: number): Seat[] => Array.from({ length: n }, (_, i) => ({ name: `H${i}`, bot: false }));

function mk(party = 1, mode = MODES.delve): Game {
  return new Game({ seed: 7, mode, seats: seats(party) });
}

function monster(over: { x: number; y: number }): Monster {
  return {
    id: 99,
    kind: 'crawler',
    elite: false,
    x: over.x,
    y: over.y,
    vx: 0,
    vy: 0,
    hp: 40,
    maxHp: 40,
    r: 12,
    speed: 0,
    touch: 1,
    fireCd: 99,
    hitCd: 0,
    rx: over.x,
    ry: over.y,
  };
}

describe('construction', () => {
  it('seats one hero per player, at full health', () => {
    const g = mk(3);
    expect(g.heroes).toHaveLength(3);
    for (const h of g.heroes) {
      expect(h.hp).toBe(h.stats.maxHp);
      expect(h.down).toBe(false);
      expect(h.left).toBe(false);
    }
  });

  it('rings the party around the centre so nobody spawns on a wall or a teammate', () => {
    const g = mk(4);
    const radii = g.heroes.map((h) => Math.hypot(h.x, h.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
    // No two heroes share a position.
    for (let i = 0; i < g.heroes.length; i++)
      for (let j = i + 1; j < g.heroes.length; j++)
        expect(Math.hypot(g.heroes[i].x - g.heroes[j].x, g.heroes[i].y - g.heroes[j].y)).toBeGreaterThan(1);
  });

  it('starts on floor 1, fighting', () => {
    const g = mk();
    expect(g.floor).toBe(1);
    expect(g.phase).toBe('fighting');
    expect(g.over).toBe(false);
  });
});

describe('movement', () => {
  it('normalises intent and moves the hero', () => {
    const g = mk();
    const h = g.heroes[0];
    const at = { x: h.x, y: h.y };
    g.setIntent(0, 3, 4, false); // length 5 -> unit
    expect(Math.hypot(h.ax, h.ay)).toBeCloseTo(1, 6);
    g.hostStep(0.1);
    expect(h.x !== at.x || h.y !== at.y).toBe(true);
  });

  it('keeps a hero inside the room', () => {
    const g = mk();
    const h = g.heroes[0];
    for (let i = 0; i < 300; i++) {
      g.setIntent(0, 1, 1, false);
      g.hostStep(1 / 60);
    }
    expect(h.x).toBeLessThanOrEqual(g.hw - HERO_R + 0.01);
    expect(h.y).toBeLessThanOrEqual(g.hh - HERO_R + 0.01);
  });
});

describe('taking damage, going down, being revived', () => {
  it('a monster in contact chips the hero and eventually downs it', () => {
    const g = mk();
    const h = g.heroes[0];
    g.monsters.push(monster({ x: h.x, y: h.y }));
    let steps = 0;
    while (!h.down && steps < 2000) {
      g.monsters[0].x = h.x; // stay glued on
      g.monsters[0].y = h.y;
      g.hostStep(1 / 60);
      steps++;
    }
    expect(h.down).toBe(true);
    expect(h.hp).toBe(0);
    expect(h.contrib.downs).toBe(1);
  });

  it('a downed hero with a teammate standing over them is revived', () => {
    const g = mk(2);
    const [a, b] = g.heroes;
    a.down = true;
    a.hp = 0;
    // Put the reviver right on top.
    b.x = a.x;
    b.y = a.y;
    for (let i = 0; i < 60 * 3; i++) g.hostStep(1 / 60);
    expect(a.down).toBe(false);
    expect(a.hp).toBeGreaterThan(0);
    expect(b.contrib.revives).toBe(1);
  });

  it('a downed hero with nobody near stays down (and does not tick toward revive)', () => {
    const g = mk(2);
    const [a, b] = g.heroes;
    a.down = true;
    a.hp = 0;
    b.x = 9999; // far away (clamped, but far enough)
    b.y = 9999;
    for (let i = 0; i < 60 * 3; i++) g.hostStep(1 / 60);
    expect(a.down).toBe(true);
  });

  it('i-frames stop a hero being multi-hit in one instant', () => {
    const g = mk();
    const h = g.heroes[0];
    const before = h.hp;
    g.monsters.push(monster({ x: h.x, y: h.y }));
    g.hostStep(1 / 60);
    g.hostStep(1 / 60); // still inside the i-frame window
    expect(before - h.hp).toBeLessThanOrEqual(1);
  });
});

describe('the wipe ends the run', () => {
  it('a solo hero going down ends the run with a reason', () => {
    const g = mk();
    g.heroes[0].down = true;
    g.hostStep(1 / 60);
    expect(g.over).toBe(true);
    expect(g.phase).toBe('over');
    expect(g.overReason.length).toBeGreaterThan(0);
  });

  it('the run is NOT over while one delver still stands', () => {
    const g = mk(2);
    g.heroes[0].down = true;
    g.hostStep(1 / 60);
    expect(g.over).toBe(false);
  });

  it('a peer leaving dissolves its hero and can trigger the wipe', () => {
    const g = mk(2);
    g.heroes[1].down = true;
    g.dissolve(0); // the last stander leaves
    expect(g.heroes[0].left).toBe(true);
    expect(g.over).toBe(true);
  });
});

describe('the draft', () => {
  it('applies a chosen upgrade to the picking hero only', () => {
    const g = mk(2);
    g.phase = 'draft';
    const up = UPGRADES.find((u) => u.id === 'dmg')!;
    const before = g.heroes[0].stats.dmg;
    g.pickUpgrade(0, 'dmg', up.apply);
    expect(g.heroes[0].stats.dmg).toBeGreaterThan(before);
    expect(g.heroes[1].stats.dmg).toBe(before); // untouched
  });

  it('is idempotent per seat — a second pick is ignored', () => {
    const g = mk();
    g.phase = 'draft';
    const up = UPGRADES.find((u) => u.id === 'dmg')!;
    g.pickUpgrade(0, 'dmg', up.apply);
    const after = g.heroes[0].stats.dmg;
    g.pickUpgrade(0, 'dmg', up.apply);
    expect(g.heroes[0].stats.dmg).toBe(after);
  });

  it('ignores a pick outside the draft phase', () => {
    const g = mk();
    const up = UPGRADES.find((u) => u.id === 'dmg')!;
    const before = g.heroes[0].stats.dmg;
    g.pickUpgrade(0, 'dmg', up.apply);
    expect(g.heroes[0].stats.dmg).toBe(before);
  });

  it('the Iron Heart card raises max HP and tops the bar up by the gain', () => {
    const g = mk();
    g.phase = 'draft';
    g.heroes[0].hp = 3;
    const up = UPGRADES.find((u) => u.id === 'hp')!;
    const beforeMax = g.heroes[0].stats.maxHp;
    g.pickUpgrade(0, 'hp', up.apply);
    expect(g.heroes[0].stats.maxHp).toBe(beforeMax + 2);
    expect(g.heroes[0].hp).toBe(5); // 3 + the 2-point gain
  });

  it('descend advances the floor and builds a fresh, harder queue', () => {
    const g = mk();
    g.phase = 'draft';
    const up = UPGRADES[0];
    g.pickUpgrade(0, up.id, up.apply);
    expect(g.allPicked()).toBe(true);
    g.descend();
    expect(g.floor).toBe(2);
    expect(g.phase).toBe('fighting');
    expect(g.reached).toBe(2);
  });
});

describe('queries', () => {
  it('livingSeats and aliveCount reflect downs and leaves', () => {
    const g = mk(3);
    expect(g.livingSeats()).toBe(3);
    expect(g.aliveCount()).toBe(3);
    g.heroes[0].down = true;
    expect(g.aliveCount()).toBe(2);
    g.dissolve(1);
    expect(g.livingSeats()).toBe(2);
  });

  it('partyHealth falls as heroes take damage', () => {
    const g = mk(2);
    expect(g.partyHealth()).toBeCloseTo(1, 6);
    g.heroes[0].hp = 0;
    g.heroes[0].down = true;
    expect(g.partyHealth()).toBeLessThan(0.6);
  });
});
