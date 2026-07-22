// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * upgrades.ts — the between-floor draft.
 *
 * After every floor each player picks one of three upgrades and it applies to
 * their OWN hero. The pool is deliberately small and legible: every card changes
 * a number you can feel in the next room. Options are drawn deterministically
 * from (seed, floor, seat) so a peer never has to send its three cards — only
 * which one it took (see net-game.ts `pick`).
 *
 * `apply` mutates a plain HeroStats bag rather than the live Hero, so the same
 * function tunes an AI hero in the balance sim and a human hero in the game with
 * no branching.
 */

import { makeRng, type Rng } from '@ben-gy/game-engine/rng';

/** The tunable half of a hero — everything the draft moves. */
export interface HeroStats {
  maxHp: number;
  /** Damage per projectile. */
  dmg: number;
  /** Shots per second. */
  fireRate: number;
  /** Projectile speed, world units/sec. */
  projSpeed: number;
  /** Projectiles per volley (multishot). */
  shots: number;
  /** Extra monsters a projectile passes through before dying. */
  pierce: number;
  /** Move speed, world units/sec. */
  moveSpeed: number;
  /** Dash cooldown, seconds. */
  dashCd: number;
  /** Chance a hit deals triple damage. */
  crit: number;
  /** HP healed per monster killed. */
  lifesteal: number;
}

export function baseStats(): HeroStats {
  return {
    maxHp: 6,
    dmg: 10,
    fireRate: 3,
    projSpeed: 340,
    shots: 1,
    pierce: 0,
    moveSpeed: 150,
    dashCd: 2.4,
    crit: 0,
    lifesteal: 0,
  };
}

export interface Upgrade {
  id: string;
  name: string;
  desc: string;
  /** Rarity weight — commons show up more often. */
  weight: number;
  apply: (s: HeroStats) => void;
}

/**
 * The pool. Each card is a clear, felt change. `apply` is pure over the stats
 * bag. Nothing here reads randomness — the roll is entirely in `draftFor`.
 */
export const UPGRADES: Upgrade[] = [
  { id: 'dmg', name: 'Sharper Edge', desc: '+40% projectile damage', weight: 10, apply: (s) => (s.dmg *= 1.4) },
  { id: 'rate', name: 'Quick Hands', desc: '+35% fire rate', weight: 10, apply: (s) => (s.fireRate *= 1.35) },
  { id: 'hp', name: 'Iron Heart', desc: '+2 max health, fully heal', weight: 9, apply: (s) => (s.maxHp += 2) },
  { id: 'speed', name: 'Fleet Feet', desc: '+18% move speed', weight: 8, apply: (s) => (s.moveSpeed *= 1.18) },
  { id: 'multishot', name: 'Split Bolt', desc: '+1 projectile', weight: 6, apply: (s) => (s.shots += 1) },
  { id: 'pierce', name: 'Pierce', desc: 'Shots pass through +1 monster', weight: 6, apply: (s) => (s.pierce += 1) },
  { id: 'projspeed', name: 'Swift Bolts', desc: '+30% projectile speed', weight: 7, apply: (s) => (s.projSpeed *= 1.3) },
  { id: 'dash', name: 'Light Step', desc: '-25% dash cooldown', weight: 7, apply: (s) => (s.dashCd = Math.max(0.7, s.dashCd * 0.75)) },
  { id: 'crit', name: 'Keen Eye', desc: '+15% chance to triple a hit', weight: 6, apply: (s) => (s.crit = Math.min(0.75, s.crit + 0.15)) },
  { id: 'lifesteal', name: 'Gloam Feast', desc: '+18% chance to heal 1 on a kill', weight: 5, apply: (s) => (s.lifesteal = Math.min(1, s.lifesteal + 0.18)) },
];

const BY_ID: Record<string, Upgrade> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

/** Resolve an upgrade id off the wire; unknown ids are ignored, never fatal. */
export function upgradeOf(id: unknown): Upgrade | null {
  return typeof id === 'string' && Object.hasOwn(BY_ID, id) ? BY_ID[id] : null;
}

/** Weighted pick without replacement, so a draft never shows the same card twice. */
function weightedPick(rng: Rng, pool: Upgrade[]): Upgrade {
  const total = pool.reduce((a, u) => a + u.weight, 0);
  let r = rng() * total;
  for (const u of pool) {
    r -= u.weight;
    if (r <= 0) return u;
  }
  return pool[pool.length - 1];
}

/**
 * The three cards seat `seat` is offered after clearing `floor`. Deterministic in
 * (seed, floor, seat) so every peer can compute any seat's draft without a
 * message — the choice is the only thing that travels.
 */
export function draftFor(seed: number, floor: number, seat: number, count = 3): Upgrade[] {
  const rng = makeRng((seed ^ 0x9e3779b9) + floor * 733 + seat * 101);
  const pool = UPGRADES.slice();
  const out: Upgrade[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const u = weightedPick(rng, pool);
    out.push(u);
    pool.splice(pool.indexOf(u), 1);
  }
  return out;
}
