/**
 * upgrades.test.ts — the draft pool and its deterministic offer.
 *
 * The offer MUST be deterministic in (seed, floor, seat) — that is what lets a
 * peer render any player's three cards without a message travelling. If it
 * drifted, two peers would show different cards for the same seat.
 */

import { describe, expect, it } from 'vitest';
import { draftFor, upgradeOf, baseStats, UPGRADES } from '../src/upgrades';

describe('draftFor — the offer', () => {
  it('always offers three distinct cards', () => {
    for (let floor = 1; floor <= 20; floor++) {
      for (let seat = 0; seat < 4; seat++) {
        const opts = draftFor(1234, floor, seat);
        expect(opts).toHaveLength(3);
        expect(new Set(opts.map((u) => u.id)).size).toBe(3);
      }
    }
  });

  it('is deterministic in (seed, floor, seat)', () => {
    const a = draftFor(999, 5, 2).map((u) => u.id);
    const b = draftFor(999, 5, 2).map((u) => u.id);
    expect(a).toEqual(b);
  });

  it('gives different seats different offers (usually), so the draft is personal', () => {
    // Not a guarantee for every seed, but across a sweep the seats must not be
    // locked to identical cards.
    let differ = 0;
    for (let floor = 1; floor <= 20; floor++) {
      const s0 = draftFor(42, floor, 0).map((u) => u.id).join();
      const s1 = draftFor(42, floor, 1).map((u) => u.id).join();
      if (s0 !== s1) differ++;
    }
    expect(differ).toBeGreaterThan(10);
  });
});

describe('applying an upgrade', () => {
  it('every card changes a stat', () => {
    for (const u of UPGRADES) {
      const s = baseStats();
      const before = JSON.stringify(s);
      u.apply(s);
      expect(JSON.stringify(s), `${u.id} changed nothing`).not.toBe(before);
    }
  });

  it('multishot and pierce are integers that only grow', () => {
    const s = baseStats();
    UPGRADES.find((u) => u.id === 'multishot')!.apply(s);
    expect(s.shots).toBe(2);
    UPGRADES.find((u) => u.id === 'pierce')!.apply(s);
    expect(s.pierce).toBe(1);
  });

  it('caps the runaway stats so they cannot break the sim', () => {
    const s = baseStats();
    const dash = UPGRADES.find((u) => u.id === 'dash')!;
    for (let i = 0; i < 20; i++) dash.apply(s);
    expect(s.dashCd).toBeGreaterThanOrEqual(0.7); // floored
    const crit = UPGRADES.find((u) => u.id === 'crit')!;
    for (let i = 0; i < 20; i++) crit.apply(s);
    expect(s.crit).toBeLessThanOrEqual(0.75); // capped
  });
});

describe('upgradeOf — resolving an id off the wire', () => {
  it('resolves a real id', () => {
    expect(upgradeOf('dmg')?.id).toBe('dmg');
  });

  it('rejects junk and prototype keys rather than crashing', () => {
    expect(upgradeOf('nope')).toBeNull();
    expect(upgradeOf('constructor')).toBeNull();
    expect(upgradeOf('toString')).toBeNull();
    expect(upgradeOf(undefined)).toBeNull();
    expect(upgradeOf(42)).toBeNull();
  });
});
